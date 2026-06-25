"""Kalshi prediction-market adapter (game-level MLB moneyline).

Kalshi exposes public, **no-auth** market data under /trade-api/v2. For MLB the
relevant series is `KXMLBGAME` (per-game moneyline). Prices are quoted in cents
0..100, which ARE implied probabilities (¢55 -> 0.55) — no American-odds
conversion required, which is cleaner than the sportsbook path.

GRANULARITY — read this before wiring edge
------------------------------------------
Kalshi (like every public prediction market) only prices GAME-LEVEL outcomes.
It does **not** offer the per-pitch / per-at-bat micro-markets this app
predicts (`pitch_speed_ou`, `pitch_result`, `ab_result`, `ab_pitches_ou`). So
this adapter contributes a *new* market class — `game_moneyline` — rather than
an alternate price for the existing four. To actually compute edge against it
you need a game-winner model; until then `/edge` surfaces Kalshi's implied
probability with `edge: null` (the plumbing is ready, the prediction isn't).

Linking game_pk -> Kalshi event
-------------------------------
Kalshi keys markets by team + date, not by MLB `game_pk`. We resolve the event
by matching team names from the live schedule against Kalshi event titles. This
is best-effort string matching; ambiguous/no match -> [] (no quote, no crash).

Everything degrades gracefully: any network / parse / match failure returns []
so a dead source never breaks the edge route.
"""

from __future__ import annotations

import os

import httpx

from backend.ingestion.odds_sources import OddsQuote, make_quote

KALSHI_BASE = os.environ.get("KALSHI_BASE", "https://api.elections.kalshi.com/trade-api/v2")
KALSHI_MLB_SERIES = os.environ.get("KALSHI_MLB_SERIES", "KXMLBGAME")

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=KALSHI_BASE,
            timeout=8.0,
            headers={"Accept": "application/json"},
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=10),
        )
    return _client


# --- team-name matching ----------------------------------------------------
# MLB Stats API gives names like "Los Angeles Dodgers"; Kalshi titles tend to
# use the nickname ("Dodgers") or city. We match on the lowercased nickname
# (last token of the team name) appearing in the Kalshi market/event title.
def _nickname(team_name: str | None) -> str | None:
    if not team_name:
        return None
    return team_name.strip().split()[-1].lower() or None


async def _resolve_teams(game_pk: int, context: dict) -> tuple[str | None, str | None]:
    """(away_team, home_team) from context if present, else the live schedule."""
    away = context.get("away_team")
    home = context.get("home_team")
    if away and home:
        return away, home
    try:
        from backend.ingestion.mlb_api import get_live_games

        for g in await get_live_games():
            if g.get("game_pk") == game_pk:
                return g.get("away_team"), g.get("home_team")
    except Exception as exc:  # noqa: BLE001
        print(f"[kalshi] team resolve failed game={game_pk}: {exc}")
    return None, None


async def _fetch_open_markets() -> list[dict]:
    """Open KXMLBGAME markets (each market = one team's win contract).

    Public endpoint, no auth. Returns [] on any failure.
    """
    resp = await _get_client().get(
        "/markets",
        params={"series_ticker": KALSHI_MLB_SERIES, "status": "open", "limit": 1000},
    )
    resp.raise_for_status()
    return resp.json().get("markets", []) or []


def _mid_prob(market: dict) -> float | None:
    """Implied probability for a market's YES side, in [0,1].

    Prefer the bid/ask midpoint; fall back to last_price. Kalshi quotes cents.
    """
    bid = market.get("yes_bid")
    ask = market.get("yes_ask")
    if bid is not None and ask is not None and (bid or ask):
        return (bid + ask) / 200.0
    last = market.get("last_price")
    return last / 100.0 if last else None


def _market_team(market: dict) -> str | None:
    """The team a YES contract pays out on (e.g. 'Dodgers')."""
    title = (market.get("yes_sub_title") or market.get("title")
             or market.get("subtitle") or "")
    return title.strip().lower() or None


async def get_quotes(game_pk: int, context: dict) -> list[OddsQuote]:
    """Normalized `game_moneyline` quotes for this game from Kalshi.

    Returns up to two quotes (home/away). Empty list if Kalshi is
    unreachable, the game can't be matched, or prices are missing.
    """
    away_team, home_team = await _resolve_teams(game_pk, context)
    away_nick, home_nick = _nickname(away_team), _nickname(home_team)
    if not away_nick or not home_nick:
        return []

    markets = await _fetch_open_markets()

    quotes: list[OddsQuote] = []
    for m in markets:
        team_blob = _market_team(m)
        ticker = (m.get("ticker") or "")
        if not team_blob:
            continue
        # Match on team nickname. NOTE: team names are not unique across a slate
        # (two games can both involve, say, a "Sox"); to be slate-safe, tighten
        # this with the game date once the ticker date encoding is mapped — the
        # KXMLBGAME ticker embeds the matchup + date. (TODO: parse ticker date.)
        if away_nick in team_blob:
            outcome = "away"
        elif home_nick in team_blob:
            outcome = "home"
        else:
            continue

        prob = _mid_prob(m)
        if prob is None:
            continue
        quotes.append(make_quote(
            source="kalshi",
            market="game_moneyline",
            outcome=outcome,
            game_pk=game_pk,
            implied_prob=round(prob, 4),
            meta={
                "ticker": ticker,
                "team": team_blob,
                "yes_bid": m.get("yes_bid"),
                "yes_ask": m.get("yes_ask"),
                "volume": m.get("volume"),
                "close_time": m.get("close_time"),
            },
        ))

    # De-dup: if both sides matched the same team blob (bad match), drop.
    seen: set[str] = set()
    deduped: list[OddsQuote] = []
    for q in quotes:
        if q["outcome"] in seen:
            continue
        seen.add(q["outcome"])
        deduped.append(q)
    return deduped


async def aclose() -> None:
    """Close the shared client (call on app shutdown if desired)."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
