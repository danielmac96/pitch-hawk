"""FastAPI app: CORS, lifespan poller, /health, market routers."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.live_store import get_store
from backend.api.routes import edge, live, odds, predictions
from backend.db.client import get_client, upsert_live_state
from backend.ingestion.game_context import upsert_game_context
from backend.ingestion.mlb_api import get_live_games, get_play_by_play
from backend.ingestion.pitcher_game_log import update_pitcher_game_log
from backend.ingestion.player_info import ensure_players
from backend.models.predictor import PitchPredictor
from backend.models.stats_cache import get_cache

log = logging.getLogger("backend.poller")

POLL_INTERVAL_SECONDS = 8
STATS_REFRESH_SECONDS = 3600
ROLLING_REFRESH_SECONDS = 6 * 3600

_LIVE_PITCH_COLS = [
    "game_pk", "at_bat_index", "pitch_number", "pitcher_id", "batter_id",
    "pitch_type", "start_speed", "zone", "description", "result_category",
    "balls", "strikes", "outs", "inning", "top_inning", "pitch_ts",
]

# Columns sent to the frontend for each pitch in the current plate appearance.
# Mirrors the SELECT in live._load_current_pa_pitches so the in-memory path and
# the Supabase-fallback path produce identical shapes.
_PA_PITCH_COLS = [
    "pitch_number", "pitch_type", "start_speed", "zone",
    "description", "result_category", "balls", "strikes",
]


def _warn_if_multi_worker() -> None:
    """Loudly warn if started with >1 worker.

    The in-memory live store + the single background poller assume one process.
    With multiple workers each gets its own store and its own poller, so /live
    answers go stale/inconsistent and MLB gets polled N times over. We can only
    reliably observe WEB_CONCURRENCY from inside the app (the uvicorn --workers
    flag isn't exported), which is the common knob and what gunicorn sets.
    """
    raw = os.environ.get("WEB_CONCURRENCY")
    try:
        workers = int(raw) if raw else 1
    except ValueError:
        workers = 1
    if workers > 1:
        banner = "!" * 72
        log.warning(
            "\n%s\n[STARTUP] WEB_CONCURRENCY=%s (>1). This app keeps live state "
            "IN MEMORY and runs ONE poller per process. Run with a SINGLE worker "
            "or /live will be stale/inconsistent and MLB will be polled %s times.\n%s",
            banner, raw, workers, banner,
        )

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


async def _enrich_async(game_pk: int, pitches: list[dict], state: dict | None) -> None:
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


def _build_current_pa_pitches(pitches: list[dict]) -> list[dict]:
    """Pitches in the current (latest) at-bat, oldest first, in the /live shape.

    Same group/sort as _build_live_state, but projected to the columns the
    frontend renders. Derived from the play-by-play we already hold in memory,
    so /live no longer needs a Supabase read to show the current PA.
    """
    indexed = [p for p in pitches if p.get("at_bat_index") is not None]
    if not indexed:
        return []
    latest_ab = max(p["at_bat_index"] for p in indexed)
    pa = [p for p in indexed if p["at_bat_index"] == latest_ab]
    pa.sort(key=lambda p: p.get("pitch_number") or 0)
    return [{k: p.get(k) for k in _PA_PITCH_COLS} for p in pa]


async def _process_game(game_pk: int) -> None:
    try:
        pitches = await get_play_by_play(game_pk)
    except Exception as exc:
        print(f"[POLLER] game={game_pk} failed: {exc}")
        return

    # In-memory first: derive state with no I/O and publish to the store so
    # /live can answer immediately. Guarded so a store bug never kills the tick.
    state = _build_live_state(pitches)
    if state is not None:
        state = {"game_pk": game_pk, **state}
        try:
            get_store().update(game_pk, state, _build_current_pa_pitches(pitches))
        except Exception as exc:
            print(f"[POLLER] store update failed game={game_pk}: {exc}")

    # Supabase audit write (Phase 2 makes this fire-and-forget).
    try:
        n = await asyncio.to_thread(_persist_game, game_pk, pitches, state)
        print(f"[POLLER] game={game_pk} pitches_total={n} pa={state['pitch_count_pa'] if state else '-'}")
    except Exception as exc:
        print(f"[POLLER] persist failed game={game_pk}: {exc}")

    # Phase 2 enrichments run detached so the next poll tick isn't blocked.
    asyncio.create_task(_enrich_async(game_pk, pitches, state))


def _persist_game(game_pk: int, pitches: list[dict], state: dict | None) -> int:
    n = _upsert_pitches(pitches)
    if state is not None:
        ls = {k: v for k, v in state.items() if k != "game_pk"}
        upsert_live_state(game_pk, ls)
    return n


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
    await asyncio.gather(
        *[_process_game(g["game_pk"]) for g in games if g.get("game_pk") is not None],
        return_exceptions=True,
    )


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
    _warn_if_multi_worker()
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
