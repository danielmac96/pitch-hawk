"""GET /edge/{game_pk} — join live predictions with stub odds, sort by edge."""

from fastapi import APIRouter, HTTPException

from backend.db.client import get_client
from backend.ingestion.odds_stub import calculate_edge, get_odds
from backend.models.predictor import PitchPredictor

router = APIRouter(prefix="/edge", tags=["edge"])

_predictor = PitchPredictor()


def _load_live_state(game_pk: int) -> dict | None:
    rows = (
        get_client().table("live_state")
        .select("*").eq("game_pk", game_pk).limit(1).execute().data
    )
    return rows[0] if rows else None


def _context_from(ls: dict) -> dict:
    return {
        "pitcher_id":     ls.get("pitcher_id"),
        "batter_id":      ls.get("batter_id"),
        "balls":          ls.get("balls"),
        "strikes":        ls.get("strikes"),
        "pitch_count_pa": ls.get("pitch_count_pa"),
        "inning":         ls.get("inning"),
    }


def _ou_row(pred: dict, predicted_value: float, line: float | None,
           over_price: int | None, under_price: int | None) -> dict:
    if line is None:
        return {
            "market": pred["market"], "recommendation": None, "line": None,
            "price": None, "edge": None, "confidence": pred["confidence"],
            "predicted_value": predicted_value,
        }
    if predicted_value > line:
        side, price = "over", over_price
    else:
        side, price = "under", under_price
    edge = calculate_edge(pred["confidence"], price) if price is not None else None
    return {
        "market": pred["market"], "recommendation": side, "line": line,
        "price": price, "edge": edge, "confidence": pred["confidence"],
        "predicted_value": predicted_value,
    }


def _argmax_row(pred: dict) -> dict:
    name, prob = max(pred["probs"].items(), key=lambda kv: kv[1])
    return {
        "market": pred["market"], "recommendation": name, "line": None,
        "price": None, "edge": None, "confidence": prob,
        "predicted_value": prob,
    }


@router.get("/{game_pk}")
async def get_edge(game_pk: int) -> list[dict]:
    ls = _load_live_state(game_pk)
    if not ls:
        raise HTTPException(404, detail=f"no live_state row for game_pk={game_pk}")
    ctx = _context_from(ls)
    odds_by_market = {o["market"]: o for o in get_odds(game_pk)}

    p_speed = _predictor.predict_pitch_speed(ctx)
    o_speed = odds_by_market.get(p_speed["market"], {})
    speed_row = _ou_row(
        p_speed, p_speed["predicted_mph"], o_speed.get("line"),
        o_speed.get("over_price"), o_speed.get("under_price"),
    )

    p_pres = _predictor.predict_pitch_result(ctx)
    pres_row = _argmax_row(p_pres)

    p_abr = _predictor.predict_at_bat_result(ctx)
    abr_row = _argmax_row(p_abr)

    p_abp = _predictor.predict_at_bat_pitches(ctx)
    o_abp = odds_by_market.get(p_abp["market"], {})
    abp_row = _ou_row(
        p_abp, p_abp["predicted_count"], o_abp.get("line"),
        o_abp.get("over_price"), o_abp.get("under_price"),
    )

    rows = [speed_row, pres_row, abr_row, abp_row]
    # Sort by edge desc; None last.
    rows.sort(key=lambda r: (r["edge"] is None, -(r["edge"] or 0.0)))
    return rows
