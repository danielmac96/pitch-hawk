"""Pure derivations over manifest and query results.

Everything here is a plain function of its arguments — no I/O, no Streamlit, no
DuckDB — so the QA rules (what counts as a gap, what counts as drift, when a
missing-value rate turns red) can be read and changed in one place.

Thresholds are the dashboard's opinions and are stated as constants rather than
buried in formatting code.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import pandas as pd

# Missing-value rates, in percent of rows.
MISSING_WARN_PCT = 1.0
MISSING_ALERT_PCT = 5.0

# ── the anomaly rule ────────────────────────────────────────────────────────
# Every "is this day normal?" judgement in the dashboard runs through
# `with_baseline`, which compares a day against the trailing BASELINE_DAYS days
# the warehouse actually holds — game days, not calendar days — excluding the
# day being judged.
BASELINE_DAYS = 28

# Below this many baseline days there is nothing to compare against and the day
# is reported as `pass` with a null score rather than judged on two samples.
MIN_BASELINE_DAYS = 10

# Robust z: 0.6745 * (x - median) / MAD. Median and MAD are used instead of mean
# and standard deviation because one broken day inflates σ enough to hide
# itself; the median barely moves. 3.5 is the conventional MAD-outlier cutoff.
Z_WARN = 2.5
Z_ALERT = 3.5

# A relative floor on top of the z score: a day within this percent of the
# baseline median never flags however tight the spread. Without it a metric with
# a very small MAD flags on rounding noise — measured against the live
# warehouse, a bare z rule marked 293 of 2,014 pitch-days as failing, nearly all
# of them healthy.
REL_FLOOR_PCT = 5.0

# `bytes_per_row` needs a much wider floor than the others. Parquet's per-file
# overhead is fixed, so a light schedule raises bytes-per-row on its own: the
# 8-game day of 2026-08-03 sits 7% above a 15-game day with identical content.
# The metric is still worth watching — an all-null column or a schema change
# moves it far more than that — but not at a 5% floor.
BYTES_FLOOR_PCT = 15.0

# Small-sample guards. A one-game day is legitimately far from the median
# (2026-07-16 held a single game at 258 pitches, 12% low, and was correct), and
# bytes-per-row is meaningless on a file of a few rows.
MIN_GAMES_TO_JUDGE = 3

# Bytes-per-row is only stable enough to judge on a large file. Measured on the
# live warehouse: `pitches` days (~4,300 rows) hold it to ±1%, while `at_bats`
# days (~1,100 rows) swing ±20% purely on schedule size — a 500-row floor
# flagged 167 healthy at_bats days. Above this floor only `pitches` qualifies,
# which is also where a schema change matters most; the column is still shown
# for the others, just never flagged.
MIN_ROWS_FOR_BYTES = 3000

# Ingest lag is judged against the clock, not against a baseline: the corpus was
# backfilled in one pass on 2026-07-31 (6,033 of the 6,045 files were written
# that day), so historical days carry lags of up to eleven years and a rolling
# baseline of them describes the backfill, not tonight's run.
#
# Measured nightly behaviour: the job writes at ~16:15 UTC and covers through
# the previous day, so a healthy lag is ~1.7 days and one missed night is ~2.7.
# Warn at 3 and fail at 5 leaves the normal cadence — and the odd catch-up run —
# alone while still catching a job that has stopped.
LAG_WARN_DAYS = 3.0
LAG_FAIL_DAYS = 5.0

# …and only for days the nightly wrote. A backfill is identified by its shape
# rather than by a hardcoded date: one write batch that covers more than this
# many dataset-days is catching up on history, not covering last night. The
# 2026-07-31 pass wrote 2,011 days per dataset in a few minutes; a nightly
# writes one, occasionally two or three after a missed run.
BACKFILL_BATCH_FILES = 20

# Lag is judged over the most recent days only, on top of the backfill rule.
LAG_JUDGE_DAYS = 14

# Used when MAD is exactly zero, where a z score is undefined: judge on relative
# deviation alone, failing at three times the floor.
DRIFT_ALERT_PCT = REL_FLOOR_PCT

# Worst first. Every status sort and every "worst of" in the app uses this.
STATUS_RANK: dict[str, int] = {"fail": 0, "warn": 1, "pass": 2}


def worst(statuses) -> str:
    """The most severe status in `statuses`; `pass` when there are none."""
    values = list(statuses)
    return min(values, key=lambda s: STATUS_RANK.get(s, 2)) if values else "pass"


# Columns whose nulls are structural rather than a defect, and so are reported
# without a severity colour. Two families: batted-ball measurements exist only
# for balls in play (`launch_speed` is null on ~82% of pitches by design), and
# the base-occupancy columns hold a runner id or nothing at all — `on_third` is
# null on ~91% of pitches because third base is usually empty. Colouring these
# red would bury the columns where a null actually means a defect.
STRUCTURAL_NULL_COLUMNS: dict[str, frozenset[str]] = {
    "pitches": frozenset(
        {
            "on_first",
            "on_second",
            "on_third",
            "launch_speed",
            "launch_angle",
            "total_distance",
            "trajectory",
            "hit_hardness",
            "hit_location",
            "hit_coord_x",
            "hit_coord_y",
        }
    ),
    "at_bats": frozenset(),
    # Boxscore context is absent on scheduled-but-unplayed games and on older
    # seasons where the feed carried no weather or umpire block.
    "games": frozenset(
        {
            "hp_umpire_id",
            "hp_umpire",
            "weather_condition",
            "temp_f",
            "wind_mph",
            "wind_direction",
            "attendance",
            "game_duration_min",
        }
    ),
    "players": frozenset({"debut_date", "birth_date"}),
}


@dataclass(frozen=True)
class DatasetSummary:
    """One dataset's manifest totals. Files and rows are claims, not scans."""

    dataset: str
    files: int
    rows: int
    bytes_: int
    verified: int
    first_day: str | None
    last_day: str | None


