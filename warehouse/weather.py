"""Gametime weather from Open-Meteo, joined to games by venue and first pitch.

WHY A SECOND WEATHER SOURCE. The warehouse already carries `games.temp_f` and
friends, parsed from the boxscore -- which exists only once a game is FINAL. A
pregame call cannot read it. Training a weather term on post-hoc observations
and then serving it a forecast is a train/serve mismatch the model cannot show
you. Open-Meteo has a forecast API and an archive reaching back decades, so
both sides of that line come from one source, one grid and one set of units.

Open-Meteo needs no API key and is free for non-commercial use, which is the
same footing as every other upstream here (MLB, ESPN, Kalshi).

COST. Two batchings collapse a 26,957-game backfill into ~12 requests:

  * a date RANGE in one call -- a whole season for one point
  * MULTIPLE POINTS in one call -- comma-separated lat/lon, and the response
    is a LIST in the order the points were sent

So one call covers every venue for a whole season. Measured 2026-09-18: 30
venues x a full season x 6 variables is ~8.7 MB in ~21s.

UNITS are requested explicitly (fahrenheit, mph, UTC) rather than taking the
defaults, because a silent unit change upstream would land as a plausible
number rather than as an error.
"""

from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

HOURLY_VARS = (
    "temperature_2m",
    "relative_humidity_2m",
    "wind_speed_10m",
    "wind_direction_10m",
    "surface_pressure",
    "precipitation",
)

_HOURLY_TO_FIELD = {
    "temperature_2m": "temp_f",
    "relative_humidity_2m": "humidity_pct",
    "wind_speed_10m": "wind_mph",
    "wind_direction_10m": "wind_dir_deg",
    "surface_pressure": "pressure_hpa",
    "precipitation": "precip_in",
}

# Open-Meteo caps how many points one request may carry. Kept at a width that
# is already proven end to end; chunking costs one extra request per chunk
# rather than risking a whole-season failure on an undocumented ceiling.
MAX_POINTS_PER_CALL = 30

MM_PER_INCH = 25.4


class WeatherApiError(RuntimeError):
    pass


def wind_out_component(speed_mph: float | None, from_deg: float | None,
                       azimuth_deg: float | None) -> float | None:
    """Wind along home plate -> center field, in mph. Positive is blowing out.

    Bare wind speed is close to useless for a home-run model: 15 mph across the
    field does nothing that a 15 mph gale to center does. This projection is
    what makes the number mean something.

    The two conventions that have to line up:

      azimuth_deg  MLB's `venue.location.azimuthAngle` -- the compass bearing
                   from home plate toward center field.
      from_deg     Meteorological wind direction -- the bearing the wind comes
                   FROM, not the one it travels toward.

    Wind travelling toward bearing A arrives from A + 180, so

        out = -speed * cos(from_deg - azimuth)

    which is +speed when the wind comes from directly behind the plate and
    -speed when it comes straight in from center field.

    THE SIGN IS CHECKED, NOT ASSUMED. Getting it backwards would invert the
    single most important weather feature and still look entirely plausible, so
    it was validated against MLB's own wind labels over 61 games in 2025:

        "Out To ..."   n=18   mean +3.18 mph   sign agrees 14/18
        "In From ..."  n= 9   mean -3.20 mph   sign agrees  8/9
        cross winds    n=31   mean +0.90 mph

    Disagreement is expected and is not a defect: MLB's label is a field-level
    observation by the club, this is a ~10 m reanalysis grid point, and
    "Out To LF" is not "Out To CF" so its center-field component is smaller.
    The means being clean, symmetric and correctly signed is the result that
    matters. tests/warehouse/test_weather.py pins the convention.
    """
    if speed_mph is None or from_deg is None or azimuth_deg is None:
        return None
    return -float(speed_mph) * math.cos(math.radians(
        float(from_deg) - float(azimuth_deg)))


