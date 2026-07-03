"""Central config: poll/refresh intervals and cache TTLs.

Every value can be overridden with an env var of the same name so deploys can
tune cadence without a code change. Defaults match the README.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"[config] {name}={raw!r} is not an int; using default {default}")
        return default


# Live poller cadence (MLB Stats API playByPlay).
POLL_INTERVAL_SECONDS = _int_env("POLL_INTERVAL_SECONDS", 8)

# Bulk stats-cache reload cadence.
STATS_REFRESH_SECONDS = _int_env("STATS_REFRESH_SECONDS", 3600)

# refresh_pitcher_rolling_stats / refresh_batter_rolling_stats RPC cadence.
ROLLING_REFRESH_SECONDS = _int_env("ROLLING_REFRESH_SECONDS", 1800)

# Per-entity cache TTLs (seconds) used by backend.models.stats_cache.
FALLBACK_TTL_SECONDS = _int_env("FALLBACK_TTL_SECONDS", 300)
ROLLING_TTL_SECONDS = _int_env("ROLLING_TTL_SECONDS", 600)
MATCHUP_TTL_SECONDS = _int_env("MATCHUP_TTL_SECONDS", 1800)
GAME_CTX_TTL_SECONDS = _int_env("GAME_CTX_TTL_SECONDS", 900)
GAME_LOG_TTL_SECONDS = _int_env("GAME_LOG_TTL_SECONDS", 120)

# API auth / abuse guards (backend.api.auth).
API_KEY = os.environ.get("API_KEY") or None
RATE_LIMIT_PER_MINUTE = _int_env("RATE_LIMIT_PER_MINUTE", 120)
