"""Every SQL the dashboard runs, in one place.

Rules this module keeps:

  * **Aggregation happens in DuckDB.** Only the "latest records" section pulls
    raw rows, and it pulls 100 of them from a single day's file. Missingness,
    duplicate counts, histogram bins and drift means all come back already
    reduced — a histogram returns its bins, never its observations.

  * **Files are named, never globbed.** Each query is handed an explicit list
    of `s3://` URIs resolved from the manifest, because the scoped R2 token
    cannot LIST and a glob would resolve to nothing.

  * **Column lists come from the frozen Parquet schemas** in
    `warehouse.config`, so a schema change reaches the QA view without an edit
    here.

The column names below are the warehouse's own, which differ from the names
the pipeline's Supabase tables use for the same measurements:
`start_speed` is release velocity, `launch_speed` is exit velocity, and a pitch
has no single id — its natural key is (game_pk, at_bat_index, pitch_number).
"""

from __future__ import annotations

from typing import Any

import pandas as pd
from utils.duckdb_conn import query_df, read_parquet_expr
from utils.r2 import KEY_COLUMNS, columns

# The event timestamp of each dataset, used to order "latest records" and to
# report how fresh the warehouse is.
TIMESTAMP_COLUMN: dict[str, str] = {
    "pitches": "pitch_ts",
    "at_bats": "end_ts",
    "games": "start_ts",
}

# Rows shown by the latest-records section.
LATEST_LIMIT = 100

# Histogram ranges, in the units of each column: (low, high, bins). Fixed
# rather than derived from min/max so each histogram costs one pass instead of
# two, and so the axes stay put between refreshes — a distribution that shifts
# is the signal, and a rescaling axis hides it. Values outside a range land in
# the edge bin; the ranges are wide enough that this is rare and visible.
HISTOGRAMS: dict[str, tuple[float, float, int]] = {
    "start_speed": (55.0, 105.0, 50),  # mph, release velocity
    "spin_rate": (500.0, 3500.0, 60),  # rpm
    "launch_angle": (-90.0, 90.0, 60),  # degrees, balls in play only
    "launch_speed": (10.0, 125.0, 46),  # mph, exit velocity
}

# Means compared between the latest day and the rest of the window.
DRIFT_METRICS: tuple[str, ...] = ("start_speed", "spin_rate", "launch_speed")

# Rules a valid feed cannot break. Each is a boolean SQL predicate counted on
# the latest day and across the baseline window; a non-zero count is a defect,
# not a matter of degree.
#
# The count rules encode the warehouse's own convention: `balls`/`strikes` are
# PRE-pitch here (the count the pitcher faced), so 4 balls or 3 strikes cannot
# appear — unlike the Supabase `pitches` table, which stores post-pitch counts
# and legitimately holds both. The physics bounds are wide enough that a real
# outlier pitch does not trip them; they exist to catch unit changes and
# sentinel values, not unusual baseball.
VIOLATION_RULES: dict[str, dict[str, str]] = {
    "pitches": {
        "balls outside 0-3": "balls < 0 or balls > 3",
        "strikes outside 0-2": "strikes < 0 or strikes > 2",
        "outs outside 0-2": "outs < 0 or outs > 2",
        "inning < 1": "inning < 1",
        "pitch_number < 1": "pitch_number < 1",
        "start_speed outside 40-110": (
            "start_speed is not null and (start_speed < 40 or start_speed > 110)"
        ),
        "spin_rate above 4000": "spin_rate is not null and spin_rate > 4000",
        "launch_speed above 125": ("launch_speed is not null and launch_speed > 125"),
        "pitch_ts off game_date": (
            "pitch_ts is not null and "
            "abs(date_diff('day', game_date, cast(pitch_ts as date))) > 1"
        ),
        "null natural key": (
            "game_pk is null or at_bat_index is null or pitch_number is null"
        ),
    },
    "at_bats": {
        "pitch_count < 1": "pitch_count < 1",
        "inning < 1": "inning < 1",
        "rbi outside 0-4": "rbi is not null and (rbi < 0 or rbi > 4)",
        "end before start": (
            "start_ts is not null and end_ts is not null and end_ts < start_ts"
        ),
        "null natural key": "game_pk is null or at_bat_index is null",
    },
    "games": {
        "negative score": "home_score < 0 or away_score < 0",
        "season off game_date": "season <> cast(year(game_date) as integer)",
        "temp_f outside 0-130": ("temp_f is not null and (temp_f < 0 or temp_f > 130)"),
        "attendance negative": "attendance is not null and attendance < 0",
        "null natural key": "game_pk is null",
    },
}

