"""Contact quality: P(hit) and P(home run) given how a ball was struck.

The in-house xBA / xHR. Savant's `estimated_ba_using_speedangle` is itself a
lookup on exit velocity and launch angle; we hold 11 seasons of both plus the
realised outcome, so this is fitted from our own data rather than scraped --
and can therefore carry spray, which the two-variable version cannot.

WHAT THE NUMBERS ARE CONDITIONAL ON. Every rate here is per BALL IN PLAY.
Strikeouts and walks are not in the denominator. A per-plate-appearance figure
is this multiplied by P(ball in play), and conflating the two would overstate
a hitter by roughly a third.

THE THREE DERIVATIONS, each checked against the feed rather than assumed:

  spray angle   degrees(atan2(x - 125.42, 198.27 - y)), negative toward the
                left-field line. Validated against `hit_location`, the fielder
                who took the ball, over 842 batted balls:

                    3B -35.2   LF -29.3   SS -15.8   CF +1.1
                    2B +22.3   RF +30.8   1B +48.8

                Monotonic left to right, and centre field lands at +1.1, which
                is the calibration check on the origin constants.

  pull angle    spray flipped for right-handed batters, so positive is always
                "toward this batter's pull side". Measured: home runs average
                +16.1 degrees against +4.2 for all batted balls.

  outcome       `at_bats.result_detail` joined on (game_pk, at_bat_index). A
                ball in play ends the plate appearance -- fouls classify as
                `strike_foul`, not `in_play` -- so the join is one-to-one.

Sanity of the resulting surface, measured over 1,535 batted balls:

    LA <0    P(hit) 0.142   P(HR) 0.000      EV  80-95   P(HR) 0.000
    LA 10-20 P(hit) 0.646   P(HR) 0.013      EV  95-100  P(HR) 0.162
    LA 20-30 P(hit) 0.447   P(HR) 0.169      EV 100-105  P(HR) 0.349
    LA 40+   P(hit) 0.049   P(HR) 0.008      EV 105-120  P(HR) 0.690
                                             (LA 20-40 only)
"""

from __future__ import annotations

# Gameday field-coordinate origin. These are the constants the spray formula
# is calibrated on; the centre-field mean of +1.1 degrees above is what says
# they are right for this feed.
HOME_X = 125.42
HOME_Y = 198.27

# Bucket widths, in each feature's own units. Chosen against the measured
# steepness of the surface: P(HR) moves from 0.16 to 0.69 across 10 mph, so
# exit velocity needs a finer step than spray, which moves slowly.
EV_STEP = 2
LA_STEP = 5
PULL_STEP = 15

# Clamps. Beyond these the sample is too thin to bucket and the physics stops
# mattering: nothing leaves the bat at 130 mph, and a 70-degree pop-up is an
# out whichever exact degree it was.
EV_MIN, EV_MAX = 40, 120
LA_MIN, LA_MAX = -60, 60
PULL_MIN, PULL_MAX = -60, 60

# A fine-grained cell below this is not emitted; the consumer falls back to the
# `ev_la` grain. Mirrors the >= 25 observation floor used for context cells.
MIN_OBS = 25

# launch_speed covers 87% of balls in play in 2015 and does not pass 99% until
# 2020, so a pre-2017 cell measures tracking coverage rather than contact.
STATCAST_FLOOR = 2017

_HIT = "('single','double','triple','home_run')"

# Pull / centre / oppo threshold, in degrees either side of straightaway.
# Shared with warehouse.aggregates so `pull_rate` there and `pull_bucket` here
# describe the same ball.
PULL_DEG = 15

# Exit velocity at or above which a ball counts as hard hit. The standard
# threshold, and distinct from `barrel`, which also constrains launch angle.
# Lives here rather than in aggregates because the modeling form spines need
# it too, and a hard-hit rate that means one thing on a profile page and
# another in a feature is worse than not having one.
HARD_HIT_MPH = 95


def spray_sql(prefix: str = "") -> str:
    """SQL for spray angle, negative toward the left-field line.

    Exported so every consumer derives it from ONE set of origin constants.
    It was briefly written out in three places -- here, the display aggregates
    and the modeling spines -- which is three chances for a later correction
    to land in two of them.

    `prefix` qualifies the columns for a joined query, e.g. `"p."`.
    """
    return (f"degrees(atan2({prefix}hit_coord_x - {HOME_X}, "
            f"{HOME_Y} - {prefix}hit_coord_y))")


def pull_sql(prefix: str = "") -> str:
    """Spray flipped for right-handers, so positive is always "pulled".

    The flip is what makes any pull statistic comparable across handedness:
    without it the same physical ball counts as pulled for one side and
    opposite-field for the other, and every cell carries half the sample it
    should.
    """
    s = spray_sql(prefix)
    return f"(case when {prefix}bat_side = 'R' then -({s}) else {s} end)"