def summarize(m: dict, dataset: str) -> DatasetSummary:
    """Totals for one dataset, read straight from the manifest."""
    entries = m.get("datasets", {}).get(dataset, {})
    days = sorted(entries)
    return DatasetSummary(
        dataset=dataset,
        files=len(days),
        rows=sum(e.get("rows", 0) for e in entries.values()),
        bytes_=sum(e.get("bytes", 0) for e in entries.values()),
        verified=sum(
            1
            for e in entries.values()
            if e.get("checksum") and e.get("verified_at") and e.get("verified_by")
        ),
        first_day=days[0] if days else None,
        last_day=days[-1] if days else None,
    )


def daily_counts(m: dict, dataset: str) -> pd.DataFrame:
    """Rows per day for one dataset: the ingestion record, one row per file.

    Sourced from the manifest rather than a `group by game_date`, which makes
    it complete over all 2,014 days at the cost of a single GET. A day absent
    here has no file at all, which is the failure the section exists to find.
    """
    entries = m.get("datasets", {}).get(dataset, {})
    rows = [
        {
            "day": day,
            "rows": e.get("rows", 0),
            "games": e.get("games", 0),
            "bytes": e.get("bytes", 0),
            "ingested_at": e.get("ingested_at"),
            "verified": bool(e.get("verified_at") and e.get("verified_by")),
        }
        for day, e in sorted(entries.items())
    ]
    df = pd.DataFrame(
        rows, columns=["day", "rows", "games", "bytes", "ingested_at", "verified"]
    )
    if not df.empty:
        df["day"] = pd.to_datetime(df["day"]).dt.date
    return df


def season_gaps(days: list[str]) -> pd.DataFrame:
    """Calendar days with no file, inside the span each season actually covers.

    Scoped per season on purpose: the warehouse holds game days only, so the
    four-month winter break between one season's last file and the next
    season's first is not a gap. A missing day *between* two files of the same
    season is one — the All-Star break included, which is why the run length is
    reported rather than judged.
    """
    by_season: dict[str, list[date]] = {}
    for d in days:
        by_season.setdefault(d[:4], []).append(date.fromisoformat(d))

    out: list[dict] = []
    for season, present in sorted(by_season.items()):
        have = set(present)
        cursor = min(present)
        end = max(present)
        run_start: date | None = None
        while cursor <= end:
            if cursor in have:
                if run_start is not None:
                    out.append(
                        {
                            "season": season,
                            "from": run_start,
                            "to": cursor - timedelta(days=1),
                            "days": (cursor - run_start).days,
                        }
                    )
                    run_start = None
            elif run_start is None:
                run_start = cursor
            cursor += timedelta(days=1)

    df = pd.DataFrame(out, columns=["season", "from", "to", "days"])
    return (
        df.sort_values(["days", "from"], ascending=[False, False])
        if not df.empty
        else df
    )