def _get(url: str, params: dict, *, retries: int = 4, timeout: int = 120):
    full = f"{url}?{urllib.parse.urlencode(params)}"
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                full, headers={"User-Agent": "pitch-hawk-warehouse/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt == retries - 1:
                break
            time.sleep(min(30, 1.5 * (2 ** attempt)))
    raise WeatherApiError(f"{url}: {last}")


def fetch_hourly(points: list[tuple[float, float]], start: str, end: str, *,
                 archive: bool = True) -> list[dict]:
    """Hourly series per point, in the order `points` was given.

    `archive=False` hits the forecast endpoint instead, which is what a pregame
    caller wants. Same parameters and same response shape, so nothing
    downstream has to branch on which one produced the numbers.

    A single point comes back as a bare object rather than a list, so it is
    normalised here -- otherwise every caller repeats the same special case.
    """
    if not points:
        return []
    out: list[dict] = []
    for i in range(0, len(points), MAX_POINTS_PER_CALL):
        chunk = points[i:i + MAX_POINTS_PER_CALL]
        params = {
            "latitude": ",".join(f"{lat:.4f}" for lat, _ in chunk),
            "longitude": ",".join(f"{lon:.4f}" for _, lon in chunk),
            "start_date": start,
            "end_date": end,
            "hourly": ",".join(HOURLY_VARS),
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "precipitation_unit": "mm",
            "timezone": "UTC",
        }
        data = _get(ARCHIVE_URL if archive else FORECAST_URL, params)
        block = data if isinstance(data, list) else [data]
        if len(block) != len(chunk):
            raise WeatherApiError(
                f"asked for {len(chunk)} points, got {len(block)} back; "
                f"refusing to guess which reading belongs to which venue")
        out.extend(block)
    return out


def _index_hours(series: dict) -> dict[str, dict]:
    """Hour string -> the reading at that hour, for O(1) lookup per game."""
    hourly = series.get("hourly") or {}
    times = hourly.get("time") or []
    cols = {v: hourly.get(v) or [] for v in HOURLY_VARS}
    idx: dict[str, dict] = {}
    for i, t in enumerate(times):
        idx[t] = {v: (cols[v][i] if i < len(cols[v]) else None)
                  for v in HOURLY_VARS}
    return idx


def hour_key(ts) -> str | None:
    """The UTC hour CONTAINING first pitch, as Open-Meteo spells it.

    Floor, not nearest. "The hour the game started" is what gametime weather
    conventionally means, and a game runs ~3 hours on from that point --
    rounding a 19:40 start up to 20:00 would claim a precision the choice does
    not have.
    """
    if ts is None:
        return None
    if isinstance(ts, str):
        try:
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:00")


def rows_for_games(games: list[dict], venues: dict[int, dict],
                   series_by_venue: dict[int, dict], *,
                   source: str = "open_meteo_archive") -> list[dict]:
    """One weather row per game that has a venue, a start time and a reading.

    Games are DROPPED rather than emitted with nulls when the venue is unknown
    or the hour is missing. A row of nulls keyed to a game_pk asserts "we
    looked and there was no weather here", which is not what happened.
    """
    indexed = {vid: _index_hours(s) for vid, s in series_by_venue.items()}
    rows: list[dict] = []
    for g in games:
        vid = g.get("venue_id")
        v = venues.get(vid)
        hour = hour_key(g.get("start_ts"))
        if v is None or hour is None:
            continue
        reading = indexed.get(vid, {}).get(hour)
        if reading is None:
            continue
        vals = {f: reading.get(k) for k, f in _HOURLY_TO_FIELD.items()}
        precip_mm = vals.get("precip_in")
        rows.append({
            "game_pk": g.get("game_pk"),
            "game_date": g.get("game_date"),
            "venue_id": vid,
            "obs_ts": datetime.strptime(hour, "%Y-%m-%dT%H:00").replace(
                tzinfo=timezone.utc),
            "temp_f": vals.get("temp_f"),
            "humidity_pct": vals.get("humidity_pct"),
            "wind_mph": vals.get("wind_mph"),
            "wind_dir_deg": vals.get("wind_dir_deg"),
            "wind_out_mph": wind_out_component(
                vals.get("wind_mph"), vals.get("wind_dir_deg"),
                v.get("azimuth_angle")),
            "pressure_hpa": vals.get("pressure_hpa"),
            # Requested in mm so the unit is explicit on the wire; stored in
            # inches to match every other imperial column in the warehouse.
            "precip_in": (None if precip_mm is None
                          else float(precip_mm) / MM_PER_INCH),
            "source": source,
        })
    return rows