def _bucket(expr: str, step: int, lo: int, hi: int) -> str:
    """Clamp, then floor to the bucket's lower edge in the feature's own units.

    Integer division is explicit. DuckDB's `/` is float division, which would
    silently produce a fractional bucket and one row per distinct fraction --
    the same trap `aggregates.BUCKET` calls out.
    """
    clamped = f"least(greatest({expr}, {lo}), {hi})"
    return f"cast(floor({clamped} / {step}) as integer) * {step}"


def _base_sql(season_floor: int) -> str:
    """Balls in play, joined to their outcome, with spray and pull derived."""
    return f"""
    select
        p.launch_speed                                           as ev,
        p.launch_angle                                           as la,
        {spray_sql("p.")}                                        as spray,
        p.bat_side,
        a.result_detail
    from pitches p
    join at_bats a
      on a.game_pk = p.game_pk and a.at_bat_index = p.at_bat_index
    where p.result_category = 'in_play'
      and p.launch_speed is not null
      and p.launch_angle is not null
      and a.result_detail is not null
      and cast(year(p.game_date) as integer) >= {season_floor}
    """


def contact_quality_sql(season_floor: int = STATCAST_FLOOR) -> str:
    """Both grains, unioned, with counts kept beside the rates.

    `ev_la` is emitted unconditionally and `ev_la_pull` only where the sample
    clears MIN_OBS, so a consumer that cannot find a fine cell has a coarse one
    to fall back to by construction rather than by luck.
    """
    ev_b = _bucket("ev", EV_STEP, EV_MIN, EV_MAX)
    la_b = _bucket("la", LA_STEP, LA_MIN, LA_MAX)
    pull_b = _bucket("pull_angle", PULL_STEP, PULL_MIN, PULL_MAX)

    # Counted once, reused by both grains.
    agg = f"""
        count(*)                                                  as n,
        count(*) filter (where result_detail in {_HIT})           as hits,
        count(*) filter (where result_detail = 'home_run')        as hr,
        count(*) filter (where result_detail in
                         ('double','triple','home_run'))          as xbh,
        count(*) filter (where result_detail = 'single')
            + 2 * count(*) filter (where result_detail = 'double')
            + 3 * count(*) filter (where result_detail = 'triple')
            + 4 * count(*) filter (where result_detail = 'home_run')
                                                                  as total_bases
    """
    rates = """
        round(hits        / nullif(n, 0), 4)  as p_hit,
        round(hr          / nullif(n, 0), 4)  as p_hr,
        round(xbh         / nullif(n, 0), 4)  as p_xbh,
        round(total_bases / nullif(n, 0), 4)  as xtb
    """
    return f"""
    with bip as ({_base_sql(season_floor)}),
    pulled as (
        select *,
               -- Flip for right-handers so positive is always "pulled".
               case when bat_side = 'R' then -spray else spray end as pull_angle
          from bip
    ),
    fine as (
        select {ev_b} as ev_bucket, {la_b} as la_bucket,
               {pull_b} as pull_bucket, {agg}
          from pulled
         where spray is not null
         group by 1, 2, 3
        having count(*) >= {MIN_OBS}
    ),
    coarse as (
        select {ev_b} as ev_bucket, {la_b} as la_bucket,
               cast(null as integer) as pull_bucket, {agg}
          from pulled
         group by 1, 2, 3
    ),
    -- Not named `both`: that is a reserved word in DuckDB (TRIM(BOTH ...))
    -- and fails with a bare "syntax error at or near" pointing at the CTE.
    unioned as (
        select 'ev_la_pull' as grain, * from fine
        union all
        select 'ev_la'      as grain, * from coarse
    )
    select grain, ev_bucket, la_bucket, pull_bucket,
           {season_floor} as season_floor,
           n, hits, hr, xbh, total_bases,
           {rates}
      from unioned
     order by grain, ev_bucket, la_bucket, pull_bucket
    """


def build(con, season_floor: int = STATCAST_FLOOR):  # noqa: ANN001
    """Run the build against a connection with `pitches` and `at_bats` views."""
    return con.execute(contact_quality_sql(season_floor)).fetch_arrow_table()


def lookup(rows: list[dict], ev: float | None, la: float | None,
           pull_angle: float | None) -> dict | None:
    """Resolve one batted ball against a built table, fine grain first.

    Pure Python and index-free on purpose: this is the reference implementation
    the backing-off rule is defined by, and the shape a consumer should copy.
    Anything scoring millions of rows should build a dict keyed the same way.
    """
    if ev is None or la is None:
        return None

    def edge(v, step, lo, hi):
        return int((min(max(v, lo), hi)) // step) * step

    ev_b = edge(ev, EV_STEP, EV_MIN, EV_MAX)
    la_b = edge(la, LA_STEP, LA_MIN, LA_MAX)
    if pull_angle is not None:
        pull_b = edge(pull_angle, PULL_STEP, PULL_MIN, PULL_MAX)
        for r in rows:
            if (r["grain"] == "ev_la_pull" and r["ev_bucket"] == ev_b
                    and r["la_bucket"] == la_b and r["pull_bucket"] == pull_b):
                return r
    for r in rows:
        if (r["grain"] == "ev_la" and r["ev_bucket"] == ev_b
                and r["la_bucket"] == la_b):
            return r
    return None