def missingness(counts: dict[str, int], total_rows: int, dataset: str) -> pd.DataFrame:
    """Per-column null rate from `count(col)` results and the row total."""
    structural = STRUCTURAL_NULL_COLUMNS.get(dataset, frozenset())
    rows = []
    for column, non_null in counts.items():
        missing = max(total_rows - non_null, 0)
        rows.append(
            {
                "column": column,
                "missing": missing,
                "missing_pct": (100.0 * missing / total_rows) if total_rows else 0.0,
                "present": non_null,
                "structural": column in structural,
            }
        )
    df = pd.DataFrame(
        rows, columns=["column", "missing", "missing_pct", "present", "structural"]
    )
    return df.sort_values("missing_pct", ascending=False, ignore_index=True)


def missing_severity(pct: float, structural: bool = False) -> str:
    """`ok` / `warn` / `alert`, per MISSING_WARN_PCT and MISSING_ALERT_PCT."""
    if structural:
        return "ok"
    if pct > MISSING_ALERT_PCT:
        return "alert"
    if pct > MISSING_WARN_PCT:
        return "warn"
    return "ok"


# ── robust statistics ───────────────────────────────────────────────────────


def mad(values: pd.Series) -> float:
    """Median absolute deviation. Zero when every value is identical."""
    clean = pd.Series(values).dropna().astype(float)
    if clean.empty:
        return 0.0
    return float((clean - clean.median()).abs().median())


def severity_from(
    z: float | None, rel_pct: float | None, *, floor_pct: float = REL_FLOOR_PCT
) -> str:
    """`pass` / `warn` / `fail` for one observation against its baseline.

    Both conditions must hold to flag: a large z score AND a deviation past the
    relative floor. That pairing is what keeps a very stable metric from
    flagging on noise, and a very noisy one from flagging on a real move.
    """
    if rel_pct is None or pd.isna(rel_pct):
        return "pass"
    if abs(rel_pct) <= floor_pct:
        return "pass"
    if z is None or pd.isna(z):
        # No usable spread (MAD == 0): judge on the relative move alone.
        return "fail" if abs(rel_pct) > 3 * floor_pct else "warn"
    if abs(z) > Z_ALERT:
        return "fail"
    if abs(z) > Z_WARN:
        return "warn"
    return "pass"


def with_baseline(
    df: pd.DataFrame,
    metric: str,
    *,
    window: int = BASELINE_DAYS,
    floor_pct: float = REL_FLOOR_PCT,
    judge: pd.Series | None = None,
) -> pd.DataFrame:
    """Add `<metric>_median`, `_z`, `_rel_pct` and `_status` columns.

    The baseline for row *i* is the previous `window` rows — the days the
    warehouse holds, so an off day or the winter break shortens the calendar
    span but not the sample. The day being judged is excluded from its own
    baseline, which is what lets a broken day stand out instead of dragging the
    median toward itself.

    `judge` is an optional mask of rows the rule may flag. Rows outside it still
    get their score computed and shown — they are simply never called a failure,
    which is how the small-sample guards are applied without hiding the numbers.

    `df` must be one dataset, sorted ascending by day.
    """
    out = df.copy()
    series = pd.to_numeric(out[metric], errors="coerce")
    prior = series.shift(1)

    median = prior.rolling(window, min_periods=MIN_BASELINE_DAYS).median()
    spread = prior.rolling(window, min_periods=MIN_BASELINE_DAYS).apply(mad, raw=False)

    rel = pd.Series(pd.NA, index=out.index, dtype="Float64")
    usable = median.notna() & (median != 0)
    rel[usable] = 100.0 * (series[usable] - median[usable]) / median[usable]

    z = pd.Series(pd.NA, index=out.index, dtype="Float64")
    scaled = spread.notna() & (spread > 0)
    z[scaled] = 0.6745 * (series[scaled] - median[scaled]) / spread[scaled]

    out[f"{metric}_median"] = median
    out[f"{metric}_mad"] = spread
    out[f"{metric}_rel_pct"] = rel
    out[f"{metric}_z"] = z
    allowed = pd.Series(True, index=out.index) if judge is None else judge.fillna(False)
    out[f"{metric}_status"] = [
        (
            severity_from(
                None if pd.isna(zi) else float(zi),
                None if pd.isna(ri) else float(ri),
                floor_pct=floor_pct,
            )
            if ok
            else "pass"
        )
        for zi, ri, ok in zip(z, rel, allowed)
    ]
    return out