# Low-cardinality columns whose value set is a contract with the feed. A value
# that appears or disappears is a feed or flattener change, and is the earliest
# warning either gives.
CATEGORY_COLUMNS: dict[str, tuple[str, ...]] = {
    "pitches": ("pitch_type", "result_category", "men_on_base"),
    "at_bats": ("result", "event", "men_on_base"),
    "games": ("game_type", "status"),
}


# Splits a scan window into the day under inspection and everything before it,
# so "is today different?" costs one scan rather than two. Every query that uses
# it takes the day as a `?` parameter, once per appearance.
_SERIES_CASE = "case when game_date = cast(? as date) then 'latest' else 'baseline' end"


def _source(uris: list[str]) -> str:
    return read_parquet_expr(uris)


def missing_counts(
    con: Any, uris: list[str], dataset: str
) -> tuple[int, dict[str, int]]:
    """Row total and non-null count per column, in a single scan.

    Returns `(total_rows, {column: non_null})`; the caller turns that into
    rates. `count(col)` ignores nulls, which is the whole measurement.
    """
    cols = columns(dataset)
    projections = ", ".join(f'count("{c}") as "{c}"' for c in cols)
    sql = f'select count(*) as "__total", {projections} from {_source(uris)}'
    row = query_df(con, sql).iloc[0]
    total = int(row["__total"])
    return total, {c: int(row[c]) for c in cols}


def missing_counts_split(
    con: Any, uris: list[str], dataset: str, latest_day: str
) -> pd.DataFrame:
    """Null rate per column for the latest day and for the baseline window.

    One scan. Returns `column, latest_pct, baseline_pct, latest_rows,
    baseline_rows`. The absolute rate is rarely the question — `on_third` is 91%
    null every day by design — so what the UI reads off this is the *movement*
    between the two.
    """
    cols = columns(dataset)
    parts = [
        "count(*) filter (where series = 'latest') as __latest_rows",
        "count(*) filter (where series = 'baseline') as __baseline_rows",
    ]
    for c in cols:
        parts.append(f'count("{c}") filter (where series = \'latest\') as "L_{c}"')
        parts.append(f'count("{c}") filter (where series = \'baseline\') as "B_{c}"')
    sql = (
        f"with base as materialized ("
        f"select *, {_SERIES_CASE} as series from {_source(uris)}) "
        f"select {', '.join(parts)} from base"
    )
    row = query_df(con, sql, [latest_day]).iloc[0]

    latest_rows = int(row["__latest_rows"])
    baseline_rows = int(row["__baseline_rows"])
    records = []
    for c in cols:
        latest_present = int(row[f"L_{c}"])
        baseline_present = int(row[f"B_{c}"])
        records.append(
            {
                "column": c,
                "latest_pct": (
                    100.0 * (latest_rows - latest_present) / latest_rows
                    if latest_rows
                    else 0.0
                ),
                "baseline_pct": (
                    100.0 * (baseline_rows - baseline_present) / baseline_rows
                    if baseline_rows
                    else 0.0
                ),
                "latest_rows": latest_rows,
                "baseline_rows": baseline_rows,
            }
        )
    return pd.DataFrame(
        records,
        columns=[
            "column",
            "latest_pct",
            "baseline_pct",
            "latest_rows",
            "baseline_rows",
        ],
    )


def duplicate_keys(con: Any, uris: list[str], dataset: str) -> tuple[int, int]:
    """Rows and distinct natural keys for a dataset: `(rows, distinct_keys)`.

    The natural keys are the ones the export checksum is built from
    (`warehouse.config.KEY_COLUMNS`) — (game_pk, at_bat_index, pitch_number)
    for pitches, game_pk for games. Any excess of rows over distinct keys means
    a day was written twice or a game was ingested under two files.
    """
    keys = KEY_COLUMNS[dataset]
    projection = ", ".join(f'"{k}"' for k in keys)
    sql = f"""
        with k as materialized (select {projection} from {_source(uris)})
        select
            (select count(*) from k) as rows,
            (select count(*) from (select distinct * from k)) as distinct_keys
    """
    row = query_df(con, sql).iloc[0]
    return int(row["rows"]), int(row["distinct_keys"])


