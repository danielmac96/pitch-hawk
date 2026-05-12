"""FastAPI app: CORS, lifespan poller, /health, market routers."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.routes import edge, odds, predictions
from backend.db.client import get_client, upsert_live_state
from backend.ingestion.mlb_api import get_live_games, get_play_by_play

POLL_INTERVAL_SECONDS = 15

_LIVE_PITCH_COLS = [
    "game_pk", "at_bat_index", "pitch_number", "pitcher_id", "batter_id",
    "pitch_type", "start_speed", "zone", "description", "result_category",
    "balls", "strikes", "outs", "inning", "top_inning", "pitch_ts",
]


def _build_live_state(pitches: list[dict]) -> dict | None:
    """Derive a live_state row from the most-recent at-bat in playByPlay."""
    indexed = [p for p in pitches if p.get("at_bat_index") is not None]
    if not indexed:
        return None
    latest_ab = max(p["at_bat_index"] for p in indexed)
    pa_pitches = [p for p in indexed if p["at_bat_index"] == latest_ab]
    pa_pitches.sort(key=lambda p: p.get("pitch_number") or 0)
    last = pa_pitches[-1]
    return {
        "status": "live",
        "inning": last.get("inning"),
        "top_inning": last.get("top_inning"),
        "batter_id": last.get("batter_id"),
        "pitcher_id": last.get("pitcher_id"),
        "balls": last.get("balls"),
        "strikes": last.get("strikes"),
        "outs": last.get("outs"),
        "pitch_count_pa": len(pa_pitches),
        "last_pitch_ts": last.get("pitch_ts"),
    }


def _upsert_pitches(pitches: list[dict]) -> int:
    rows = []
    for p in pitches:
        if p.get("at_bat_index") is None or p.get("pitch_number") is None:
            continue
        rows.append({k: p.get(k) for k in _LIVE_PITCH_COLS})
    if not rows:
        return 0
    client = get_client()
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        client.table("pitches").upsert(
            rows[i:i + batch_size], on_conflict="game_pk,at_bat_index,pitch_number",
        ).execute()
    return len(rows)


async def _poll_once() -> None:
    try:
        games = await get_live_games()
    except Exception as exc:
        print(f"[POLLER] get_live_games failed: {exc}")
        return
    if not games:
        return
    for g in games:
        game_pk = g["game_pk"]
        try:
            pitches = await get_play_by_play(game_pk)
            n = _upsert_pitches(pitches)
            state = _build_live_state(pitches)
            if state is not None:
                upsert_live_state(game_pk, state)
            print(f"[POLLER] game={game_pk} pitches_total={n} pa={state['pitch_count_pa'] if state else '-'}")
        except Exception as exc:
            print(f"[POLLER] game={game_pk} failed: {exc}")


async def _poll_loop() -> None:
    while True:
        await _poll_once()
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_poll_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="MLB Pitch Predictor — MVP", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(predictions.router)
app.include_router(odds.router)
app.include_router(edge.router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/games")
async def list_games() -> list[dict]:
    """Live games right now. Used by the frontend dropdown."""
    return await get_live_games()
