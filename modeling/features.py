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

Nothing here writes to R2. Caches are local.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

from warehouse import contact as _contact
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


# ── the leakage rule ────────────────────────────────────────────────────────
#
#   range between ... and interval 1 day preceding
#
# The upper bound is EXCLUSIVE of the current day. A window ending at
# `current row` would include the game being predicted, and a model trained on
# that validates beautifully and is worthless live.
#
# It lives in ONE string, used by every spine, because there are now four of
# them across two subject keys. The previous layout wrote the clauses out per
# spine and relied on a test comparing the two texts to keep them honest --
# which worked at two and does not scale: a fifth spine that simply forgot to
# match would pass. Generating them removes the opportunity rather than
# policing it. tests/modeling/test_features.py still asserts the bound, now
# per spine.
LEAKAGE_BOUND = "interval 1 day preceding"


def _windows(key: str) -> str:
    """The three trailing windows, partitioned by `key`.

    `key` is the subject of the form measurement -- pitcher_id for how a
    pitcher has been throwing, batter_id for how a batter has been hitting.
    Everything else about the three windows is identical by construction.
    """
    return f"""
window
    w_career as (partition by {key} order by game_date
                 range between unbounded preceding
                           and {LEAKAGE_BOUND}),
    w_d30    as (partition by {key} order by game_date
                 range between interval 30 days preceding
                           and {LEAKAGE_BOUND}),
    w_d90    as (partition by {key} order by game_date
                 range between interval 90 days preceding
                           and {LEAKAGE_BOUND})
"""


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
""" + _windows("pitcher_id")


def _build_spine(store, con, *, dataset: str, view_sql: str, table: str,
                 sql: str, seasons=None) -> tuple[Path, ScanStats]:
    """Scan one dataset, materialize one form spine, cache it locally.

    Factored out when the batter spines landed and there were four of these.
    Each still carries its OWN projection rather than reusing _DATASET_VIEWS:
    a spine reads two or three columns where a cell build reads twenty, and
    widening the spine scans to match would be a real cost on the hot path for
    no gain.
    """
    own_con = con is None
    con = con or duck.connect(store)
    try:
        uris = duck.uris(store, dataset, seasons)
        if not uris:
            raise RuntimeError(
                f"manifest returned no {dataset} files -- check R2_BUCKET is "
                f"'pitch-hawk-warehouse' (the typo'd value fails silently)")
        t0 = time.time()
        con.execute(f"create or replace view {dataset} as {view_sql} "
                    f"from {_read_parquet(uris)}")
        con.execute(f"create or replace table {table} as {sql}")
        rows = con.execute(f"select count(*) from {table}").fetchone()[0]
        out = cache_root() / f"{table}.parquet"
        out.parent.mkdir(parents=True, exist_ok=True)
        con.execute(f"copy {table} to {_sql_str(str(out))} (format parquet)")
        stats = ScanStats(files=len(uris), rows=rows, seconds=time.time() - t0)
        print(f"[modeling] {table}: {stats}")
        return out, stats
    finally:
        if own_con:
            con.close()


def build_form_spine(store, *, seasons=None, con=None) -> tuple[Path, ScanStats]:
    """Materialize the (pitcher, day) form spine to local Parquet."""
    return _build_spine(
        store, con, dataset="pitches", table="form_spine",
        sql=FORM_SPINE_SQL, seasons=seasons,
        view_sql="select pitcher_id, game_date, start_speed, "
                 "       case when zone between 1 and 9 then 1 else 0 end "
                 "       as in_zone")


# The plate-appearance spine. Structurally identical to FORM_SPINE_SQL and
# sharing its window clauses through _windows(), so the exclusive bound cannot
# be relaxed in one spine and not the others.
FORM_SPINE_AB_SQL = """
with daily as (
    select
        pitcher_id,
        game_date,
        count(*)                                                  as n,
        avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate,
        -- Added 2026-09 for the batter markets, which need the pitcher's
        -- side of the same outcome. Additive: ab_result selects k_rate by
        -- name and is untouched by the extra columns.
        avg(case when result = 'hit'       then 1.0 else 0.0 end) as hit_rate,
        avg(case when result_detail = 'home_run' then 1.0 else 0.0 end) as hr_rate
    from at_bats
    group by 1, 2
)
select
    pitcher_id,
    game_date,
    coalesce(sum(n) over w_career, 0)                                 as career_n,
    sum(k_rate   * n) over w_career / nullif(sum(n) over w_career, 0) as career_k_rate,
    sum(hit_rate * n) over w_career / nullif(sum(n) over w_career, 0) as career_hit_rate,
    sum(hr_rate  * n) over w_career / nullif(sum(n) over w_career, 0) as career_hr_rate,
    coalesce(sum(n) over w_d30, 0)                                    as d30_n,
    sum(k_rate   * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_k_rate,
    sum(hit_rate * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_hit_rate,
    sum(hr_rate  * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_hr_rate,
    coalesce(sum(n) over w_d90, 0)                                    as d90_n,
    sum(k_rate   * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_k_rate,
    sum(hit_rate * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_hit_rate,
    sum(hr_rate  * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_hr_rate
from daily
""" + _windows("pitcher_id")


def build_form_spine_ab(store, *, seasons=None, con=None) -> tuple[Path, ScanStats]:
    """Materialize the (pitcher, day) plate-appearance form spine."""
    return _build_spine(
        store, con, dataset="at_bats", table="form_spine_ab",
        sql=FORM_SPINE_AB_SQL, seasons=seasons,
        view_sql="select game_pk, at_bat_index, pitcher_id, batter_id, "
                 "       game_date, result, result_detail, pitch_count")


# ── batter spines ───────────────────────────────────────────────────────────
#
# Both spines above partition by pitcher_id. Every market so far has been
# pitcher-facing, so "form" has only ever meant how the pitcher has been
# throwing -- which is why `_design` folded every batter feature into the
# intercept as zero and nobody noticed a gap.
#
# A batter market needs the other half. These two are the mirror image of the
# pitcher pair, keyed on batter_id, sharing the same _windows() and therefore
# the same exclusive leakage bound.

FORM_SPINE_BAT_AB_SQL = """
with daily as (
    select
        batter_id,
        game_date,
        count(*)                                                  as n,
        avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate,
        avg(case when result = 'walk'      then 1.0 else 0.0 end) as bb_rate,
        avg(case when result = 'hit'       then 1.0 else 0.0 end) as hit_rate,
        -- result_detail, not result: `result` collapses single/double/triple/
        -- home_run into one `hit` bucket, so a home-run rate is unreachable
        -- from it. This is the whole reason result_detail joined the
        -- projection above.
        avg(case when result_detail = 'home_run' then 1.0 else 0.0 end) as hr_rate
    from at_bats
    where batter_id is not null
    group by 1, 2
)
select
    batter_id,
    game_date,
    coalesce(sum(n) over w_career, 0)                                 as career_n,
    sum(k_rate   * n) over w_career / nullif(sum(n) over w_career, 0) as career_k_rate,
    sum(bb_rate  * n) over w_career / nullif(sum(n) over w_career, 0) as career_bb_rate,
    sum(hit_rate * n) over w_career / nullif(sum(n) over w_career, 0) as career_hit_rate,
    sum(hr_rate  * n) over w_career / nullif(sum(n) over w_career, 0) as career_hr_rate,
    coalesce(sum(n) over w_d30, 0)                                    as d30_n,
    sum(k_rate   * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_k_rate,
    sum(bb_rate  * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_bb_rate,
    sum(hit_rate * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_hit_rate,
    sum(hr_rate  * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_hr_rate,
    coalesce(sum(n) over w_d90, 0)                                    as d90_n,
    sum(k_rate   * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_k_rate,
    sum(bb_rate  * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_bb_rate,
    sum(hit_rate * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_hit_rate,
    sum(hr_rate  * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_hr_rate
from daily
""" + _windows("batter_id")


# Contact form, at pitch grain. Separate from the plate-appearance spine above
# for the same reason FORM_SPINE_SQL is separate from FORM_SPINE_AB_SQL: the
# denominators differ. Outcome rates are per plate appearance; hard-hit and
# pulled-in-the-air are per BALL IN PLAY, and a hitter who strikes out half
# the time can still scorch everything he touches.
#
# The pull formula comes from warehouse.contact so that the spray origin and
# the handedness flip are defined once, beside where they were validated.
FORM_SPINE_BAT_CONTACT_SQL = f"""
with daily as (
    select
        batter_id,
        game_date,
        count(*)                                                       as n,
        avg(case when launch_speed >= {_contact.HARD_HIT_MPH}
                 then 1.0 else 0.0 end)                                as hard_hit_rate,
        avg(case when {_contact.pull_sql()} > {_contact.PULL_DEG}
                  and (trajectory like '%fly%' or trajectory like '%line%')
                 then 1.0 else 0.0 end)                                as pull_air_rate,
        avg(launch_speed)                                              as exit_velo
    from pitches
    where batter_id is not null
      and result_category = 'in_play'
      and launch_speed is not null
    group by 1, 2
)
select
    batter_id,
    game_date,
    coalesce(sum(n) over w_career, 0)                                      as career_n,
    sum(hard_hit_rate * n) over w_career / nullif(sum(n) over w_career, 0) as career_hard_hit_rate,
    sum(pull_air_rate * n) over w_career / nullif(sum(n) over w_career, 0) as career_pull_air_rate,
    sum(exit_velo     * n) over w_career / nullif(sum(n) over w_career, 0) as career_exit_velo,
    coalesce(sum(n) over w_d30, 0)                                         as d30_n,
    sum(hard_hit_rate * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_hard_hit_rate,
    sum(pull_air_rate * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_pull_air_rate,
    sum(exit_velo     * n) over w_d30 / nullif(sum(n) over w_d30, 0)       as d30_exit_velo,
    coalesce(sum(n) over w_d90, 0)                                         as d90_n,
    sum(hard_hit_rate * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_hard_hit_rate,
    sum(pull_air_rate * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_pull_air_rate,
    sum(exit_velo     * n) over w_d90 / nullif(sum(n) over w_d90, 0)       as d90_exit_velo
from daily
""" + _windows("batter_id")


def build_form_spine_bat_ab(store, *, seasons=None, con=None):
    """Materialize the (batter, day) plate-appearance form spine."""
    return _build_spine(
        store, con, dataset="at_bats", table="form_spine_bat_ab",
        sql=FORM_SPINE_BAT_AB_SQL, seasons=seasons,
        view_sql="select batter_id, game_date, result, result_detail")


def build_form_spine_bat_contact(store, *, seasons=None, con=None):
    """Materialize the (batter, day) contact-quality form spine."""
    return _build_spine(
        store, con, dataset="pitches", table="form_spine_bat_contact",
        sql=FORM_SPINE_BAT_CONTACT_SQL, seasons=seasons,
        view_sql="select batter_id, game_date, result_category, bat_side, "
                 "       launch_speed, trajectory, hit_coord_x, hit_coord_y")


# Every spine, by the table name its SQL is materialized under -- which is
# also the name a cell_sql joins. `MarketSpec.spines` names entries here, and
# `python -m modeling build` materializes the union across the markets it was
# asked for. The CLI used to hardcode the two pitcher spines, which meant a
# batter market could not be built without editing the CLI.
SPINE_BUILDERS = {
    "form_spine": lambda store, **kw: build_form_spine(store, **kw),
    "form_spine_ab": lambda store, **kw: build_form_spine_ab(store, **kw),
    "form_spine_bat_ab": lambda store, **kw: build_form_spine_bat_ab(store, **kw),
    "form_spine_bat_contact":
        lambda store, **kw: build_form_spine_bat_contact(store, **kw),
}


def build_spines(store, names, *, seasons=None, con=None):
    """Materialize each named spine once, in a stable order."""
    unknown = sorted(set(names) - set(SPINE_BUILDERS))
    if unknown:
        raise ValueError(
            f"unknown spine(s) {unknown}; expected {sorted(SPINE_BUILDERS)}")
    for name in sorted(set(names)):
        SPINE_BUILDERS[name](store, seasons=seasons, con=con)


# Column projections for the R2 datasets a cell_sql may read. Narrow on
# purpose: Parquet is columnar, so naming only what the specs use keeps each
# scan reading a fraction of the file bytes.
#
# Widened 2026-09 for batter-facing markets. The narrowness is a real cost
# control, not ceremony, so this is a deliberate list rather than `select *`:
#
#   result_category      the in-play filter every batted-ball measure needs
#   launch_speed/angle   contact quality
#   trajectory           ground ball / line drive / fly ball / popup
#   hit_coord_x/y        spray, and through it pull
#   bat_side/pitch_hand  platoon, and the handedness flip pull depends on
#   result_detail        the HOME RUN label. `result` collapses every hit into
#                        one bucket, so without this no home-run market can be
#                        labelled at all.
#   men_on_base          base state, 100% populated and never yet used
#   times_through_order  among the strongest known at-bat-outcome signals
#   venue_id             the join key for park factors
#
# Anything added here is scanned on EVERY build for EVERY market, so add with
# a consumer in mind.
_DATASET_VIEWS = {
    "pitches": (
        "select game_pk, at_bat_index, pitcher_id, batter_id, game_date, "
        "       balls, strikes, start_speed, is_ball, is_in_play, "
        "       is_strike, pitch_number, result_category, "
        "       launch_speed, launch_angle, trajectory, "
        "       hit_coord_x, hit_coord_y, bat_side, pitch_hand, "
        "       men_on_base, times_through_order, "
        "       case when zone between 1 and 9 then 1 else 0 end as in_zone"
    ),
    "at_bats": (
        "select game_pk, at_bat_index, pitcher_id, batter_id, game_date, "
        "       result, result_detail, pitch_count, bat_side, pitch_hand, "
        "       men_on_base, times_through_order"
    ),
    "games": (
        "select game_pk, game_date, season, home_score, away_score, venue_id"
    ),
}


def cells_path(spec) -> Path:  # noqa: ANN001
    return cache_root() / "cells" / f"{spec.market}.parquet"


def build_cells(store, spec, *, seasons=None, con=None):  # noqa: ANN001
    """Build one market's weighted cell table. Requires form_spine in `con`."""
    own_con = con is None
    con = con or duck.connect(store)
    try:
        t0 = time.time()
        files = 0
        for dataset in spec.datasets:
            uris = duck.uris(store, dataset, seasons)
            if not uris:
                raise RuntimeError(
                    f"{spec.market}: manifest returned no {dataset} files -- "
                    f"check R2_BUCKET is 'pitch-hawk-warehouse' (the typo'd "
                    f"value fails silently)")
            files += len(uris)
            con.execute(f"create or replace view {dataset} as "
                        f"{_DATASET_VIEWS[dataset]} "
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
        stats = ScanStats(files=files, rows=rows, seconds=time.time() - t0)
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
