"""GET /predictions/{game_pk} — read live_state, run all 4 stubs, persist, return."""

from fastapi import APIRouter, HTTPException

from backend.db.client import get_client
from backend.models.predictor import PitchPredictor

router = APIRouter(prefix="/predictions", tags=["predictions"])

_predictor = PitchPredictor()


def _load_live_state(game_pk: int) -> dict | None:
    rows = (
        get_client().table("live_state")
        .select("*").eq("game_pk", game_pk).limit(1).execute().data
    )
    return rows[0] if rows else None


def _current_pa_position(game_pk: int) -> tuple[int | None, int | None]:
    rows = (
        get_client().table("pitches")
        .select("at_bat_index,pitch_number")
        .eq("game_pk", game_pk)
        .order("at_bat_index", desc=True)
        .order("pitch_number", desc=True)
        .limit(1)
        .execute().data
    )
    if not rows:
        return None, None
    return rows[0]["at_bat_index"], rows[0]["pitch_number"]


def _scalar(pred: dict) -> tuple[float, float]:
    """Collapse a market-specific prediction into (predicted_value, confidence)
    for the predictions table, which only has a scalar predicted_value column."""
    if "predicted_mph" in pred:
        return float(pred["predicted_mph"]), float(pred["confidence"])
    if "predicted_count" in pred:
        return float(pred["predicted_count"]), float(pred["confidence"])
    if "probs" in pred:
        m = max(pred["probs"].values())
        return float(m), float(m)
    raise ValueError(f"unknown prediction shape: {pred}")


def _persist(game_pk: int, at_bat_index: int | None, pitch_number: int | None,
            preds: list[dict]) -> None:
    rows = []
    for p in preds:
        v, c = _scalar(p)
        rows.append({
            "game_pk": game_pk,
            "at_bat_index": at_bat_index,
            "pitch_number": pitch_number,
            "market": p["market"],
            "predicted_value": v,
            "confidence": c,
            "model_version": p["model_version"],
        })
    get_client().table("predictions").insert(rows).execute()


def _context_from(ls: dict) -> dict:
    return {
        "pitcher_id":     ls.get("pitcher_id"),
        "batter_id":      ls.get("batter_id"),
        "balls":          ls.get("balls"),
        "strikes":        ls.get("strikes"),
        "pitch_count_pa": ls.get("pitch_count_pa"),
        "inning":         ls.get("inning"),
    }


@router.get("/{game_pk}")
async def get_predictions(game_pk: int) -> dict:
    ls = _load_live_state(game_pk)
    if not ls:
        raise HTTPException(404, detail=f"no live_state row for game_pk={game_pk}")
    ctx = _context_from(ls)
    preds = [
        _predictor.predict_pitch_speed(ctx),
        _predictor.predict_pitch_result(ctx),
        _predictor.predict_at_bat_result(ctx),
        _predictor.predict_at_bat_pitches(ctx),
    ]
    at_bat_index, pitch_number = _current_pa_position(game_pk)
    try:
        _persist(game_pk, at_bat_index, pitch_number, preds)
    except Exception as exc:
        # Best-effort: persistence is for audit, not for serving this response.
        print(f"[predictions] persist failed for game_pk={game_pk}: {exc}")
    return {"game_pk": game_pk, "context": ctx, "predictions": preds}
