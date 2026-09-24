"""batter_hit -- P(hit) for a plate appearance.

The sibling of batter_hr, same two-sided shape, different outcome. Classes are
("hit", "other"), where `hit` is `at_bats.result = 'hit'` -- the collapsed
bucket covering single, double, triple and home run.

WHY THIS IS NOT JUST `ab_result` AGAIN. `ab_result` already emits a `hit`
probability among four classes, and for a per-plate-appearance question it is
the better-established model. This market exists because its cell grain
carries the BATTER, which `ab_result`'s does not: there, `batter_k_delta` and
`platoon_same` are `intercept_folded`, so the hitter contributes nothing to
the number. A hit market whose features are entirely about the pitcher is not
a hit market.

Anyone comparing the two should read `ab_result`'s hit probability as the
pitcher-only baseline and this as the two-sided version. If this does not beat
it out of sample, the honest conclusion is that the batter form we can
currently serve adds nothing -- not that the market is unbuildable.

The centre for the batter and pitcher deltas is LEAGUE.ab_result.hit (0.239),
reused rather than re-measured, so this market and `ab_result` mean the same
thing by "hit rate".
"""

from __future__ import annotations

from modeling.spec import FormFeature, MarketSpec

# Must equal LEAGUE.ab_result.hit in model.ts, which is what featureValue()
# subtracts for batter_hit_delta and pitcher_hit_delta.
HIT_BASELINE = 0.239

# Hits are ~22-24% of plate appearances, so the realistic spread is far wider
# than for home runs and the buckets can be correspondingly wider.
BAT_STEP = 0.015
PIT_STEP = 0.012

# Lower than batter_hr's 200: with a ~23% positive rate a 60-PA cell holds
# ~14 hits, which is a usable rate. The floor exists to stop single-PA cells
# from dominating the weighted fit, not to chase a rare class.
#
# Passed as `min_cell_obs`, not as a `having` on CELL_SQL: the query groups by
# all three form windows on both sides, a grid three times finer than the one
# `_design` fits on, where the median cell holds 1 plate appearance. Applied
# there it kept 71 cells and 5,483 of 1,324,509 plate appearances.
# fit.collapse_to_window regroups onto the selected window first, where the
# same 60 keeps 90.8%.
MIN_OBS = 60

CELL_SQL = """
select
    cast(strftime(a.game_date, '%Y') as int)                      as season,
    0                                                              as balls,
    0                                                              as strikes,
    case when a.result = 'hit' then 'hit' else 'other' end         as outcome,
    case when a.bat_side is null or a.pitch_hand is null
              or a.bat_side = 'S' then 0
         when a.bat_side = a.pitch_hand then 1
         else 0 end                                                as platoon_same,
    cast(floor(coalesce(b.career_hit_rate - {hit}, 0) / {bs}) as int) as career_bat_hit_bucket,
    cast(floor(coalesce(b.d30_hit_rate    - {hit}, 0) / {bs}) as int) as d30_bat_hit_bucket,
    cast(floor(coalesce(b.d90_hit_rate    - {hit}, 0) / {bs}) as int) as d90_bat_hit_bucket,
    cast(floor(coalesce(p.career_hit_rate - {hit}, 0) / {ps}) as int) as career_pit_hit_bucket,
    cast(floor(coalesce(p.d30_hit_rate    - {hit}, 0) / {ps}) as int) as d30_pit_hit_bucket,
    cast(floor(coalesce(p.d90_hit_rate    - {hit}, 0) / {ps}) as int) as d90_pit_hit_bucket,
    count(*)                                                       as n
from at_bats a
join form_spine_bat_ab b
  on b.batter_id = a.batter_id and b.game_date = a.game_date
join form_spine_ab p
  on p.pitcher_id = a.pitcher_id and p.game_date = a.game_date
where a.result is not null
  and b.career_n > 0
  and p.career_n > 0
group by all
""".format(hit=HIT_BASELINE, bs=BAT_STEP, ps=PIT_STEP)


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
    market="batter_hit",
    family="multinomial_logistic",
    cell_sql=CELL_SQL,
    feature_names=("batter_hit_delta", "pitcher_hit_delta", "platoon_same"),
    classes=("hit", "other"),
    primary_metric="logloss",
    metric_direction="lower",
    positive_class="hit",
    calibration_band=(0.90, 1.10),
    min_cell_obs=MIN_OBS,
    form_windows=("career", "d30", "d90"),
    to_params=to_params,
    datasets=("at_bats",),
    spines=("form_spine_ab", "form_spine_bat_ab"),
    form_features=(
        FormFeature("batter_hit_delta", "bat_hit_bucket", BAT_STEP),
        FormFeature("pitcher_hit_delta", "pit_hit_bucket", PIT_STEP),
    ),
    cell_features=("platoon_same",),
)