def lag_status(lag_days: float | None) -> str:
    """Ingest lag against the nightly's terms, not against a rolling baseline.

    See LAG_WARN_DAYS: the whole corpus was backfilled in one pass, so a
    baseline built from historical lags describes the backfill, not the job that
    runs tonight.
    """
    if lag_days is None or pd.isna(lag_days):
        return "pass"
    if lag_days > LAG_FAIL_DAYS:
        return "fail"
    if lag_days > LAG_WARN_DAYS:
        return "warn"
    return "pass"


# ── manifest-derived frames ─────────────────────────────────────────────────


def ingest_frame(m: dict, datasets: tuple[str, ...]) -> pd.DataFrame:
    """One row per dataset-day, with the derived QA metrics attached.

    Costs nothing beyond the manifest that is already loaded, and covers every
    day the warehouse holds. Three derived columns carry most of the signal:

      rows_per_game   normalises away schedule size. Raw rows swing with the
                      number of games played; a partial ingest moves this.
      bytes_per_row   a schema change or a column gone entirely null shows up
                      here without reading any Parquet.
      lag_days        `ingested_at` minus the game date, in fractional days. The
                      nightly lands at ~1; a climb means the job is late,
                      retrying, or backfilling.
    """
    rows: list[dict] = []
    for dataset in datasets:
        for day, e in sorted(m.get("datasets", {}).get(dataset, {}).items()):
            n_rows = e.get("rows", 0) or 0
            n_games = e.get("games", 0) or 0
            n_bytes = e.get("bytes", 0) or 0
            ingested = pd.to_datetime(e.get("ingested_at"), utc=True, errors="coerce")
            day_ts = pd.Timestamp(day, tz="UTC")
            rows.append(
                {
                    "dataset": dataset,
                    "day": date.fromisoformat(day),
                    "rows": n_rows,
                    "games": n_games,
                    "bytes": n_bytes,
                    "rows_per_game": (n_rows / n_games) if n_games else None,
                    "bytes_per_row": (n_bytes / n_rows) if n_rows else None,
                    "ingested_at": ingested,
                    "lag_days": (
                        None
                        if pd.isna(ingested)
                        else (ingested - day_ts).total_seconds() / 86400.0
                    ),
                    "verified": bool(e.get("verified_at") and e.get("verified_by")),
                }
            )
    frame = pd.DataFrame(
        rows,
        columns=[
            "dataset",
            "day",
            "rows",
            "games",
            "bytes",
            "rows_per_game",
            "bytes_per_row",
            "ingested_at",
            "lag_days",
            "verified",
        ],
    )
    if frame.empty:
        frame["batch_files"] = []
        frame["from_backfill"] = []
        return frame

    # Which write batch each file belongs to, and whether that batch was a
    # backfill. Grouping by the calendar date of `ingested_at` is enough: a
    # nightly writes one day per dataset, a backfill writes thousands.
    batch = frame.groupby([frame["ingested_at"].dt.date, "dataset"])["day"]
    frame["batch_files"] = batch.transform("size")
    frame["from_backfill"] = frame["batch_files"] > BACKFILL_BATCH_FILES
    return frame


def scored_frame(m: dict, datasets: tuple[str, ...]) -> pd.DataFrame:
    """`ingest_frame` with baselines and statuses for the metrics QA reads.

    `expected_rows` is the baseline median rows-per-game times the games that
    day: the volume a healthy ingest would have produced for that schedule. It
    is what the volume chart plots against, so a light schedule reads as a light
    schedule rather than as a shortfall.
    """
    frame = ingest_frame(m, datasets)
    if frame.empty:
        return frame

    parts = []
    for _dataset, part in frame.groupby("dataset", sort=False):
        part = part.sort_values("day").reset_index(drop=True)
        part = with_baseline(
            part,
            "rows_per_game",
            floor_pct=REL_FLOOR_PCT,
            judge=part["games"] >= MIN_GAMES_TO_JUDGE,
        )
        part = with_baseline(
            part,
            "bytes_per_row",
            floor_pct=BYTES_FLOOR_PCT,
            judge=part["rows"] >= MIN_ROWS_FOR_BYTES,
        )
        # Lag is judged on recent days the nightly wrote — a backfill covering
        # 2015 in 2026 has an enormous lag and is not late.
        recent = pd.Series(False, index=part.index)
        recent.iloc[-LAG_JUDGE_DAYS:] = True
        judged_lag = recent & ~part["from_backfill"]
        part["lag_days_status"] = [
            lag_status(v) if ok else "pass"
            for v, ok in zip(part["lag_days"], judged_lag)
        ]
        part["expected_rows"] = part["rows_per_game_median"] * part["games"]
        parts.append(part)

    out = pd.concat(parts, ignore_index=True)
    # One status per day: the worst of the three, which is what the ingestion
    # table colours its row by.
    status_cols = ["rows_per_game_status", "bytes_per_row_status", "lag_days_status"]
    out["status"] = [
        min((row[c] for c in status_cols), key=lambda s: STATUS_RANK.get(s, 2))
        for _, row in out.iterrows()
    ]
    return out