def latest_records(
    con: Any, uris: list[str], dataset: str, limit: int = LATEST_LIMIT
) -> pd.DataFrame:
    """The newest `limit` rows, ordered by the dataset's event timestamp.

    Handed the newest file only, so this reads one day of Parquet however wide
    the scan window is set.
    """
    ts = TIMESTAMP_COLUMN[dataset]
    sql = (
        f"select * from {_source(uris)} "
        f'order by "{ts}" desc nulls last limit {int(limit)}'
    )
    return query_df(con, sql)


def latest_timestamp(con: Any, uris: list[str], dataset: str) -> pd.Timestamp | None:
    """The most recent event timestamp present — how fresh the data itself is.

    Distinct from a file's `ingested_at`: a file written five minutes ago can
    still hold yesterday's games.
    """
    ts = TIMESTAMP_COLUMN[dataset]
    sql = f'select max("{ts}") as latest from {_source(uris)}'
    value = query_df(con, sql).iloc[0]["latest"]
    return None if pd.isna(value) else pd.Timestamp(value)


def distributions(con: Any, uris: list[str], latest_day: str) -> pd.DataFrame:
    """Binned counts for every column in `HISTOGRAMS`, in one scan.

    Returns long form — `metric, series, bin_start, bin_end, count` — where
    `series` is `latest` (the day under inspection) or `baseline` (the rest of
    the window). Both come back from the same scan so the overlay costs no more
    than the single histogram did, and the caller plots bars it was given rather
    than binning raw observations client side.
    """
    metrics = list(HISTOGRAMS)
    projection = ", ".join(f'"{m}"' for m in metrics)
    unpivot = " union all ".join(
        f"select '{m}' as metric, cast(\"{m}\" as double) as v, series from base"
        for m in metrics
    )
    spec = ", ".join(
        f"('{m}', {lo}, {hi}, {bins})" for m, (lo, hi, bins) in HISTOGRAMS.items()
    )
    sql = f"""
        with base as materialized (
            select {projection}, {_SERIES_CASE} as series from {_source(uris)}
        ),
        long as ({unpivot}),
        spec(metric, lo, hi, bins) as (values {spec}),
        bucketed as (
            select
                l.metric,
                l.series,
                s.lo as lo,
                s.hi as hi,
                s.bins as bins,
                least(
                    greatest(
                        cast(floor((l.v - s.lo) / ((s.hi - s.lo) / s.bins))
                             as integer),
                        0),
                    s.bins - 1) as idx
            from long l
            join spec s on s.metric = l.metric
            where l.v is not null
        )
        select
            metric,
            series,
            lo + idx * (hi - lo) / bins as bin_start,
            lo + (idx + 1) * (hi - lo) / bins as bin_end,
            count(*) as count
        from bucketed
        group by metric, series, lo, hi, bins, idx
        order by metric, series, bin_start
    """
    return query_df(con, sql, [latest_day])


def distribution_stats(con: Any, uris: list[str], latest_day: str) -> pd.DataFrame:
    """Robust distribution statistics per metric, latest day vs baseline.

    Returns `metric, series, n, nulls, null_pct, p05, median, p95, spread`.

    `spread` is the interquartile range divided by 1.349 — a robust estimate of
    the standard deviation that needs only one pass, where a true MAD would need
    two. It is what `metrics.metric_drift` measures a shift in, because a 1 mph
    move means something different for release velocity than for exit velocity
    and a percentage alone does not say which.
    """
    parts = []
    for m in DRIFT_METRICS + tuple(k for k in HISTOGRAMS if k not in DRIFT_METRICS):
        parts.append(f"""select
                '{m}' as metric,
                {_SERIES_CASE} as series,
                count("{m}") as n,
                count(*) - count("{m}") as nulls,
                100.0 * (count(*) - count("{m}")) / nullif(count(*), 0)
                    as null_pct,
                quantile_cont("{m}", 0.05) as p05,
                quantile_cont("{m}", 0.50) as median,
                quantile_cont("{m}", 0.95) as p95,
                (quantile_cont("{m}", 0.75) - quantile_cont("{m}", 0.25))
                    / 1.349 as spread
            from src group by series""")
    sql = (
        f"with src as materialized (select * from {_source(uris)}) "
        + " union all ".join(parts)
        + " order by metric, series"
    )
    return query_df(con, sql, [latest_day] * len(parts))


