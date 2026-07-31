"""MLB Stats API client and row flatteners for the warehouse.

Mirrors the vocabulary in supabase/functions/_shared/vocab.ts so warehouse rows
and Postgres rows classify outcomes identically. Keep the two in sync.

Where this INTENTIONALLY differs from the Supabase ingest
(supabase/functions/_shared/mlb.ts):

  * balls/strikes are PRE-pitch. The feed reports the count after the pitch;
    a model predicting the next pitch needs the count the pitcher faced, so the
    flattener lags them within the at-bat. The Supabase table stores post-pitch
    counts and the training RPCs re-derive the lag in SQL.
  * home_score/away_score are PRE-plate-appearance, carried forward from the
    previous play's result, for the same reason.
  * Base occupancy is carried forward from the previous play's post-state and
    reset at each half-inning boundary. Steals and pickoffs appear as their own
    plays in allPlays, so carrying forward accounts for them.
  * ~40 measured fields per pitch instead of 6.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from typing import Any

MLB_BASE = "https://statsapi.mlb.com/api/v1"

CALL_CODE_TO_DESCRIPTION = {
    "B": "ball", "*B": "ball", "I": "ball", "P": "ball", "V": "ball",
    "H": "hit_by_pitch",
    "C": "called_strike", "A": "called_strike",
    "S": "swinging_strike", "W": "swinging_strike", "M": "swinging_strike",
    "Q": "swinging_strike",
    "F": "foul", "T": "foul", "L": "foul", "O": "foul", "R": "foul",
    "X": "in_play", "D": "in_play", "E": "in_play", "J": "in_play",
}

_STRIKE_FOUL = {"called_strike", "swinging_strike", "foul"}
_BALL = {"ball", "hit_by_pitch"}
_AB_HIT = {"single", "double", "triple", "home_run"}
_AB_WALK = {"walk", "intent_walk", "hit_by_pitch"}
_AB_K = {"strikeout", "strikeout_double_play", "strikeout_triple_play"}


def result_category(description: str | None) -> str | None:
    if not description:
        return None
    d = description.lower()
    if d in _STRIKE_FOUL:
        return "strike_foul"
    if d in _BALL:
        return "ball"
    if d.startswith("in_play") or "in play" in d:
        return "in_play"
    if "strike" in d or "foul" in d:
        return "strike_foul"
    if "ball" in d or "pitchout" in d:
        return "ball"
    return None


def ab_result_category(event_type: str | None) -> str | None:
    if not event_type:
        return None
    e = event_type.lower()
    if e in _AB_K:
        return "strikeout"
    if e in _AB_WALK:
        return "walk"
    if e in _AB_HIT:
        return "hit"
    return "out"


def men_on_base(on1: int | None, on2: int | None,
                on3: int | None) -> str:
    """Base-state category from PRE-play occupancy.

    Derived here rather than read from matchup.splits.menOnBase, which the API
    reports as the state AFTER the play. Verified 2026-07-30 on game 776652:
    at-bat 5 is a single off empty bases and splits reports "Men_On" — it
    matches postOnFirst/Second/Third exactly.

    Using the API's value as a pre-pitch feature would leak the at-bat's
    outcome into the model: a batter who reaches base always shows a runner on.
    Any model trained on it would validate beautifully and be worthless live.
    """
    occupied = (on1 is not None, on2 is not None, on3 is not None)
    if all(occupied):
        return "Loaded"
    if occupied[1] or occupied[2]:
        return "RISP"
    if occupied[0]:
        return "Men_On"
    return "Empty"


def is_final(status: str | None) -> bool:
    if not status:
        return False
    return status.startswith("Final") or status in ("Game Over",
                                                    "Completed Early")


class MlbApiError(RuntimeError):
    pass


def get(path: str, params: dict[str, str] | None = None, *,
        retries: int = 4, timeout: int = 45) -> Any:
    """GET with exponential backoff. The public API is unauthenticated and
    rate-limits under sustained load, so backoff is not optional for a
    26,000-game backfill."""
    url = MLB_BASE + path
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"{url}?{query}"
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "pitch-hawk-warehouse/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt == retries - 1:
                break
            time.sleep(min(30, 1.5 * (2 ** attempt)))
    raise MlbApiError(f"{url}: {last}")


# ── parsing helpers ─────────────────────────────────────────────────────────

def _int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def _float(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _ts(v: Any) -> datetime | None:
    if not v:
        return None
    s = str(v).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _date(v: Any) -> date | None:
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


# ── schedule ────────────────────────────────────────────────────────────────

def schedule(day: str, game_type: str = "R") -> list[dict]:
    """Final games on `day`. Non-final games are skipped so a suspended or
    in-progress game is never frozen into the warehouse half-complete."""
    data = get("/schedule", {"sportId": "1", "date": day,
                             "gameType": game_type, "hydrate": "team"})
    out = []
    for d in data.get("dates", []):
        for g in d.get("games", []):
            if not g.get("gamePk") or not is_final(
                    (g.get("status") or {}).get("detailedState")):
                continue
            out.append(g)
    return out


def flatten_game(g: dict, box: dict | None) -> dict:
    """Schedule row plus the boxscore context the dropped game_context and
    umpire_stats tables were meant to hold."""
    teams = g.get("teams") or {}
    home, away = teams.get("home") or {}, teams.get("away") or {}
    info = {}
    hp_id = hp_name = None
    if box:
        for o in box.get("officials", []):
            if o.get("officialType") == "Home Plate":
                hp_id = _int((o.get("official") or {}).get("id"))
                hp_name = (o.get("official") or {}).get("fullName")
        info = {i.get("label"): i.get("value") for i in box.get("info", [])}

    # "75 degrees, Partly Cloudy." -> (75, "Partly Cloudy")
    temp = cond = None
    if w := info.get("Weather"):
        parts = w.rstrip(".").split(",", 1)
        temp = _int(parts[0].replace("degrees", "").strip())
        cond = parts[1].strip() if len(parts) > 1 else None
    # "7 mph, Out To LF." -> (7, "Out To LF")
    wind_mph = wind_dir = None
    if wd := info.get("Wind"):
        parts = wd.rstrip(".").split(",", 1)
        wind_mph = _int(parts[0].replace("mph", "").strip())
        wind_dir = parts[1].strip() if len(parts) > 1 else None
    # "2:29." -> 149 minutes
    duration = None
    if t := info.get("T"):
        bits = t.rstrip(".").split(":")
        if len(bits) == 2 and bits[0].strip().isdigit():
            duration = int(bits[0]) * 60 + _int(bits[1] or 0)

    return {
        "game_pk": g["gamePk"],
        "game_date": _date(g.get("officialDate")),
        "season": _int(g.get("season")),
        "game_type": g.get("gameType"),
        "status": (g.get("status") or {}).get("detailedState"),
        "home_team_id": _int((home.get("team") or {}).get("id")),
        "away_team_id": _int((away.get("team") or {}).get("id")),
        "home_team": (home.get("team") or {}).get("name"),
        "away_team": (away.get("team") or {}).get("name"),
        "home_abbr": (home.get("team") or {}).get("abbreviation"),
        "away_abbr": (away.get("team") or {}).get("abbreviation"),
        "home_score": _int(home.get("score")),
        "away_score": _int(away.get("score")),
        "venue_id": _int((g.get("venue") or {}).get("id")),
        "venue_name": (g.get("venue") or {}).get("name"),
        "start_ts": _ts(g.get("gameDate")),
        "hp_umpire_id": hp_id,
        "hp_umpire": hp_name,
        "weather_condition": cond,
        "temp_f": temp,
        "wind_mph": wind_mph,
        "wind_direction": wind_dir,
        "attendance": _int((info.get("Att") or "").rstrip(".").replace(",", "")
                           or None),
        "game_duration_min": duration,
    }


# ── play-by-play ────────────────────────────────────────────────────────────

def flatten_play_by_play(game_pk: int, game_date: date | None,
                         pbp: dict) -> tuple[list[dict], list[dict]]:
    """Return (pitch rows, at-bat rows) for one game.

    Walks plays in order so pre-pitch count, pre-PA score, base occupancy,
    cumulative pitcher pitch count and times-through-order can all be carried
    forward. Every one of those is a feature the Supabase ingest discarded.
    """
    pitches: list[dict] = []
    at_bats: list[dict] = []

    # Carried state
    home_score = away_score = 0
    on1 = on2 = on3 = None
    last_half: tuple[int | None, bool | None] = (None, None)
    pitcher_pitch_count: dict[int, int] = {}
    faced: dict[tuple[int, int], int] = {}

    for play in pbp.get("allPlays", []):
        about = play.get("about") or {}
        matchup = play.get("matchup") or {}
        result = play.get("result") or {}
        splits = matchup.get("splits") or {}

        inning = _int(about.get("inning"))
        top = about.get("isTopInning")
        # Bases clear at each half-inning change.
        if (inning, top) != last_half:
            on1 = on2 = on3 = None
            last_half = (inning, top)

        pitcher_id = _int((matchup.get("pitcher") or {}).get("id"))
        batter_id = _int((matchup.get("batter") or {}).get("id"))
        bat_side = (matchup.get("batSide") or {}).get("code")
        pitch_hand = (matchup.get("pitchHand") or {}).get("code")

        tto = None
        if pitcher_id is not None and batter_id is not None:
            key = (pitcher_id, batter_id)
            faced[key] = faced.get(key, 0) + 1
            tto = faced[key]

        # Pre-play base state, derived from carried-forward occupancy.
        # matchup.splits.menOnBase is deliberately NOT used — see men_on_base().
        men_on = men_on_base(on1, on2, on3)
        pre_home, pre_away = home_score, away_score

        events = [e for e in (play.get("playEvents") or [])
                  if e.get("type") == "pitch"]

        # Pre-pitch count: the feed's event count is POST-pitch.
        balls = strikes = 0
        for ev in events:
            details = ev.get("details") or {}
            pd = ev.get("pitchData") or {}
            coords = pd.get("coordinates") or {}
            breaks = pd.get("breaks") or {}
            hit = ev.get("hitData") or {}
            hcoords = hit.get("coordinates") or {}

            code = (details.get("call") or {}).get("code")
            desc = CALL_CODE_TO_DESCRIPTION.get(code) if code else None
            if not desc:
                desc = (details.get("description") or "").lower().replace(
                    " ", "_") or None

            if pitcher_id is not None:
                pitcher_pitch_count[pitcher_id] = pitcher_pitch_count.get(
                    pitcher_id, 0) + 1

            pitches.append({
                "game_pk": game_pk,
                "at_bat_index": _int(about.get("atBatIndex")),
                "pitch_number": _int(ev.get("pitchNumber")),
                "pitcher_id": pitcher_id,
                "batter_id": batter_id,
                "game_date": game_date,
                "pitch_ts": _ts(ev.get("startTime")),
                "balls": balls,
                "strikes": strikes,
                "outs": _int((play.get("count") or {}).get("outs")),
                "inning": inning,
                "top_inning": top,
                "men_on_base": men_on,
                "on_first": on1,
                "on_second": on2,
                "on_third": on3,
                "home_score": pre_home,
                "away_score": pre_away,
                "pitch_of_game": pitcher_pitch_count.get(pitcher_id or -1),
                "times_through_order": tto,
                "bat_side": bat_side,
                "pitch_hand": pitch_hand,
                "pitch_type": (details.get("type") or {}).get("code"),
                "description": desc,
                "result_category": result_category(desc),
                "is_strike": details.get("isStrike"),
                "is_ball": details.get("isBall"),
                "is_in_play": details.get("isInPlay"),
                "start_speed": _float(pd.get("startSpeed")),
                "end_speed": _float(pd.get("endSpeed")),
                "zone": _int(pd.get("zone")),
                "plate_x": _float(coords.get("pX")),
                "plate_z": _float(coords.get("pZ")),
                "sz_top": _float(pd.get("strikeZoneTop")),
                "sz_bottom": _float(pd.get("strikeZoneBottom")),
                "spin_rate": _int(breaks.get("spinRate")),
                "spin_direction": _int(breaks.get("spinDirection")),
                "break_vertical_induced": _float(
                    breaks.get("breakVerticalInduced")),
                "break_horizontal": _float(breaks.get("breakHorizontal")),
                "break_angle": _float(breaks.get("breakAngle")),
                "break_length": _float(breaks.get("breakLength")),
                "extension": _float(pd.get("extension")),
                "plate_time": _float(pd.get("plateTime")),
                "launch_speed": _float(hit.get("launchSpeed")),
                "launch_angle": _float(hit.get("launchAngle")),
                "total_distance": _float(hit.get("totalDistance")),
                "trajectory": hit.get("trajectory"),
                "hit_hardness": hit.get("hardness"),
                "hit_location": hit.get("location"),
                "hit_coord_x": _float(hcoords.get("coordX")),
                "hit_coord_y": _float(hcoords.get("coordY")),
            })

            # Advance the count for the next pitch in this at-bat.
            cnt = ev.get("count") or {}
            balls = _int(cnt.get("balls")) or 0
            strikes = _int(cnt.get("strikes")) or 0

        event_type = result.get("eventType")
        if event_type:
            at_bats.append({
                "game_pk": game_pk,
                "at_bat_index": _int(about.get("atBatIndex")),
                "pitcher_id": pitcher_id,
                "batter_id": batter_id,
                "game_date": game_date,
                "inning": inning,
                "top_inning": top,
                "pitch_count": len(events),
                "result": ab_result_category(event_type),
                "result_detail": event_type,
                "event": result.get("event"),
                "rbi": _int(result.get("rbi")),
                "is_scoring_play": about.get("isScoringPlay"),
                "men_on_base": men_on,
                "home_score": pre_home,
                "away_score": pre_away,
                "times_through_order": tto,
                "bat_side": bat_side,
                "pitch_hand": pitch_hand,
                "start_ts": _ts(events[0].get("startTime")) if events else None,
                "end_ts": _ts(events[-1].get("startTime")) if events else None,
            })

        # Carry post-play state forward.
        if result.get("homeScore") is not None:
            home_score = _int(result.get("homeScore")) or 0
            away_score = _int(result.get("awayScore")) or 0
        on1 = _int((matchup.get("postOnFirst") or {}).get("id"))
        on2 = _int((matchup.get("postOnSecond") or {}).get("id"))
        on3 = _int((matchup.get("postOnThird") or {}).get("id"))

    return pitches, at_bats


def fetch_game(game_pk: int, game_date: date | None, *,
               with_boxscore: bool = True) -> dict:
    """One game: play-by-play plus optional boxscore context."""
    pbp = get(f"/game/{game_pk}/playByPlay")
    box = None
    if with_boxscore:
        try:
            box = get(f"/game/{game_pk}/boxscore")
        except MlbApiError:
            box = None  # context is enrichment; never fail the game for it
    pitches, at_bats = flatten_play_by_play(game_pk, game_date, pbp)
    return {"pitches": pitches, "at_bats": at_bats, "boxscore": box}


def fetch_players(ids: list[int]) -> list[dict]:
    out: list[dict] = []
    uniq = sorted({i for i in ids if i})
    for i in range(0, len(uniq), 100):
        chunk = uniq[i:i + 100]
        try:
            data = get("/people", {"personIds": ",".join(map(str, chunk))})
        except MlbApiError:
            continue
        for p in data.get("people", []):
            if p.get("id") is None:
                continue
            out.append({
                "player_id": _int(p.get("id")),
                "full_name": p.get("fullName"),
                "bat_side": (p.get("batSide") or {}).get("code"),
                "pitch_hand": (p.get("pitchHand") or {}).get("code"),
                "position": (p.get("primaryPosition") or {}).get(
                    "abbreviation"),
                "debut_date": _date(p.get("mlbDebutDate")),
                "birth_date": _date(p.get("birthDate")),
            })
    return out
