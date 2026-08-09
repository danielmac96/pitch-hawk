"""ab_result -- P(strikeout | walk | hit | out) for the plate appearance.

Four classes over ~2.0M plate appearances. Same multinomial family as
pitch_result, so this lands with no engine change -- which is the whole point
of the MarketSpec contract.

pitcher_bb_delta, batter_k_delta and platoon_same are folded into the intercept
as zero, matching the v1 trainer: the cell grain does not carry them. Adding
one is a spec change (new bucket column in cell_sql), not an engine change.

The k-rate baseline is model.ts's LEAGUE.ab_result.strikeout, not a value
recomputed from the scan, for the same reason pitch_result pins 0.48: training
and serving have to centre the feature identically or the shipped coefficients
meet a differently-scaled input in production.
"""

from __future__ import annotations

from modeling.spec import MarketSpec

K_STEP = 0.035

# Must equal LEAGUE.ab_result.strikeout in model.ts.
K_BASELINE = 0.221

CELL_SQL = """
select
    cast(strftime(a.game_date, '%Y') as int)                      as season,
    0                                                              as balls,
    0                                                              as strikes,
    case when a.result in ('strikeout','walk','hit','out')
         then a.result else 'out' end                              as outcome,
    cast(floor(coalesce(f.career_k_rate - {baseline}, 0) / {k_step}) as int)
                                                                   as career_zone_bucket,
    cast(floor(coalesce(f.d30_k_rate    - {baseline}, 0) / {k_step}) as int)
                                                                   as d30_zone_bucket,
    cast(floor(coalesce(f.d90_k_rate    - {baseline}, 0) / {k_step}) as int)
                                                                   as d90_zone_bucket,
    count(*)                                                       as n
from at_bats a
join form_spine_ab f
  on f.pitcher_id = a.pitcher_id and f.game_date = a.game_date
where f.career_n > 0
group by all
""".format(k_step=K_STEP, baseline=K_BASELINE)


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
    market="ab_result",
    family="multinomial_logistic",
    cell_sql=CELL_SQL,
    feature_names=("balls", "strikes", "pitcher_k_delta", "pitcher_bb_delta",
                   "batter_k_delta", "platoon_same"),
    classes=("strikeout", "walk", "hit", "out"),
    primary_metric="logloss",
    metric_direction="lower",
    form_windows=("career", "d30", "d90"),
    to_params=to_params,
    bucket_step=K_STEP,
)