def cross_dataset_frame(m: dict) -> pd.DataFrame:
    """Per day: the three datasets side by side, with their agreement ratios.

    The failure this exists to catch is one dataset landing without its
    siblings — `pitches` written while `games` was not — which is invisible from
    inside any single dataset. `games_agree` compares the game count each
    dataset recorded for the day against the number of rows in the `games` file,
    which is the same quantity counted three independent ways.
    """
    datasets = ("pitches", "at_bats", "games")
    days = sorted({d for ds in datasets for d in m.get("datasets", {}).get(ds, {})})
    rows: list[dict] = []
    for day in days:
        entries = {ds: m.get("datasets", {}).get(ds, {}).get(day) for ds in datasets}
        pitches = entries["pitches"] or {}
        at_bats = entries["at_bats"] or {}
        games = entries["games"] or {}
        p_rows = pitches.get("rows", 0) or 0
        a_rows = at_bats.get("rows", 0) or 0
        g_rows = games.get("rows", 0) or 0
        counted = {
            e.get("games", 0)
            for e in (pitches, at_bats)
            if e and e.get("games") is not None
        }
        rows.append(
            {
                "day": date.fromisoformat(day),
                "pitches": p_rows,
                "at_bats": a_rows,
                "games": g_rows,
                "missing": ", ".join(ds for ds in datasets if not entries[ds]),
                "pitches_per_pa": (p_rows / a_rows) if a_rows else None,
                "pa_per_game": (a_rows / g_rows) if g_rows else None,
                "pitches_per_game": (p_rows / g_rows) if g_rows else None,
                "games_agree": bool(
                    all(entries.values()) and counted and counted == {g_rows}
                ),
            }
        )
    return pd.DataFrame(
        rows,
        columns=[
            "day",
            "pitches",
            "at_bats",
            "games",
            "missing",
            "pitches_per_pa",
            "pa_per_game",
            "pitches_per_game",
            "games_agree",
        ],
    )


def metric_drift(
    baseline: pd.DataFrame, latest: pd.DataFrame, *, key: str = "metric"
) -> pd.DataFrame:
    """Latest-day distribution statistics against the baseline window's.

    Compares medians rather than means, and reports the shift in units of the
    baseline's own spread (`shift_mad`) as well as in percent — a 1 mph move in
    release velocity means something quite different from a 1 mph move in exit
    velocity, and the percent alone does not say which.
    """
    merged = baseline.merge(latest, on=key, suffixes=("_base", "_latest"), how="outer")
    rel: list[float | None] = []
    shift: list[float | None] = []
    status: list[str] = []
    for _, row in merged.iterrows():
        base_med, now_med = row.get("median_base"), row.get("median_latest")
        spread = row.get("spread_base")
        if pd.isna(base_med) or pd.isna(now_med) or base_med == 0:
            rel.append(None)
            shift.append(None)
            status.append("pass")
            continue
        r = 100.0 * (now_med - base_med) / base_med
        s = (now_med - base_med) / spread if spread and spread > 0 else None
        rel.append(r)
        shift.append(s)
        status.append(severity_from(s, r))
    merged["change_pct"] = rel
    merged["shift_mad"] = shift
    merged["status"] = status
    return merged


def human_bytes(n: float | None) -> str:
    """Byte count as a short human string. `None` renders as an em dash."""
    if n is None or pd.isna(n):
        return "—"
    size = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(size) < 1024.0 or unit == "TB":
            return f"{size:,.1f} {unit}" if unit != "B" else f"{size:,.0f} B"
        size /= 1024.0
    return f"{size:,.1f} TB"