def value_violations(
    con: Any, uris: list[str], dataset: str, latest_day: str
) -> pd.DataFrame:
    """Counts of impossible values, latest day against the baseline window.

    One scan for every rule in `VIOLATION_RULES`. Returns `rule, latest,
    baseline, baseline_days` — the baseline count is shown alongside because a
    rule that has always fired is a known modelling gap, while one that fires
    for the first time today is tonight's regression.
    """
    rules = VIOLATION_RULES.get(dataset, {})
    if not rules:
        return pd.DataFrame(
            columns=["rule", "latest", "baseline", "latest_rows", "baseline_rows"]
        )

    parts = [
        "count(*) filter (where game_date = cast(? as date)) as latest_rows",
        "count(*) filter (where game_date < cast(? as date)) as baseline_rows",
    ]
    params: list[Any] = [latest_day, latest_day]
    for i, predicate in enumerate(rules.values()):
        parts.append(
            f"count(*) filter (where ({predicate}) "
            f"and game_date = cast(? as date)) as latest_{i}"
        )
        params.append(latest_day)
        parts.append(
            f"count(*) filter (where ({predicate}) "
            f"and game_date < cast(? as date)) as base_{i}"
        )
        params.append(latest_day)

    sql = f"select {', '.join(parts)} from {_source(uris)}"
    row = query_df(con, sql, params).iloc[0]
    return pd.DataFrame(
        [
            {
                "rule": name,
                "latest": int(row[f"latest_{i}"]),
                "baseline": int(row[f"base_{i}"]),
                "latest_rows": int(row["latest_rows"]),
                "baseline_rows": int(row["baseline_rows"]),
            }
            for i, name in enumerate(rules)
        ]
    )


def category_counts(
    con: Any, uris: list[str], dataset: str, latest_day: str
) -> pd.DataFrame:
    """Value counts for the low-cardinality columns, latest day vs baseline.

    One scan. The caller diffs the two value sets; a value that appears or
    disappears is how a feed change or a broken mapping announces itself, well
    before it shows up in a mean.
    """
    cols = CATEGORY_COLUMNS.get(dataset, ())
    if not cols:
        return pd.DataFrame(columns=["field", "value", "latest_n", "baseline_n"])

    projection = ", ".join(f'"{c}"' for c in cols)
    parts = [f"""select
            '{c}' as field,
            coalesce(cast("{c}" as varchar), '(null)') as value,
            count(*) filter (where series = 'latest') as latest_n,
            count(*) filter (where series = 'baseline') as baseline_n
        from base group by 1, 2""" for c in cols]
    sql = (
        f"with base as materialized ("
        f"select {projection}, {_SERIES_CASE} as series from {_source(uris)}) "
        + " union all ".join(parts)
        + " order by field, value"
    )
    return query_df(con, sql, [latest_day])


def referential_gap(
    con: Any, pitch_uris: list[str], game_uris: list[str]
) -> tuple[int, int]:
    """`(orphan pitches, distinct orphan game_pk)` for the day supplied.

    An anti-join of one day's `pitches` against that same day's `games` file.
    Both are small — one day is ~4,300 pitch rows and ~15 game rows — so this is
    the cheapest integrity check in the app and the only one that crosses
    datasets.
    """
    sql = f"""
        with p as materialized (select game_pk from {_source(pitch_uris)}),
        g as materialized (select game_pk from {_source(game_uris)})
        select
            count(*) as orphans,
            count(distinct p.game_pk) as orphan_games
        from p
        where not exists (select 1 from g where g.game_pk = p.game_pk)
    """
    row = query_df(con, sql).iloc[0]
    return int(row["orphans"]), int(row["orphan_games"])
