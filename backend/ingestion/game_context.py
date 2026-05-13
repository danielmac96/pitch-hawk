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

# Approx lat/lon for 30 MLB parks (outdoor + domed alike — used only for
# outdoor parks since domes short-circuit).
_VENUE_LATLON: dict[int, tuple[float, float]] = {
    1:    (39.9056, -75.1665),   # Citizens Bank Park (Phillies)
    2:    (39.2840, -76.6217),   # Oriole Park at Camden Yards
    3:    (40.8296, -73.9262),   # Yankee Stadium
    4:    (42.3467, -71.0972),   # Fenway Park
    5:    (41.3296, -81.6850),   # Progressive Field
    7:    (41.6611, -87.6347),   # Guaranteed Rate Field
    9:    (37.7786, -122.3893),  # Oracle Park (Giants)
    10:   (39.7559, -104.9942),  # Coors Field
    12:   (27.7682, -82.6534),   # Tropicana Field
    13:   (33.8003, -117.8827),  # Angel Stadium
    14:   (43.6414, -79.3894),   # Rogers Centre
    15:   (34.0739, -118.2400),  # Dodger Stadium
    17:   (41.9484, -87.6553),   # Wrigley Field
    19:   (39.0517, -94.4803),   # Kauffman Stadium
    22:   (38.6226, -90.1928),   # Busch Stadium
    31:   (42.3390, -83.0485),   # Comerica Park
    32:   (43.0280, -87.9712),   # American Family Field
    51:   (32.7073, -117.1566),  # Petco Park
    345:  (33.7355, -112.2244),  # actually used by spring; placeholder
    401:  (33.7350, -112.2110),  # placeholder
    680:  (47.5914, -122.3325),  # T-Mobile Park
    2392: (29.7573, -95.3555),   # Minute Maid Park
    2602: (38.8730, -77.0074),   # Nationals Park
    2680: (33.4453, -112.0667),  # Chase Field
    2889: (44.9817, -93.2776),   # Target Field
    3289: (40.7571, -74.0741),   # Citi Field
    3309: (40.4469, -79.9856),   # PNC Park
    4169: (25.7782, -80.2197),   # loanDepot Park
    4705: (33.8908, -84.4678),   # Truist Park
    5325: (32.7475, -97.0817),   # Globe Life Field
    7067: (38.7390, -121.5910),  # Sutter Health Park (Athletics' temp 2025+)
}

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

    latlon = _VENUE_LATLON.get(out["venue_id"]) if out["venue_id"] is not None else None
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
