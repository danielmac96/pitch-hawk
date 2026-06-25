"""Multi-source odds registry + normalized quote shape.

This is the seam that lets `/edge` price a market against *several* sources at
once (the stub book, Kalshi, Polymarket, The Odds API, …) instead of a single
hard-coded book. Every source returns the same normalized `OddsQuote`, so the
edge route never has to care where a price came from.

Normalized quote
----------------
A quote is one *outcome* of one *market* from one *source*, e.g. the "over"
side of `ab_pitches_ou`, or the "home" side of `game_moneyline`. Prediction
markets (Kalshi/Polymarket) quote probabilities directly (0..1); sportsbooks
quote American odds. We always carry BOTH — `implied_prob` is the canonical
field the edge math uses, `price_american` is kept for display / sportsbook
parity. Helpers below convert between them so a source only has to supply
whichever it natively has.

Adding a source
---------------
Write an async `get_quotes(game_pk, context) -> list[OddsQuote]` (see
`kalshi.py`) and register it in `_SOURCES`. Each source is called inside a
guard, so one dead/slow source returns nothing and never breaks the route.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable, TypedDict


class OddsQuote(TypedDict, total=False):
    source: str             # "kalshi", "draftkings_stub", …
    market: str             # "ab_pitches_ou", "game_moneyline", …
    outcome: str            # "over"/"under", "home"/"away", "strikeout", …
    line: float | None      # O/U line; None for binary/categorical markets
    price_american: int | None
    implied_prob: float | None
    game_pk: int
    meta: dict              # raw source payload bits (ticker, ts, volume, …)


# ---------------------------------------------------------------------------
# odds <-> probability helpers
# ---------------------------------------------------------------------------
def american_to_prob(american_odds: int | None) -> float | None:
    """American odds -> raw implied probability (includes the vig)."""
    if american_odds is None:
        return None
    if american_odds >= 0:
        return 100.0 / (american_odds + 100.0)
    return abs(american_odds) / (abs(american_odds) + 100.0)


def prob_to_american(prob: float | None) -> int | None:
    """Probability -> nearest American odds (for display next to book prices)."""
    if prob is None or prob <= 0.0 or prob >= 1.0:
        return None
    if prob >= 0.5:
        return -round(prob / (1.0 - prob) * 100.0)
    return round((1.0 - prob) / prob * 100.0)


def make_quote(
    *,
    source: str,
    market: str,
    outcome: str,
    game_pk: int,
    line: float | None = None,
    price_american: int | None = None,
    implied_prob: float | None = None,
    meta: dict | None = None,
) -> OddsQuote:
    """Build a quote, back-filling whichever of prob/American odds is missing."""
    if implied_prob is None and price_american is not None:
        implied_prob = american_to_prob(price_american)
    if price_american is None and implied_prob is not None:
        price_american = prob_to_american(implied_prob)
    return OddsQuote(
        source=source, market=market, outcome=outcome, game_pk=game_pk,
        line=line, price_american=price_american, implied_prob=implied_prob,
        meta=meta or {},
    )


def calc_edge(predicted_prob: float | None, implied_prob: float | None) -> float | None:
    """Positive = value: model thinks the outcome is likelier than the market.

    Note: `implied_prob` from a single sportsbook side carries the vig, so a
    small positive edge can be illusory. For a fairer baseline, de-vig across
    the two sides first (TODO: add two-sided de-vig once a source quotes both
    sides of the same market with the same line).
    """
    if predicted_prob is None or implied_prob is None:
        return None
    return round(predicted_prob - implied_prob, 4)


# ---------------------------------------------------------------------------
# source registry
# ---------------------------------------------------------------------------
# Each source is an async callable (game_pk, context) -> list[OddsQuote].
# Imports are lazy/inside the functions to avoid import cycles and to keep a
# missing optional dependency from breaking module import.
SourceFn = Callable[[int, dict], Awaitable[list[OddsQuote]]]


async def _stub_source(game_pk: int, context: dict) -> list[OddsQuote]:
    """Existing placeholder book, re-expressed as normalized quotes.

    Emits two quotes (over/under) per O/U market so the aggregator stays
    outcome-agnostic. Categorical/None-priced stub rows are skipped.
    """
    from backend.ingestion.odds_stub import get_odds

    quotes: list[OddsQuote] = []
    for row in get_odds(game_pk):
        line = row.get("line")
        for outcome, price in (("over", row.get("over_price")),
                               ("under", row.get("under_price"))):
            if price is None:
                continue
            quotes.append(make_quote(
                source=row.get("source", "draftkings_stub"),
                market=row["market"], outcome=outcome, game_pk=game_pk,
                line=line, price_american=price,
            ))
    return quotes


async def _kalshi_source(game_pk: int, context: dict) -> list[OddsQuote]:
    from backend.ingestion import kalshi

    return await kalshi.get_quotes(game_pk, context)


# Order is informational only; the aggregator merges all of them.
_SOURCES: dict[str, SourceFn] = {
    "draftkings_stub": _stub_source,
    "kalshi": _kalshi_source,
    # "polymarket": _polymarket_source,   # TODO: same shape as kalshi.py
    # "the_odds_api": _the_odds_api_source,  # TODO: game lines + player props
}


async def collect_quotes(game_pk: int, context: dict) -> list[OddsQuote]:
    """Fan out to every registered source, guarded, and flatten the results.

    A source that raises or times out contributes nothing — the rest still
    return. This is what makes "single or various sources at once" a config
    choice (which sources are enabled) rather than a code change in the route.
    """
    async def _guard(name: str, fn: SourceFn) -> list[OddsQuote]:
        try:
            return await fn(game_pk, context)
        except Exception as exc:  # noqa: BLE001 - never let one source break the route
            print(f"[odds_sources] source={name} failed: {exc}")
            return []

    results = await asyncio.gather(
        *[_guard(name, fn) for name, fn in _SOURCES.items()]
    )
    return [q for source_quotes in results for q in source_quotes]


def group_by_market(quotes: list[OddsQuote]) -> dict[str, list[OddsQuote]]:
    out: dict[str, list[OddsQuote]] = {}
    for q in quotes:
        out.setdefault(q["market"], []).append(q)
    return out
