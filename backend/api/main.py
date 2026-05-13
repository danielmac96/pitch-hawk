"""FastAPI app: CORS, lifespan poller, /health, market routers."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.routes import edge, live, odds, predictions
from backend.db.client import get_client, upsert_live_state
from backend.ingestion.game_context import upsert_game_context
from backend.ingestion.mlb_api import get_live_games, get_play_by_play
from backend.ingestion.pitcher_game_log import update_pitcher_game_log
from backend.ingestion.player_info import ensure_players
from backend.models.predictor import PitchPredictor
from backend.models.stats_cache import get_cache

POLL_INTERVAL_SECONDS = 15
STATS_REFRESH_SECONDS = 3600
ROLLING_REFRESH_SECONDS = 6 * 3600

_LIVE_PITCH_COLS = [
    "game_pk", "at_bat_index", "pitch_number", "pitcher_id", "batter_id",
    "pitch_type", "start_speed", "zone", "description", "result_category",
    "balls", "strikes", "outs", "inning", "top_inning", "pitch_ts",
]

# Keyed on game_pk -> {"home_team": str, "away_team": str}. Refreshed each
# poller tick from get_live_games(). Reads are O(1) and never block on I/O.
_GAMES_CACHE: dict[int, dict] = {}


def get_game_label(game_pk: int) -> str:
    info = _GAMES_CACHE.get(game_pk)
    if not info:
        return f"Game {game_pk}"
    away = info.get("away_team") or "Away"
    home = info.get("home_team") or "Home"
    return f"{away} @ {home}"


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
        gp = g.get("game_pk")
        if gp is not None:
            _GAMES_CACHE[gp] = {
                "home_team": g.get("home_team"),
                "away_team": g.get("away_team"),
            }
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
            continue

        # Phase 2 enrichments. Each is best-effort; a failure logs and
        # never breaks the poll cycle.
        all_pitchers = {p["pitcher_id"] for p in pitches if p.get("pitcher_id")}
        all_batters = {p["batter_id"] for p in pitches if p.get("batter_id")}
        try:
            await ensure_players(list(all_pitchers), list(all_batters))
        except Exception as exc:
            print(f"[POLLER] ensure_players failed game={game_pk}: {exc}")
        try:
            await upsert_game_context(game_pk)
        except Exception as exc:
            print(f"[POLLER] game_context failed game={game_pk}: {exc}")
        pitcher_id = (state or {}).get("pitcher_id")
        if pitcher_id is not None:
            try:
                await update_pitcher_game_log(game_pk, pitcher_id, pitches)
            except Exception as exc:
                print(f"[POLLER] pitcher_game_log failed game={game_pk}: {exc}")


async def _poll_loop() -> None:
    while True:
        await _poll_once()
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


async def _stats_refresh_loop() -> None:
    while True:
        await asyncio.sleep(STATS_REFRESH_SECONDS)
        try:
            await asyncio.to_thread(get_cache().force_reload)
        except Exception as exc:
            print(f"[stats_cache] periodic reload failed: {exc}")


def _refresh_rolling_stats() -> tuple[int | None, int | None]:
    client = get_client()
    n1 = client.rpc("refresh_pitcher_rolling_stats", {}).execute().data
    n2 = client.rpc("refresh_batter_rolling_stats", {}).execute().data
    return n1, n2


async def _rolling_stats_refresh_loop() -> None:
    while True:
        await asyncio.sleep(ROLLING_REFRESH_SECONDS)
        try:
            n1, n2 = await asyncio.to_thread(_refresh_rolling_stats)
            print(f"[rolling] refreshed pitchers={n1} batters={n2}")
            await asyncio.to_thread(get_cache().force_reload)
        except Exception as exc:
            print(f"[rolling] refresh failed: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await asyncio.to_thread(get_cache().ensure_loaded)
    except Exception as exc:
        print(f"[stats_cache] initial load failed: {exc}")
    poll_task = asyncio.create_task(_poll_loop())
    stats_task = asyncio.create_task(_stats_refresh_loop())
    rolling_task = asyncio.create_task(_rolling_stats_refresh_loop())
    try:
        yield
    finally:
        tasks = (poll_task, stats_task, rolling_task)
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
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
app.include_router(live.router)


@app.get("/health")
async def health() -> dict:
    cache = get_cache()
    return {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model_version": PitchPredictor.model_version,
        "stats_pitchers": cache.pitcher_count,
        "stats_ab_pitchers": cache.ab_pitcher_count,
        "stats_loaded_at": cache.loaded_at.isoformat() if cache.loaded_at else None,
    }


@app.get("/games")
async def list_games() -> list[dict]:
    """Live games right now. Used by the frontend dropdown."""
    return await get_live_games()
