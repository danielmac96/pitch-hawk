"""Where v4 keeps frames, backfilled predictions and fitted models.

Everything lives in the warehouse bucket under `model_v4/`, resolved through
one index object, because the R2 token cannot LIST (docs/DATA-PIPELINE.md
§5). The same pattern as `_manifest.json`, and the same reason.

    model_v4/_index.json
    model_v4/frames/<grain>/<season>.parquet
    model_v4/backfill/<market>/<season>.parquet
    model_v4/artifacts/<market>/<run_id>.pkl

Frames are the expensive part (the v3 pipeline that produces their
structural columns takes ~2 hours on the runner), so they are written once
and every v4 iteration after that starts from them.
"""

from __future__ import annotations

import io
import json
import pickle
from datetime import datetime, timezone

import pandas as pd

PREFIX = "model_v4"
INDEX = f"{PREFIX}/_index.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_index(store) -> dict:  # noqa: ANN001
    if store.exists(INDEX):
        return json.loads(store.get(INDEX))
    return {"frames": {}, "backfill": {}, "artifacts": {}}


def save_index(store, idx: dict) -> None:  # noqa: ANN001
    store.put(INDEX, json.dumps(idx, indent=1, sort_keys=True, default=str).encode())


def _parquet(df: pd.DataFrame) -> bytes:
    buf = io.BytesIO()
    df.to_parquet(buf, index=False, compression="zstd")
    return buf.getvalue()


def _shrink(df: pd.DataFrame) -> pd.DataFrame:
    """float64 -> float32: frames are wide and the runner has 7 GB."""
    out = df.copy()
    for c in out.columns:
        if out[c].dtype == "float64":
            out[c] = out[c].astype("float32")
    return out


# ── frames ──────────────────────────────────────────────────────────────────

def put_frame(store, grain: str, df: pd.DataFrame, meta: dict | None = None) -> None:  # noqa: ANN001
    idx = load_index(store)
    seasons = sorted(int(s) for s in df["season"].unique())
    for s in seasons:
        store.put(f"{PREFIX}/frames/{grain}/{s}.parquet",
                  _parquet(_shrink(df[df["season"] == s])))
    idx["frames"][grain] = {"seasons": seasons, "rows": int(len(df)),
                            "columns": list(df.columns), "built_at": _now(),
                            **(meta or {})}
    save_index(store, idx)
    print(f"[v4] frame {grain}: {len(df):,} rows, {len(df.columns)} columns, "
          f"seasons {seasons[0]}-{seasons[-1]}", flush=True)


def put_frame_season(store, grain: str, season: int, df: pd.DataFrame) -> None:  # noqa: ANN001
    """One season of a frame too large to hold whole (pitch, pa_state)."""
    store.put(f"{PREFIX}/frames/{grain}/{int(season)}.parquet", _parquet(_shrink(df)))
    idx = load_index(store)
    cur = idx["frames"].get(grain, {"seasons": [], "rows_by_season": {}})
    rows = dict(cur.get("rows_by_season", {}))
    rows[str(int(season))] = int(len(df))
    idx["frames"][grain] = {"seasons": sorted(set(cur["seasons"]) | {int(season)}),
                            "rows_by_season": rows, "rows": sum(rows.values()),
                            "columns": list(df.columns), "built_at": _now()}
    save_index(store, idx)


def get_frame(store, grain: str, seasons=None, columns=None) -> pd.DataFrame:  # noqa: ANN001
    idx = load_index(store)
    if grain not in idx["frames"]:
        raise KeyError(f"frame {grain!r} not built; run `python -m modeling v4 "
                       f"frames --grain {grain}` first")
    want = idx["frames"][grain]["seasons"]
    if seasons is not None:
        want = [s for s in want if s in set(seasons)]
    parts = []
    for s in want:
        parts.append(pd.read_parquet(io.BytesIO(
            store.get(f"{PREFIX}/frames/{grain}/{s}.parquet")), columns=columns))
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()


def frame_info(store, grain: str) -> dict | None:  # noqa: ANN001
    return load_index(store)["frames"].get(grain)


# ── backfill ────────────────────────────────────────────────────────────────

def put_backfill(store, market: str, df: pd.DataFrame, meta: dict, *,  # noqa: ANN001
                 append: bool = False) -> None:
    """Write a market's backfill, one file per season.

    append=True merges into the season files already there, newer rows
    winning on the market's keys -- how `v4 score` extends a backfill
    without touching the walk-forward rows before it.
    """
    idx = load_index(store)
    prev = idx["backfill"].get(market, {})
    keys = [k for k in meta.get("keys", prev.get("keys", [])) if k in df]
    seasons = sorted(int(s) for s in df["season"].unique())
    rows = 0
    for s in seasons:
        key = f"{PREFIX}/backfill/{market}/{s}.parquet"
        part = df[df["season"] == s]
        if append and store.exists(key):
            old = pd.read_parquet(io.BytesIO(store.get(key)))
            part = pd.concat([old, part], ignore_index=True)
            if keys:
                part = part.drop_duplicates(keys, keep="last")
        store.put(key, _parquet(_shrink(part)))
        rows += len(part)
    all_seasons = sorted(set(prev.get("seasons", [])) | set(seasons)) if append else seasons
    idx["backfill"][market] = {**prev, **meta, "seasons": all_seasons,
                               "updated_at": _now(),
                               "rows": (prev.get("rows", 0) + len(df)) if append else rows}
    save_index(store, idx)


def get_backfill(store, market: str, seasons=None) -> pd.DataFrame:  # noqa: ANN001
    meta = load_index(store)["backfill"].get(market)
    if not meta:
        return pd.DataFrame()
    want = [s for s in meta["seasons"] if seasons is None or s in set(seasons)]
    return pd.concat([pd.read_parquet(io.BytesIO(store.get(
        f"{PREFIX}/backfill/{market}/{s}.parquet"))) for s in want],
        ignore_index=True) if want else pd.DataFrame()


# ── artifacts ───────────────────────────────────────────────────────────────

def put_artifact(store, market: str, run_id: str, model, meta: dict) -> str:  # noqa: ANN001
    key = f"{PREFIX}/artifacts/{market}/{run_id}.pkl"
    store.put(key, pickle.dumps(model, protocol=pickle.HIGHEST_PROTOCOL))
    idx = load_index(store)
    idx["artifacts"][market] = {"key": key, "run_id": run_id, "saved_at": _now(), **meta}
    save_index(store, idx)
    return key


def get_artifact(store, market: str):  # noqa: ANN001
    meta = load_index(store)["artifacts"].get(market)
    if not meta:
        return None, None
    return pickle.loads(store.get(meta["key"])), meta
