"""GET /predictions/{game_pk} — read live_state, run all 4 predictors, persist, return."""

from fastapi import APIRouter, HTTPException

from backend.db.client import get_client
from backend.models._persist import current_pa_position, insert_predictions
from backend.models.predictor import PitchPredictor

router = APIRouter(prefix="/predictions", tags=["predictions"])

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
    at_bat_index, pitch_number = current_pa_position(game_pk)
    try:
        insert_predictions(game_pk, at_bat_index, pitch_number, preds)
    except Exception as exc:
        # Best-effort: persistence is for audit, not for serving this response.
        print(f"[predictions] persist failed for game_pk={game_pk}: {exc}")
    return {"game_pk": game_pk, "context": ctx, "predictions": preds}
