"""Per-game enrichment: venue, home-plate umpire, weather.

Boxscore -> venue_id, venue_name, umpire (officials[role='Home Plate']).
For outdoor parks, weather.gov is hit for temperature / wind. Domes and
retractables that are usually closed are flagged is_dome=True and skip
the weather lookup.

Graceful: any sub-failure leaves the missing fields as None; never raises
to the caller.
"""

from __future__ import annotations

import asyncio

import httpx

from backend.db.client import get_client

MLB_API_BASE = "https://statsapi.mlb.com/api/v1.1"
WEATHER_USER_AGENT = "mlb-next-pitch (danielmac96@gmail.com)"

# Treat retractables as dome=True for now (refine later when MLB Stats API
# exposes roof state per game).
_DOME_VENUE_IDS: set[int] = {
    12,    # Tropicana Field (Rays, fixed dome)
    14,    # Rogers Centre (Blue Jays, retractable)
    32,    # American Family Field (Brewers, retractable)
    2392,  # Minute Maid Park (Astros, retractable)
    2680,  # Chase Field (Diamondbacks, retractable)
    680,   # T-Mobile Park (Mariners, retractable)
    5325,  # Globe Life Field (Rangers, retractable)
    4169,  # loanDepot Park (Marlins, retractable)
}

STATS_API_BASE = "https://statsapi.mlb.com/api/v1"

# venue_id -> (lat, lon) | None, looked up once per process from MLB's venues
# endpoint instead of a hand-maintained dict (which had drifted: missing
# newer parks like Sutter Health Park, and carried two outright placeholder
# coordinates for venues 345/401).
_venue_latlon_cache: dict[int, tuple[float, float] | None] = {}


async def _fetch_venue_latlon(venue_id: int) -> tuple[float, float] | None:
    if venue_id in _venue_latlon_cache:
        return _venue_latlon_cache[venue_id]
    result: tuple[float, float] | None = None
    try:
        async with httpx.AsyncClient(base_url=STATS_API_BASE, timeout=15.0) as c:
            r = await c.get(f"/venues/{venue_id}")
            r.raise_for_status()
            venues = r.json().get("venues") or []
            loc = (venues[0].get("location") or {}) if venues else {}
            lat, lon = loc.get("latitude"), loc.get("longitude")
            if lat is not None and lon is not None:
                result = (float(lat), float(lon))
    except Exception as exc:
        print(f"[game_context] venue lookup failed venue={venue_id}: {exc}")
    _venue_latlon_cache[venue_id] = result
    return result


_COMPASS_TO_DEG = {
    "N": 0, "NNE": 22, "NE": 45, "ENE": 67,
    "E": 90, "ESE": 112, "SE": 135, "SSE": 157,
    "S": 180, "SSW": 202, "SW": 225, "WSW": 247,
    "W": 270, "WNW": 292, "NW": 315, "NNW": 337,
}


def _parse_wind_speed(s: str | None) -> float | None:
    if not s:
        return None
    # weather.gov returns e.g. "12 mph" or "5 to 10 mph"
    parts = s.split()
    if not parts:
        return None
    try:
        return float(parts[0])
    except ValueError:
        return None


def _parse_wind_dir(s: str | None) -> int | None:
    if not s:
        return None
    return _COMPASS_TO_DEG.get(s.upper())


async def _fetch_weather(lat: float, lon: float) -> dict:
    headers = {"User-Agent": WEATHER_USER_AGENT, "Accept": "application/geo+json"}
    async with httpx.AsyncClient(timeout=15.0, headers=headers) as c:
        r = await c.get(f"https://api.weather.gov/points/{lat},{lon}")
        r.raise_for_status()
        forecast_url = (r.json().get("properties") or {}).get("forecastHourly")
        if not forecast_url:
            return {}
        r2 = await c.get(forecast_url)
        r2.raise_for_status()
        periods = ((r2.json().get("properties") or {}).get("periods") or [])
        if not periods:
            return {}
        p0 = periods[0]
        return {
            "temperature_f":  float(p0["temperature"]) if p0.get("temperature") is not None else None,
            "wind_speed_mph": _parse_wind_speed(p0.get("windSpeed")),
            "wind_dir_deg":   _parse_wind_dir(p0.get("windDirection")),
        }


async def fetch_game_context(game_pk: int) -> dict:
    out: dict = {
        "game_pk": int(game_pk),
        "venue_id": None, "venue_name": None,
        "umpire_id": None, "umpire_name": None,
        "temperature_f": None, "wind_speed_mph": None, "wind_dir_deg": None,
        "is_dome": False, "roof_closed": None,
    }

    try:
        async with httpx.AsyncClient(base_url=MLB_API_BASE, timeout=15.0) as c:
            r = await c.get(f"/game/{game_pk}/boxscore")
            r.raise_for_status()
            data = r.json()
    except Exception as exc:
        print(f"[game_context] boxscore failed game={game_pk}: {exc}")
        return out

    venue = (data.get("officialVenue") or data.get("teams", {}).get("home", {}).get("team", {}).get("venue") or {})
    out["venue_id"] = venue.get("id")
    out["venue_name"] = venue.get("name")

    for off in data.get("officials") or []:
        role = (off.get("officialType") or "").lower()
        if "home plate" in role:
            person = off.get("official") or {}
            out["umpire_id"] = person.get("id")
            out["umpire_name"] = person.get("fullName")
            break

    if out["venue_id"] in _DOME_VENUE_IDS:
        out["is_dome"] = True
        out["roof_closed"] = True
        return out

    latlon = await _fetch_venue_latlon(out["venue_id"]) if out["venue_id"] is not None else None
    if latlon is None:
        return out

    try:
        w = await _fetch_weather(*latlon)
        out.update(w)
    except Exception as exc:
        print(f"[game_context] weather failed game={game_pk} venue={out['venue_id']}: {exc}")

    return out


def _row_exists(game_pk: int) -> bool:
    rows = (
        get_client().table("game_context")
        .select("game_pk").eq("game_pk", game_pk).limit(1).execute().data
    )
    return bool(rows)


def _upsert_game_context_row(row: dict) -> None:
    get_client().table("game_context").upsert(row, on_conflict="game_pk").execute()


async def upsert_game_context(game_pk: int) -> None:
    try:
        if await asyncio.to_thread(_row_exists, game_pk):
            return
    except Exception as exc:
        print(f"[game_context] row exists check failed game={game_pk}: {exc}")
        return
    row = await fetch_game_context(game_pk)
    try:
        await asyncio.to_thread(_upsert_game_context_row, row)
    except Exception as exc:
        print(f"[game_context] upsert failed game={game_pk}: {exc}")
