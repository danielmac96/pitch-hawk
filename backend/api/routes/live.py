"""Bundled live dashboard endpoints.

GET /live              — all active games with predictions + edge, sorted by top_edge desc
GET /live/{game_pk}    — single game (404 if no live_state row)
POST /admin/reload-stats — force a stats-cache reload (returns updated counts)
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from backend.db.client import get_client
from backend.ingestion.odds_stub import calculate_edge, get_odds
from backend.models._persist import current_pa_position, insert_predictions
from backend.models.predictor import PitchPredictor
from backend.models.stats_cache import get_cache

router = APIRouter(tags=["live"])

_predictor = PitchPredictor()


def _context_from(ls: dict) -> dict:
    return {
        "game_pk":        ls.get("game_pk"),
        "pitcher_id":     ls.get("pitcher_id"),
        "batter_id":      ls.get("batter_id"),
        "balls":          ls.get("balls"),
        "strikes":        ls.get("strikes"),
        "pitch_count_pa": ls.get("pitch_count_pa"),
        "inning":         ls.get("inning"),
    }


def _situation(ls: dict) -> dict:
    balls = ls.get("balls") or 0
    strikes = ls.get("strikes") or 0
    return {
        "inning": ls.get("inning"),
        "half": "▲" if ls.get("top_inning") else "▼",
        "count": f"{balls}-{strikes}",
        "outs": ls.get("outs"),
        "pitcher_id": ls.get("pitcher_id"),
        "batter_id": ls.get("batter_id"),
        "pitch_count_pa": ls.get("pitch_count_pa"),
        "last_pitch_ts": ls.get("last_pitch_ts"),
    }


def _ou_market(
    pred: dict,
    predicted_value: float,
    line: float | None,
    over_price: int | None,
    under_price: int | None,
) -> dict:
    if line is None or predicted_value is None:
        return {
            "market": pred["market"],
            "predicted_value": predicted_value,
            "recommendation": None,
            "line": None,
            "price": None,
            "edge": None,
            "confidence": pred["confidence"],
            "probs": None,
            "sample_size": pred.get("sample_size", 0),
            "model_version": pred["model_version"],
            "features_used": pred.get("features_used", []),
        }
    if predicted_value > line:
        side, price = "over", over_price
    else:
        side, price = "under", under_price
    edge = calculate_edge(pred["confidence"], price) if price is not None else None
    return {
        "market": pred["market"],
        "predicted_value": predicted_value,
        "recommendation": side,
        "line": line,
        "price": price,
        "edge": edge,
        "confidence": pred["confidence"],
        "probs": None,
        "sample_size": pred.get("sample_size", 0),
        "model_version": pred["model_version"],
        "features_used": pred.get("features_used", []),
    }


def _argmax_market(pred: dict) -> dict:
    name, prob = max(pred["probs"].items(), key=lambda kv: kv[1])
    return {
        "market": pred["market"],
        "predicted_value": prob,
        "recommendation": name,
        "line": None,
        "price": None,
        "edge": None,
        "confidence": pred["confidence"],
        "probs": pred["probs"],
        "sample_size": pred.get("sample_size", 0),
        "model_version": pred["model_version"],
        "features_used": pred.get("features_used", []),
    }


def _market_sort_key(m: dict):
    edge = m.get("edge")
    return (edge is None, -(edge or 0.0))


def _build_game_payload(ls: dict) -> dict:
    # Import here to avoid a circular import between main.py and live.py.
    from backend.api.main import get_game_label

    game_pk = ls["game_pk"]
    ctx = _context_from(ls)

    p_speed = _predictor.predict_pitch_speed(ctx)
    p_pres  = _predictor.predict_pitch_result(ctx)
    p_abr   = _predictor.predict_at_bat_result(ctx)
    p_abp   = _predictor.predict_at_bat_pitches(ctx)
    preds_all = [p_speed, p_pres, p_abr, p_abp]

    odds_by_market = {o["market"]: o for o in get_odds(game_pk)}
    o_speed = odds_by_market.get("pitch_speed_ou", {})
    o_abp   = odds_by_market.get("ab_pitches_ou", {})

    markets = [
        _ou_market(p_speed, p_speed["predicted_mph"],
                   o_speed.get("line"), o_speed.get("over_price"), o_speed.get("under_price")),
        _argmax_market(p_pres),
        _argmax_market(p_abr),
        _ou_market(p_abp, p_abp["predicted_count"],
                   o_abp.get("line"), o_abp.get("over_price"), o_abp.get("under_price")),
    ]
    markets.sort(key=_market_sort_key)

    edges = [m["edge"] for m in markets if m["edge"] is not None]
    top_edge = max(edges) if edges else 0.0
    has_edge = top_edge > 0.05

    # Background audit write (best-effort, non-blocking).
    asyncio.create_task(_persist_async(game_pk, preds_all))

    try:
        current_pa_pitches = _load_current_pa_pitches(game_pk)
    except Exception as exc:
        print(f"[live] current_pa_pitches failed game={game_pk}: {exc}")
        current_pa_pitches = []

    return {
        "game_pk": game_pk,
        "game_label": get_game_label(game_pk),
        "situation": _situation(ls),
        "current_pa_pitches": current_pa_pitches,
        "markets": markets,
        "has_edge": has_edge,
        "top_edge": top_edge,
        "model_version": _predictor.model_version,
    }


async def _persist_async(game_pk: int, preds: list[dict]) -> None:
    try:
        at_bat_index, pitch_number = await asyncio.to_thread(current_pa_position, game_pk)
        await asyncio.to_thread(insert_predictions, game_pk, at_bat_index, pitch_number, preds)
    except Exception as exc:
        print(f"[live] persist failed game_pk={game_pk}: {exc}")


def _load_current_pa_pitches(game_pk: int) -> list[dict]:
    """Pitches in the current (latest) at-bat for this game, oldest first."""
    latest = (
        get_client().table("pitches")
        .select("at_bat_index")
        .eq("game_pk", game_pk)
        .order("at_bat_index", desc=True)
        .limit(1).execute().data
    )
    if not latest:
        return []
    abi = latest[0].get("at_bat_index")
    if abi is None:
        return []
    rows = (
        get_client().table("pitches")
        .select("pitch_number,pitch_type,start_speed,zone,description,result_category,balls,strikes")
        .eq("game_pk", game_pk).eq("at_bat_index", abi)
        .order("pitch_number")
        .execute().data
        or []
    )
    return rows


def _load_all_live() -> list[dict]:
    return (
        get_client().table("live_state")
        .select("*").execute().data
        or []
    )


def _load_one_live(game_pk: int) -> dict | None:
    rows = (
        get_client().table("live_state")
        .select("*").eq("game_pk", game_pk).limit(1).execute().data
    )
    return rows[0] if rows else None


@router.get("/live")
async def get_live() -> list[dict]:
    states = await asyncio.to_thread(_load_all_live)
    payloads = [_build_game_payload(ls) for ls in states if ls.get("game_pk") is not None]
    payloads.sort(key=lambda p: -p["top_edge"])
    return payloads


@router.get("/live/{game_pk}")
async def get_live_game(game_pk: int) -> dict:
    ls = await asyncio.to_thread(_load_one_live, game_pk)
    if not ls:
        raise HTTPException(404, detail=f"no live_state row for game_pk={game_pk}")
    return _build_game_payload(ls)


@router.post("/admin/reload-stats")
async def reload_stats() -> dict:
    counts = await asyncio.to_thread(get_cache().force_reload)
    return {"status": "reloaded", **counts}
