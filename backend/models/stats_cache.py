"""In-memory pitcher stats cache for the freq_v1 predictor.

Two access tiers:
  1. Bulk RPC load (get_pitcher_stats, get_pitcher_ab_stats) on startup + every
     3600s. Result lives in two dicts keyed on pitcher_id.
  2. Per-pitcher fallback for pitchers missing from the bulk load (rare for
     known pitchers; common during early-season backfill gaps). Queries the
     pitches table directly with limit 2000, caches with a 5-minute TTL.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from typing import Optional

from backend.config import (
    FALLBACK_TTL_SECONDS as _FALLBACK_TTL_SECONDS,
    GAME_CTX_TTL_SECONDS as _GAME_CTX_TTL_SECONDS,
    GAME_LOG_TTL_SECONDS as _GAME_LOG_TTL_SECONDS,
    MATCHUP_TTL_SECONDS as _MATCHUP_TTL_SECONDS,
    ROLLING_TTL_SECONDS as _ROLLING_TTL_SECONDS,
)
from backend.db.client import get_client

LEAGUE_AVG_SPEED = 92.5
LEAGUE_PITCH_RESULT = {"strike_foul": 0.455, "ball": 0.352, "in_play": 0.193}
LEAGUE_AB_RESULT = {"strikeout": 0.221, "walk": 0.087, "hit": 0.239, "out": 0.453}
LEAGUE_AVG_PITCHES_PA = 3.82


@dataclass(frozen=True)
class PitcherPitchStats:
    pitcher_id: int
    sample_pitches: int
    avg_speed: float
    strike_foul_rate: float
    ball_rate: float
    in_play_rate: float


@dataclass(frozen=True)
class PitcherAbStats:
    pitcher_id: int
    sample_abs: int
    avg_pitches: float
    so_rate: float
    bb_rate: float
    hit_rate: float
    out_rate: float


@dataclass(frozen=True)
class PitcherRollingStats:
    pitcher_id: int
    sample_pitches: int
    sample_abs: int
    zone_rate: Optional[float]
    chase_rate_against: Optional[float]
    whiff_rate: Optional[float]
    avg_fastball_velo: Optional[float]
    avg_offspeed_velo: Optional[float]
    k_rate: Optional[float]
    bb_rate: Optional[float]
    contact_rate_against: Optional[float]


@dataclass(frozen=True)
class BatterRollingStats:
    batter_id: int
    sample_pas: int
    chase_rate: Optional[float]
    contact_rate: Optional[float]
    k_rate: Optional[float]
    bb_rate: Optional[float]
    exit_velo_avg: Optional[float]
    hard_hit_rate: Optional[float]


def _as_float(v, default: float) -> float:
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _as_int(v, default: int = 0) -> int:
    if v is None:
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _opt_float(v) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class StatsCache:
    def __init__(self) -> None:
        self._pitch_by_pid: dict[int, PitcherPitchStats] = {}
        self._ab_by_pid: dict[int, PitcherAbStats] = {}
        self._fallback: dict[int, tuple[float, PitcherPitchStats]] = {}
        self._loaded_at: Optional[datetime] = None
        self._lock = Lock()

        # Phase 2 caches.
        self._pitcher_rolling: dict[int, PitcherRollingStats] = {}
        self._batter_rolling: dict[int, BatterRollingStats] = {}
        self._pitcher_rolling_fallback: dict[int, tuple[float, Optional[PitcherRollingStats]]] = {}
        self._batter_rolling_fallback: dict[int, tuple[float, Optional[BatterRollingStats]]] = {}
        self._matchup: dict[tuple[int, int], tuple[float, Optional[dict]]] = {}
        self._game_ctx: dict[int, tuple[float, Optional[dict]]] = {}
        self._pitcher_game_log_cache: dict[tuple[int, int], tuple[float, Optional[dict]]] = {}
        self._player_info: dict[int, Optional[dict]] = {}

    @property
    def loaded_at(self) -> Optional[datetime]:
        return self._loaded_at

    @property
    def pitcher_count(self) -> int:
        return len(self._pitch_by_pid)

    @property
    def ab_pitcher_count(self) -> int:
        return len(self._ab_by_pid)

    def ensure_loaded(self) -> None:
        if self._loaded_at is None:
            self.force_reload()

    def force_reload(self) -> dict:
        client = get_client()
        try:
            pitch_rows = client.rpc("get_pitcher_stats", {}).execute().data or []
        except Exception as exc:
            print(f"[stats_cache] get_pitcher_stats failed: {exc}")
            pitch_rows = []
        try:
            ab_rows = client.rpc("get_pitcher_ab_stats", {}).execute().data or []
        except Exception as exc:
            print(f"[stats_cache] get_pitcher_ab_stats failed: {exc}")
            ab_rows = []

        pitch_map: dict[int, PitcherPitchStats] = {}
        for r in pitch_rows:
            pid = r.get("pitcher_id")
            if pid is None:
                continue
            pitch_map[int(pid)] = PitcherPitchStats(
                pitcher_id=int(pid),
                sample_pitches=_as_int(r.get("sample_pitches")),
                avg_speed=_as_float(r.get("avg_speed"), LEAGUE_AVG_SPEED),
                strike_foul_rate=_as_float(r.get("strike_foul_rate"), LEAGUE_PITCH_RESULT["strike_foul"]),
                ball_rate=_as_float(r.get("ball_rate"), LEAGUE_PITCH_RESULT["ball"]),
                in_play_rate=_as_float(r.get("in_play_rate"), LEAGUE_PITCH_RESULT["in_play"]),
            )

        ab_map: dict[int, PitcherAbStats] = {}
        for r in ab_rows:
            pid = r.get("pitcher_id")
            if pid is None:
                continue
            ab_map[int(pid)] = PitcherAbStats(
                pitcher_id=int(pid),
                sample_abs=_as_int(r.get("sample_abs")),
                avg_pitches=_as_float(r.get("avg_pitches"), LEAGUE_AVG_PITCHES_PA),
                so_rate=_as_float(r.get("so_rate"), LEAGUE_AB_RESULT["strikeout"]),
                bb_rate=_as_float(r.get("bb_rate"), LEAGUE_AB_RESULT["walk"]),
                hit_rate=_as_float(r.get("hit_rate"), LEAGUE_AB_RESULT["hit"]),
                out_rate=_as_float(r.get("out_rate"), LEAGUE_AB_RESULT["out"]),
            )

        try:
            p_roll_rows = client.table("pitcher_rolling_stats").select("*").execute().data or []
        except Exception as exc:
            print(f"[stats_cache] pitcher_rolling_stats load failed: {exc}")
            p_roll_rows = []
        try:
            b_roll_rows = client.table("batter_rolling_stats").select("*").execute().data or []
        except Exception as exc:
            print(f"[stats_cache] batter_rolling_stats load failed: {exc}")
            b_roll_rows = []

        p_roll_map: dict[int, PitcherRollingStats] = {}
        for r in p_roll_rows:
            pid = r.get("pitcher_id")
            if pid is None:
                continue
            p_roll_map[int(pid)] = PitcherRollingStats(
                pitcher_id=int(pid),
                sample_pitches=_as_int(r.get("sample_pitches")),
                sample_abs=_as_int(r.get("sample_abs")),
                zone_rate=_opt_float(r.get("zone_rate")),
                chase_rate_against=_opt_float(r.get("chase_rate_against")),
                whiff_rate=_opt_float(r.get("whiff_rate")),
                avg_fastball_velo=_opt_float(r.get("avg_fastball_velo")),
                avg_offspeed_velo=_opt_float(r.get("avg_offspeed_velo")),
                k_rate=_opt_float(r.get("k_rate")),
                bb_rate=_opt_float(r.get("bb_rate")),
                contact_rate_against=_opt_float(r.get("contact_rate_against")),
            )

        b_roll_map: dict[int, BatterRollingStats] = {}
        for r in b_roll_rows:
            bid = r.get("batter_id")
            if bid is None:
                continue
            b_roll_map[int(bid)] = BatterRollingStats(
                batter_id=int(bid),
                sample_pas=_as_int(r.get("sample_pas")),
                chase_rate=_opt_float(r.get("chase_rate")),
                contact_rate=_opt_float(r.get("contact_rate")),
                k_rate=_opt_float(r.get("k_rate")),
                bb_rate=_opt_float(r.get("bb_rate")),
                exit_velo_avg=_opt_float(r.get("exit_velo_avg")),
                hard_hit_rate=_opt_float(r.get("hard_hit_rate")),
            )

        with self._lock:
            self._pitch_by_pid = pitch_map
            self._ab_by_pid = ab_map
            self._fallback.clear()
            self._pitcher_rolling = p_roll_map
            self._batter_rolling = b_roll_map
            self._pitcher_rolling_fallback.clear()
            self._batter_rolling_fallback.clear()
            self._matchup.clear()
            self._game_ctx.clear()
            self._pitcher_game_log_cache.clear()
            self._loaded_at = datetime.now(timezone.utc)

        print(
            f"[stats_cache] loaded pitch_stats={len(pitch_map)} "
            f"ab_stats={len(ab_map)} pitcher_rolling={len(p_roll_map)} "
            f"batter_rolling={len(b_roll_map)} at={self._loaded_at.isoformat()}"
        )
        return {
            "pitch_pitchers":   len(pitch_map),
            "ab_pitchers":      len(ab_map),
            "pitcher_rolling":  len(p_roll_map),
            "batter_rolling":   len(b_roll_map),
        }

    def get_pitch_stats(self, pitcher_id: Optional[int]) -> Optional[PitcherPitchStats]:
        if pitcher_id is None:
            return None
        s = self._pitch_by_pid.get(int(pitcher_id))
        if s is not None:
            return s
        return self._get_pitch_stats_fallback(int(pitcher_id))

    def get_ab_stats(self, pitcher_id: Optional[int]) -> Optional[PitcherAbStats]:
        if pitcher_id is None:
            return None
        return self._ab_by_pid.get(int(pitcher_id))

    def _get_pitch_stats_fallback(self, pitcher_id: int) -> Optional[PitcherPitchStats]:
        now = time.time()
        cached = self._fallback.get(pitcher_id)
        if cached is not None and now - cached[0] < _FALLBACK_TTL_SECONDS:
            return cached[1]
        try:
            rows = (
                get_client()
                .table("pitches")
                .select("start_speed,result_category")
                .eq("pitcher_id", pitcher_id)
                .limit(2000)
                .execute()
                .data
                or []
            )
        except Exception as exc:
            print(f"[stats_cache] fallback query failed pid={pitcher_id}: {exc}")
            return None
        if not rows:
            return None
        speeds = [r["start_speed"] for r in rows if r.get("start_speed") is not None]
        n = len(rows)
        sf = sum(1 for r in rows if r.get("result_category") == "strike_foul")
        bb = sum(1 for r in rows if r.get("result_category") == "ball")
        ip = sum(1 for r in rows if r.get("result_category") == "in_play")
        stats = PitcherPitchStats(
            pitcher_id=pitcher_id,
            sample_pitches=n,
            avg_speed=(sum(speeds) / len(speeds)) if speeds else LEAGUE_AVG_SPEED,
            strike_foul_rate=sf / n,
            ball_rate=bb / n,
            in_play_rate=ip / n,
        )
        self._fallback[pitcher_id] = (now, stats)
        return stats

    # -----------------------------------------------------------------
    # Phase 2 getters. All return None on missing data or DB error so
    # the predictor can gracefully fall back to freq_v1 logic.
    # -----------------------------------------------------------------

    def get_pitcher_rolling(self, pitcher_id: Optional[int]) -> Optional[PitcherRollingStats]:
        if pitcher_id is None:
            return None
        pid = int(pitcher_id)
        s = self._pitcher_rolling.get(pid)
        if s is not None:
            return s
        now = time.time()
        cached = self._pitcher_rolling_fallback.get(pid)
        if cached is not None and now - cached[0] < _ROLLING_TTL_SECONDS:
            return cached[1]
        try:
            rows = (
                get_client().table("pitcher_rolling_stats")
                .select("*").eq("pitcher_id", pid).limit(1).execute().data
                or []
            )
        except Exception as exc:
            print(f"[stats_cache] pitcher_rolling fallback failed pid={pid}: {exc}")
            self._pitcher_rolling_fallback[pid] = (now, None)
            return None
        if not rows:
            self._pitcher_rolling_fallback[pid] = (now, None)
            return None
        r = rows[0]
        stats = PitcherRollingStats(
            pitcher_id=pid,
            sample_pitches=_as_int(r.get("sample_pitches")),
            sample_abs=_as_int(r.get("sample_abs")),
            zone_rate=_opt_float(r.get("zone_rate")),
            chase_rate_against=_opt_float(r.get("chase_rate_against")),
            whiff_rate=_opt_float(r.get("whiff_rate")),
            avg_fastball_velo=_opt_float(r.get("avg_fastball_velo")),
            avg_offspeed_velo=_opt_float(r.get("avg_offspeed_velo")),
            k_rate=_opt_float(r.get("k_rate")),
            bb_rate=_opt_float(r.get("bb_rate")),
            contact_rate_against=_opt_float(r.get("contact_rate_against")),
        )
        self._pitcher_rolling_fallback[pid] = (now, stats)
        return stats

    def get_batter_rolling(self, batter_id: Optional[int]) -> Optional[BatterRollingStats]:
        if batter_id is None:
            return None
        bid = int(batter_id)
        s = self._batter_rolling.get(bid)
        if s is not None:
            return s
        now = time.time()
        cached = self._batter_rolling_fallback.get(bid)
        if cached is not None and now - cached[0] < _ROLLING_TTL_SECONDS:
            return cached[1]
        try:
            rows = (
                get_client().table("batter_rolling_stats")
                .select("*").eq("batter_id", bid).limit(1).execute().data
                or []
            )
        except Exception as exc:
            print(f"[stats_cache] batter_rolling fallback failed bid={bid}: {exc}")
            self._batter_rolling_fallback[bid] = (now, None)
            return None
        if not rows:
            self._batter_rolling_fallback[bid] = (now, None)
            return None
        r = rows[0]
        stats = BatterRollingStats(
            batter_id=bid,
            sample_pas=_as_int(r.get("sample_pas")),
            chase_rate=_opt_float(r.get("chase_rate")),
            contact_rate=_opt_float(r.get("contact_rate")),
            k_rate=_opt_float(r.get("k_rate")),
            bb_rate=_opt_float(r.get("bb_rate")),
            exit_velo_avg=_opt_float(r.get("exit_velo_avg")),
            hard_hit_rate=_opt_float(r.get("hard_hit_rate")),
        )
        self._batter_rolling_fallback[bid] = (now, stats)
        return stats

    def get_matchup_history(
        self, pitcher_id: Optional[int], batter_id: Optional[int],
    ) -> Optional[dict]:
        if pitcher_id is None or batter_id is None:
            return None
        key = (int(pitcher_id), int(batter_id))
        now = time.time()
        cached = self._matchup.get(key)
        if cached is not None and now - cached[0] < _MATCHUP_TTL_SECONDS:
            return cached[1]
        try:
            rows = (
                get_client().table("matchup_history")
                .select("*")
                .eq("pitcher_id", key[0]).eq("batter_id", key[1])
                .limit(1).execute().data
                or []
            )
        except Exception as exc:
            print(f"[stats_cache] matchup_history failed {key}: {exc}")
            self._matchup[key] = (now, None)
            return None
        row = rows[0] if rows else None
        self._matchup[key] = (now, row)
        return row

    def get_game_context(self, game_pk: Optional[int]) -> Optional[dict]:
        if game_pk is None:
            return None
        gp = int(game_pk)
        now = time.time()
        cached = self._game_ctx.get(gp)
        if cached is not None and now - cached[0] < _GAME_CTX_TTL_SECONDS:
            return cached[1]
        try:
            rows = (
                get_client().table("game_context")
                .select("*").eq("game_pk", gp).limit(1).execute().data
                or []
            )
        except Exception as exc:
            print(f"[stats_cache] game_context failed game={gp}: {exc}")
            self._game_ctx[gp] = (now, None)
            return None
        row = rows[0] if rows else None
        self._game_ctx[gp] = (now, row)
        return row

    def get_pitcher_game_log(
        self, game_pk: Optional[int], pitcher_id: Optional[int],
    ) -> Optional[dict]:
        if game_pk is None or pitcher_id is None:
            return None
        key = (int(game_pk), int(pitcher_id))
        now = time.time()
        cached = self._pitcher_game_log_cache.get(key)
        if cached is not None and now - cached[0] < _GAME_LOG_TTL_SECONDS:
            return cached[1]
        try:
            rows = (
                get_client().table("pitcher_game_log")
                .select("*")
                .eq("game_pk", key[0]).eq("pitcher_id", key[1])
                .limit(1).execute().data
                or []
            )
        except Exception as exc:
            print(f"[stats_cache] pitcher_game_log failed {key}: {exc}")
            self._pitcher_game_log_cache[key] = (now, None)
            return None
        row = rows[0] if rows else None
        self._pitcher_game_log_cache[key] = (now, row)
        return row

    def get_player_info(self, player_id: Optional[int]) -> Optional[dict]:
        if player_id is None:
            return None
        pid = int(player_id)
        if pid in self._player_info:
            return self._player_info[pid]
        try:
            rows = (
                get_client().table("player_info")
                .select("*").eq("player_id", pid).limit(1).execute().data
                or []
            )
        except Exception as exc:
            print(f"[stats_cache] player_info failed pid={pid}: {exc}")
            self._player_info[pid] = None
            return None
        row = rows[0] if rows else None
        self._player_info[pid] = row
        return row


_cache: Optional[StatsCache] = None


def get_cache() -> StatsCache:
    global _cache
    if _cache is None:
        _cache = StatsCache()
    return _cache
