"""Build features from R2 Parquet into locally cached weighted cells.

Two structural decisions, both load-bearing:

1. **Rolling form is computed at (player, day) grain, not per pitch.** Window
   functions over ~1-2M player-days are cheap; over 7.9M pitches they are not.
   The result is identical because form is constant within a day by
   construction.

2. **Cells are weighted aggregates, not rows.** `cell_sql` groups by feature
   buckets and carries count(*) as n; sklearn takes n as sample_weight. For
   bucketed-feature linear and logistic models this is exact, not an
   approximation, and it collapses millions of rows to a few thousand -- which
   is what makes a 600-fit sweep finish in seconds instead of costing 30M R2
   reads.

Nothing here writes to R2. Caches are local. See docs/plans/ml-workbench-2026-08-08.md §9.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

from warehouse import duck

# Class B operations per Parquet file. The Cloudflare metrics dashboard was not
# reachable from the build host, so this stays the design-time estimate. Used
# only to report an estimate alongside each build -- never to make a decision.
EST_CLASS_B_PER_FILE = 10


def cache_root() -> Path:
    return Path(os.environ.get("PITCHHAWK_CACHE", ".cache"))


def _sql_str(value: str) -> str:
    """Single-quoted SQL literal.

    DuckDB refuses prepared parameters inside CREATE VIEW and COPY ("Unexpected
    prepared parameter. This type of statement can't be prepared!"), so the
    URI list and the output path have to be inlined. Everything passed here
    comes from the manifest or our own cache_root(), never from user input, but
    the quote-doubling is kept so that stays true if the source ever changes.
    """
    return "'" + value.replace("'", "''") + "'"


def _read_parquet(uris: list[str]) -> str:
    """`read_parquet([...])` with the file list inlined as literals."""
    return "read_parquet([" + ", ".join(_sql_str(u) for u in uris) + "])"


@dataclass(frozen=True)
class ScanStats:
    files: int
    rows: int
    seconds: float

    @property
    def est_class_b(self) -> int:
        return self.files * EST_CLASS_B_PER_FILE

    def __str__(self) -> str:
        return (f"{self.files} files, {self.rows:,} rows, {self.seconds:.1f}s, "
                f"~{self.est_class_b:,} Class B ops")


# The leakage rule lives here, in one place, in two window definitions.
#
#   range between ... and interval 1 day preceding
#
# The upper bound is EXCLUSIVE of the current day. A window ending at
# `current row` would include the game being predicted. Do not change these
# bounds without updating tests/modeling/test_features.py, which exists
# specifically to catch that edit.
FORM_SPINE_SQL = """
with daily as (
    select
        pitcher_id,
        game_date,
        count(*)                                              as n,
        avg(case when in_zone = 1 then 1.0 else 0.0 end)      as zone_rate,
        avg(start_speed)                                      as velo
    from pitches
    group by 1, 2
)
select
    pitcher_id,
    game_date,
    coalesce(sum(n) over w_career, 0)                                as career_n,
    sum(zone_rate * n) over w_career / nullif(sum(n) over w_career, 0) as career_zone_rate,
    sum(velo * n)      over w_career / nullif(sum(n) over w_career, 0) as career_velo,
    coalesce(sum(n) over w_d30, 0)                                   as d30_n,
    sum(zone_rate * n) over w_d30 / nullif(sum(n) over w_d30, 0)     as d30_zone_rate,
    sum(velo * n)      over w_d30 / nullif(sum(n) over w_d30, 0)     as d30_velo,
    coalesce(sum(n) over w_d90, 0)                                   as d90_n,
    sum(zone_rate * n) over w_d90 / nullif(sum(n) over w_d90, 0)     as d90_zone_rate,
    sum(velo * n)      over w_d90 / nullif(sum(n) over w_d90, 0)     as d90_velo
from daily
window
    w_career as (partition by pitcher_id order by game_date
                 range between unbounded preceding
                           and interval 1 day preceding),
    w_d30    as (partition by pitcher_id order by game_date
                 range between interval 30 days preceding
                           and interval 1 day preceding),
    w_d90    as (partition by pitcher_id order by game_date
                 range between interval 90 days preceding
                           and interval 1 day preceding)
"""


def build_form_spine(store, *, seasons=None, con=None) -> tuple[Path, ScanStats]:
    """Materialize the (pitcher, day) form spine to local Parquet."""
    own_con = con is None
    con = con or duck.connect(store)
    try:
        uris = duck.uris(store, "pitches", seasons)
        if not uris:
            raise RuntimeError(
                "manifest returned no pitches files -- check R2_BUCKET is "
                "'pitch-hawk-warehouse' (the typo'd value fails silently)")
        t0 = time.time()
        con.execute(
            "create or replace view pitches as "
            "select pitcher_id, game_date, start_speed, "
            "       case when zone between 1 and 9 then 1 else 0 end as in_zone "
            f"from {_read_parquet(uris)}")
        con.execute(f"create or replace table form_spine as {FORM_SPINE_SQL}")
        rows = con.execute("select count(*) from form_spine").fetchone()[0]
        out = cache_root() / "form_spine.parquet"
        out.parent.mkdir(parents=True, exist_ok=True)
        con.execute(f"copy form_spine to {_sql_str(str(out))} (format parquet)")
        stats = ScanStats(files=len(uris), rows=rows, seconds=time.time() - t0)
        print(f"[modeling] form_spine: {stats}")
        return out, stats
    finally:
        if own_con:
            con.close()


# The plate-appearance spine. Structurally identical to FORM_SPINE_SQL -- the
# window clauses are copied verbatim, including the exclusive
# `interval 1 day preceding` bound. tests/modeling/test_features.py asserts the
# two agree clause for clause, so relaxing the bound in one and not the other
# cannot slip through.
FORM_SPINE_AB_SQL = """
with daily as (
    select
        pitcher_id,
        game_date,
        count(*)                                                  as n,
        avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate
    from at_bats
    group by 1, 2
)
select
    pitcher_id,
    game_date,
    coalesce(sum(n) over w_career, 0)                                as career_n,
    sum(k_rate * n) over w_career / nullif(sum(n) over w_career, 0)  as career_k_rate,
    coalesce(sum(n) over w_d30, 0)                                   as d30_n,
    sum(k_rate * n) over w_d30 / nullif(sum(n) over w_d30, 0)        as d30_k_rate,
    coalesce(sum(n) over w_d90, 0)                                   as d90_n,
    sum(k_rate * n) over w_d90 / nullif(sum(n) over w_d90, 0)        as d90_k_rate
from daily
window
    w_career as (partition by pitcher_id order by game_date
                 range between unbounded preceding
                           and interval 1 day preceding),
    w_d30    as (partition by pitcher_id order by game_date
                 range between interval 30 days preceding
                           and interval 1 day preceding),
    w_d90    as (partition by pitcher_id order by game_date
                 range between interval 90 days preceding
                           and interval 1 day preceding)
"""


def build_form_spine_ab(store, *, seasons=None, con=None) -> tuple[Path, ScanStats]:
    """Materialize the (pitcher, day) plate-appearance form spine."""
    own_con = con is None
    con = con or duck.connect(store)
    try:
        uris = duck.uris(store, "at_bats", seasons)
        if not uris:
            raise RuntimeError(
                "manifest returned no at_bats files -- check R2_BUCKET is "
                "'pitch-hawk-warehouse' (the typo'd value fails silently)")
        t0 = time.time()
        con.execute(
            "create or replace view at_bats as "
            "select pitcher_id, batter_id, game_date, result, pitch_count "
            f"from {_read_parquet(uris)}")
        con.execute(
            f"create or replace table form_spine_ab as {FORM_SPINE_AB_SQL}")
        rows = con.execute("select count(*) from form_spine_ab").fetchone()[0]
        out = cache_root() / "form_spine_ab.parquet"
        out.parent.mkdir(parents=True, exist_ok=True)
        con.execute(f"copy form_spine_ab to {_sql_str(str(out))} (format parquet)")
        stats = ScanStats(files=len(uris), rows=rows, seconds=time.time() - t0)
        print(f"[modeling] form_spine_ab: {stats}")
        return out, stats
    finally:
        if own_con:
            con.close()


def cells_path(spec) -> Path:  # noqa: ANN001
    return cache_root() / "cells" / f"{spec.market}.parquet"


def build_cells(store, spec, *, seasons=None, con=None):  # noqa: ANN001
    """Build one market's weighted cell table. Requires form_spine in `con`."""
    own_con = con is None
    con = con or duck.connect(store)
    try:
        uris = duck.uris(store, "pitches", seasons)
        t0 = time.time()
        con.execute(
            "create or replace view pitches as "
            "select pitcher_id, batter_id, game_date, balls, strikes, "
            "       start_speed, is_ball, is_in_play, is_strike, pitch_number, "
            "       case when zone between 1 and 9 then 1 else 0 end as in_zone "
            f"from {_read_parquet(uris)}")
        con.execute(f"create or replace table cells as {spec.cell_sql}")
        rows = con.execute("select count(*) from cells").fetchone()[0]
        if rows == 0:
            raise RuntimeError(
                f"{spec.market}: cell table is EMPTY. Refusing to continue -- a "
                f"silent partial train is exactly what froze the v1 trainer. "
                f"Check the SQL and the form_spine join.")
        out = cells_path(spec)
        out.parent.mkdir(parents=True, exist_ok=True)
        con.execute(f"copy cells to {_sql_str(str(out))} (format parquet)")
        stats = ScanStats(files=len(uris), rows=rows, seconds=time.time() - t0)
        print(f"[modeling] cells[{spec.market}]: {stats}")
        return out, stats
    finally:
        if own_con:
            con.close()


def load_cells(spec, seasons=None):  # noqa: ANN001
    """Read a cached cell table. Never touches R2."""
    import duckdb

    path = cells_path(spec)
    if not path.exists():
        raise FileNotFoundError(
            f"no cell cache for {spec.market} at {path}. "
            f"Run: python -m modeling build --market {spec.market}")
    con = duckdb.connect()
    q = "select * from read_parquet(?)"
    args = [str(path)]
    if seasons:
        q += " where season in (" + ",".join(str(int(s)) for s in seasons) + ")"
    return con.execute(q, args).df()
