"""Baseball Savant / pybaseball bulk historical loader."""

from __future__ import annotations

import time

import httpx
import pandas as pd

from backend.db.client import get_client

_RETRYABLE = (httpx.TransportError, httpx.RemoteProtocolError, httpx.TimeoutException)


def _upsert_with_retry(table: str, batch: list[dict], on_conflict: str,
                      attempts: int = 4) -> None:
    last: Exception | None = None
    for n in range(attempts):
        try:
            get_client().table(table).upsert(batch, on_conflict=on_conflict).execute()
            return
        except _RETRYABLE as exc:
            last = exc
            wait = 1.5 * (2 ** n)
            print(f"    [retry] {table} batch failed ({type(exc).__name__}): "
                  f"sleeping {wait}s before attempt {n + 2}/{attempts}")
            time.sleep(wait)
    raise RuntimeError(f"upsert to {table} failed after {attempts} attempts") from last

# Statcast description values -> result_category bucket. Vocabulary aligned with
# the call-code mapping in backend.ingestion.mlb_api so live and historical
# pitches share one set of buckets.
_STRIKE_FOUL = {
    "called_strike", "swinging_strike", "swinging_strike_blocked",
    "foul", "foul_tip", "foul_bunt", "missed_bunt", "bunt_foul_tip",
}
_BALL = {"ball", "blocked_ball", "intent_ball", "pitchout"}
_IN_PLAY = {"hit_into_play", "hit_into_play_score", "hit_into_play_no_out"}


def _result_category(description: str | None) -> str:
    if description in _STRIKE_FOUL:
        return "strike_foul"
    if description in _BALL:
        return "ball"
    if description in _IN_PLAY:
        return "in_play"
    return "other"


def fetch_statcast_range(start_date: str, end_date: str) -> pd.DataFrame:
    """Pull Statcast pitches in [start_date, end_date] and map to pitches schema."""
    from pybaseball import statcast  # lazy: pybaseball import is slow

    raw = statcast(start_dt=start_date, end_dt=end_date, parallel=True, verbose=False)
    if raw is None or raw.empty:
        return pd.DataFrame()

    df = pd.DataFrame({
        "game_pk":      raw["game_pk"].astype("Int64"),
        "at_bat_index": raw["at_bat_number"].astype("Int64"),
        "pitch_number": raw["pitch_number"].astype("Int64"),
        "pitcher_id":   raw["pitcher"].astype("Int64"),
        "batter_id":    raw["batter"].astype("Int64"),
        "pitch_type":   raw["pitch_type"],
        "start_speed":  raw["release_speed"],
        "zone":         raw["zone"].astype("Int64"),
        "description":  raw["description"],
        "balls":        raw["balls"].astype("Int64"),
        "strikes":      raw["strikes"].astype("Int64"),
        "outs":         raw["outs_when_up"].astype("Int64"),
        "inning":       raw["inning"].astype("Int64"),
        "top_inning":   raw["inning_topbot"].eq("Top"),
        "pitch_ts":     pd.to_datetime(raw["game_date"], utc=True),
        "events":       raw.get("events"),  # used by build_at_bats; not loaded to pitches
    })
    df = df.dropna(subset=["start_speed"])
    df["result_category"] = df["description"].map(_result_category)
    return df


_PITCH_COLS = [
    "game_pk", "at_bat_index", "pitch_number", "pitcher_id", "batter_id",
    "pitch_type", "start_speed", "zone", "description", "result_category",
    "balls", "strikes", "outs", "inning", "top_inning", "pitch_ts",
]

_AB_COLS = [
    "game_pk", "at_bat_index", "pitcher_id", "batter_id",
    "pitch_count", "result", "result_detail", "start_ts", "end_ts",
]


def _records_for_upsert(df: pd.DataFrame, cols: list[str]) -> list[dict]:
    sub = df[cols].astype(object).where(pd.notnull(df[cols]), None)
    records = sub.to_dict(orient="records")
    for r in records:
        for k, v in list(r.items()):
            if isinstance(v, pd.Timestamp):
                r[k] = v.isoformat()
    return records


def load_to_supabase(df: pd.DataFrame, batch_size: int = 500) -> int:
    if df is None or df.empty:
        return 0
    records = _records_for_upsert(df, _PITCH_COLS)
    total = len(records)
    for i in range(0, total, batch_size):
        batch = records[i:i + batch_size]
        _upsert_with_retry("pitches", batch, "game_pk,at_bat_index,pitch_number")
        print(f"  [pitches] {min(i + batch_size, total)} / {total}")
    return total


def _at_bat_result(events: object) -> tuple[str, str | None]:
    if not isinstance(events, str):
        return "out", None
    if events in ("strikeout", "strikeout_double_play"):
        return "strikeout", events
    if events in ("walk", "intent_walk"):
        return "walk", events
    if events in ("single", "double", "triple", "home_run"):
        return "hit", events
    return "out", events


def build_at_bats(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()
    df = df.sort_values(["game_pk", "at_bat_index", "pitch_number"])
    rows: list[dict] = []
    for (game_pk, ab_idx), g in df.groupby(["game_pk", "at_bat_index"]):
        first = g.iloc[0]
        last = g.iloc[-1]
        result, detail = _at_bat_result(last.get("events"))
        rows.append({
            "game_pk":      int(game_pk),
            "at_bat_index": int(ab_idx),
            "pitcher_id":   int(last["pitcher_id"]) if pd.notna(last["pitcher_id"]) else None,
            "batter_id":    int(last["batter_id"]) if pd.notna(last["batter_id"]) else None,
            "pitch_count":  len(g),
            "result":       result,
            "result_detail": detail,
            "start_ts":     first["pitch_ts"],
            "end_ts":       last["pitch_ts"],
        })
    return pd.DataFrame(rows)


def load_at_bats_to_supabase(df: pd.DataFrame, batch_size: int = 500) -> int:
    if df is None or df.empty:
        return 0
    records = _records_for_upsert(df, _AB_COLS)
    total = len(records)
    for i in range(0, total, batch_size):
        batch = records[i:i + batch_size]
        _upsert_with_retry("at_bats", batch, "game_pk,at_bat_index")
        print(f"  [at_bats] {min(i + batch_size, total)} / {total}")
    return total
