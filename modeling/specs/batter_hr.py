"""batter_hr -- P(home run) for a plate appearance.

The first BATTER-facing market. The five before it all ask what a pitcher will
do; this asks what a hitter will do to him, which is why it needed the engine
to carry two form dimensions at once (docs/MODELS.md, "Declaring features").

TWO CLASSES, not four. `multinomial_logistic` with two classes IS a binary
logistic and model.ts already scores that branch, so this needs no new family
and no new scorer path. The classes are ("home_run", "other").

RARE POSITIVE CLASS. Home runs are ~3.2% of plate appearances (measured: 283
in 8,855 across 117 games in 2025). Two consequences that are not optional:

  * Gate on LOG LOSS and calibration, never accuracy. A model that answers
    "no" every time is 96.8% accurate and worth nothing. `primary_metric` is
    logloss for exactly this reason.
  * MIN_OBS is higher than the pitcher markets use. A cell of 25 plate
    appearances contains on average less than one home run, so its rate is
    0 or 0.04 and carries no information. 200 puts ~6 in the average cell.

    It is passed as `min_cell_obs` and NOT as a `having` on CELL_SQL. The
    query groups by all three form windows on both sides, which is a grid
    three times finer than the one `_design` fits on -- median cell size 1 --
    so a threshold applied there measured the wrong denominator and kept 21
    cells, 9,170 of 1,324,509 plate appearances, all from 2019.
    fit.collapse_to_window regroups onto the selected window first, where the
    same 200 keeps 81.5%.

WHY THESE FEATURES AND NOT THE OBVIOUS ONES. Contact quality -- hard-hit rate,
pulled-fly rate -- is the better predictor and the warehouse now computes it
(`contact_quality`, `batted_ball_profile`, and FORM_SPINE_BAT_CONTACT_SQL
here). It is deliberately NOT used yet: `model.ts` reads batter features from
`batter_rolling_stats`, which is refreshed from the LIVE `pitches` table, and
the live table has no `launch_speed`. A feature with no serving source trains
as a real coefficient and scores 0.0 in production -- which is precisely the
`pitcher_bb_delta` defect this spec layer now refuses to let happen quietly.

So this v1 uses only what production can actually read: home-run rates for
both sides, and the platoon. Adding contact quality means giving it a serving
path first -- either the live rolling stats or a read of the published
aggregates from `live-poll`.
"""

from __future__ import annotations

from modeling.spec import FormFeature, MarketSpec

# Home runs per plate appearance. MUST equal LEAGUE.hr_rate in model.ts and
# LEAGUE["hr_rate"] in modeling/score.py: training and serving have to centre
# the feature identically, or the shipped coefficients meet a
# differently-scaled input in production.
HR_BASELINE = 0.032

# Bucket widths, in each feature's own units. Wider than the pitcher markets'
# 0.03-0.035 because these rates are an order of magnitude smaller -- a 0.005
# step spans most of the realistic spread of batter home-run rates.
BAT_STEP = 0.005
PIT_STEP = 0.004

# Minimum plate appearances in a cell. See the rare-class note above.
MIN_OBS = 200

CELL_SQL = """
select
    cast(strftime(a.game_date, '%Y') as int)                      as season,
    -- Count state is meaningless at the start of a plate appearance and is
    -- carried only because _design builds `balls`/`strikes` for every market.
    -- ab_result does the same. Neither names them as features.
    0                                                              as balls,
    0                                                              as strikes,
    case when a.result_detail = 'home_run' then 'home_run'
         else 'other' end                                          as outcome,
    -- Same handedness on both sides. Not bucketed and not windowed: it is a
    -- property of this matchup, so it rides as a cell_feature.
    case when a.bat_side is null or a.pitch_hand is null
              or a.bat_side = 'S' then 0
         when a.bat_side = a.pitch_hand then 1
         else 0 end                                                as platoon_same,
    cast(floor(coalesce(b.career_hr_rate - {hr}, 0) / {bs}) as int) as career_bat_hr_bucket,
    cast(floor(coalesce(b.d30_hr_rate    - {hr}, 0) / {bs}) as int) as d30_bat_hr_bucket,
    cast(floor(coalesce(b.d90_hr_rate    - {hr}, 0) / {bs}) as int) as d90_bat_hr_bucket,
    cast(floor(coalesce(p.career_hr_rate - {hr}, 0) / {ps}) as int) as career_pit_hr_bucket,
    cast(floor(coalesce(p.d30_hr_rate    - {hr}, 0) / {ps}) as int) as d30_pit_hr_bucket,
    cast(floor(coalesce(p.d90_hr_rate    - {hr}, 0) / {ps}) as int) as d90_pit_hr_bucket,
    count(*)                                                       as n
from at_bats a
join form_spine_bat_ab b
  on b.batter_id = a.batter_id and b.game_date = a.game_date
join form_spine_ab p
  on p.pitcher_id = a.pitcher_id and p.game_date = a.game_date
where a.result_detail is not null
  and b.career_n > 0
  and p.career_n > 0
group by all
""".format(hr=HR_BASELINE, bs=BAT_STEP, ps=PIT_STEP)


def to_params(fit, form_window: str) -> dict:
    return {
        "type": "multinomial_logistic",
        "classes": list(fit.classes),
        "features": list(fit.feature_names),
        "coef": [[round(v, 6) for v in row] for row in fit.coef],
        "intercept": [round(v, 6) for v in fit.intercept],
        "form_window": form_window,
    }


SPEC = MarketSpec(
    market="batter_hr",
    family="multinomial_logistic",
    cell_sql=CELL_SQL,
    feature_names=("batter_hr_delta", "pitcher_hr_delta", "platoon_same"),
    classes=("home_run", "other"),
    primary_metric="logloss",
    metric_direction="lower",
    positive_class="home_run",
    # WIDER than batter_hit, and the direction is deliberate. A calibration
    # ratio is a ratio of rates, and the home-run rate is estimated from ~3.2%
    # of plate appearances against ~23% for a hit -- roughly a seventh of the
    # positive events, so several times the sampling noise. A band as tight as
    # the hit market's would hold good models on variance rather than on bias,
    # which is the opposite of what a gate is for.
    #
    # It is still a band worth having: at a 3.2% base rate a 15% overshoot is
    # 0.037 against 0.032, which log loss barely registers and anyone reading
    # the number feels immediately.
    calibration_band=(0.85, 1.15),
    min_cell_obs=MIN_OBS,
    form_windows=("career", "d30", "d90"),
    to_params=to_params,
    datasets=("at_bats",),
    spines=("form_spine_ab", "form_spine_bat_ab"),
    form_features=(
        FormFeature("batter_hr_delta", "bat_hr_bucket", BAT_STEP),
        FormFeature("pitcher_hr_delta", "pit_hr_bucket", PIT_STEP),
    ),
    cell_features=("platoon_same",),
)
