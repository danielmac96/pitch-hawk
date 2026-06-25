"""GET /edge/{game_pk} — join live predictions with odds from ALL sources.

Multi-source: instead of one hard-coded book, this pulls every registered
source (`backend.ingestion.odds_sources`) at once — the stub book, Kalshi, and
whatever else gets registered — and computes edge per source for each market.

Each returned row keeps the original contract (`market`, `recommendation`,
`line`, `price`, `edge`, `confidence`, `predicted_value`) so existing
frontends keep working, and adds:
  * `sources`     — per-source breakdown (source, line/price/implied_prob, edge)
  * `best_source` — source that gave the best (most positive) edge

Rows are sorted by best edge desc, None last.

Granularity note: the four micro-markets are model-priced; only the stub book
quotes them today. Game-level markets that arrive from prediction markets
(e.g. Kalshi `game_moneyline`) are appended with `edge: null` until a matching
model exists — the plumbing is ready, the prediction isn't.
"""

from fastapi import APIRouter, HTTPException

from backend.db.client import get_client
from backend.ingestion.odds_sources import (
    OddsQuote,
    calc_edge,
    collect_quotes,
    group_by_market,
)
from backend.models.predictor import PitchPredictor

router = APIRouter(prefix="/edge", tags=["edge"])

_predictor = PitchPredictor()

# Markets this app currently has a model for. Anything else that shows up from a
# source is surfaced as an "external market" row (no edge yet).
_MODELED_MARKETS = {"pitch_speed_ou", "pitch_result", "ab_result", "ab_pitches_ou"}


def _load_live_state(game_pk: int) -> dict | None:
    rows = (
        get_client().table("live_state")
        .select("*").eq("game_pk", game_pk).limit(1).execute().data
    )
    return rows[0] if rows else None


def _context_from(ls: dict, game_pk: int) -> dict:
    return {
        "game_pk":        game_pk,
        "pitcher_id":     ls.get("pitcher_id"),
        "batter_id":      ls.get("batter_id"),
        "balls":          ls.get("balls"),
        "strikes":        ls.get("strikes"),
        "pitch_count_pa": ls.get("pitch_count_pa"),
        "inning":         ls.get("inning"),
        # away_team/home_team flow through to sources that key on teams (Kalshi).
        # live_state doesn't store them; sources resolve from the schedule.
    }


def _best(source_rows: list[dict]) -> dict | None:
    """Source row with the highest edge; None-edge rows rank last."""
    priced = [r for r in source_rows if r.get("edge") is not None]
    if not priced:
        return source_rows[0] if source_rows else None
    return max(priced, key=lambda r: r["edge"])


def _ou_row(pred: dict, predicted_value: float, quotes: list[OddsQuote]) -> dict:
    """Over/under market priced against every source that quotes it.

    Per source: pick the side the model favors *relative to that source's own
    line*, then edge = model confidence - that side's implied prob.
    """
    by_source: dict[str, list[OddsQuote]] = {}
    for q in quotes:
        by_source.setdefault(q["source"], []).append(q)

    source_rows: list[dict] = []
    for source, qs in by_source.items():
        line = next((q["line"] for q in qs if q.get("line") is not None), None)
        if line is None:
            continue
        side = "over" if predicted_value > line else "under"
        q = next((x for x in qs if x["outcome"] == side), None)
        if q is None or q.get("implied_prob") is None:
            continue
        source_rows.append({
            "source": source,
            "recommendation": side,
            "line": line,
            "price": q.get("price_american"),
            "implied_prob": q["implied_prob"],
            "edge": calc_edge(pred["confidence"], q["implied_prob"]),
        })

    base = {
        "market": pred["market"],
        "confidence": pred["confidence"],
        "predicted_value": predicted_value,
        "sources": source_rows,
    }
    best = _best(source_rows)
    if best is not None:
        base.update({
            "recommendation": best["recommendation"], "line": best["line"],
            "price": best["price"], "edge": best["edge"],
            "best_source": best["source"],
        })
    else:
        base.update({"recommendation": None, "line": None, "price": None,
                     "edge": None, "best_source": None})
    return base


def _argmax_row(pred: dict) -> dict:
    """Categorical market — model's top outcome. No source prices these today."""
    name, prob = max(pred["probs"].items(), key=lambda kv: kv[1])
    return {
        "market": pred["market"], "recommendation": name, "line": None,
        "price": None, "edge": None, "confidence": prob,
        "predicted_value": prob, "sources": [], "best_source": None,
    }


def _external_market_row(market: str, quotes: list[OddsQuote]) -> dict:
    """A market that arrived from a source but we don't model yet (e.g. Kalshi
    game_moneyline). Surface implied probs; edge stays null until a model exists.
    """
    source_rows = [{
        "source": q["source"], "outcome": q["outcome"],
        "implied_prob": q.get("implied_prob"), "price": q.get("price_american"),
        "line": q.get("line"), "edge": None,
    } for q in quotes]
    return {
        "market": market, "recommendation": None, "line": None, "price": None,
        "edge": None, "confidence": None, "predicted_value": None,
        "sources": source_rows, "best_source": None,
        "note": "external market — no model prediction yet; add a predictor to compute edge",
    }


@router.get("/{game_pk}")
async def get_edge(game_pk: int) -> list[dict]:
    ls = _load_live_state(game_pk)
    if not ls:
        raise HTTPException(404, detail=f"no live_state row for game_pk={game_pk}")
    ctx = _context_from(ls, game_pk)

    quotes = await collect_quotes(game_pk, ctx)
    by_market = group_by_market(quotes)

    p_speed = _predictor.predict_pitch_speed(ctx)
    speed_row = _ou_row(p_speed, p_speed["predicted_mph"],
                        by_market.get("pitch_speed_ou", []))

    p_pres = _predictor.predict_pitch_result(ctx)
    pres_row = _argmax_row(p_pres)

    p_abr = _predictor.predict_at_bat_result(ctx)
    abr_row = _argmax_row(p_abr)

    p_abp = _predictor.predict_at_bat_pitches(ctx)
    abp_row = _ou_row(p_abp, p_abp["predicted_count"],
                      by_market.get("ab_pitches_ou", []))

    rows = [speed_row, pres_row, abr_row, abp_row]

    # Append source-only markets we don't model yet (prediction-market game
    # lines, props, …). Stable order for deterministic output.
    for market in sorted(by_market):
        if market in _MODELED_MARKETS:
            continue
        rows.append(_external_market_row(market, by_market[market]))

    # Sort by best edge desc; None last.
    rows.sort(key=lambda r: (r["edge"] is None, -(r["edge"] or 0.0)))
    return rows
