"""pitch_result -- P(strike_foul | ball | in_play) for the next pitch.

The richest market: ~7.9M pitches. Multinomial logistic over count state plus
pitcher/batter form deltas, scored by the multinomial_logistic branch of
model.ts.

All three form windows are emitted as separate bucket columns in one build
pass, so the walk-forward sweep over form_window costs no additional R2 reads.

Bucket steps match the v1 trainer (ZONE_STEP=0.03) so the delta scale model.ts
expects is preserved.

DEVIATION FROM THE PLAN, deliberate: the plan's cell SQL recomputed the league
zone rate from the scan. model.ts does not -- featureValue() hardcodes
`p.zone_rate - 0.48`. Training against a recomputed baseline and serving
against 0.48 would feed the shipped coefficients a differently-centred feature,
which no scorer parity test can catch because the scorer only ever sees the
already-computed context value. The production constant wins; see plan rule 3.
"""

from __future__ import annotations

from modeling.spec import MarketSpec

ZONE_STEP = 0.03

# Must equal the literal in featureValue()'s "pitcher_zone_delta" branch in
# supabase/functions/_shared/model.ts. tests/modeling/test_cells.py asserts it.
ZONE_BASELINE = 0.48

# A NULL trailing window (a pitcher with no appearances in the last 30/90 days)
# becomes delta 0 -- exactly what model.ts returns when p.zone_rate is null.
CELL_SQL = """
select
    cast(strftime(p.game_date, '%Y') as int)                     as season,
    p.balls,
    p.strikes,
    case when p.is_in_play then 'in_play'
         when p.is_ball    then 'ball'
         else 'strike_foul' end                                  as outcome,
    cast(floor(coalesce(f.career_zone_rate - {baseline}, 0) / {zone_step}) as int)
                                                                 as career_zone_bucket,
    cast(floor(coalesce(f.d30_zone_rate    - {baseline}, 0) / {zone_step}) as int)
                                                                 as d30_zone_bucket,
    cast(floor(coalesce(f.d90_zone_rate    - {baseline}, 0) / {zone_step}) as int)
                                                                 as d90_zone_bucket,
    count(*)                                                     as n
from pitches p
join form_spine f
  on f.pitcher_id = p.pitcher_id and f.game_date = p.game_date
where f.career_n > 0
group by all
""".format(zone_step=ZONE_STEP, baseline=ZONE_BASELINE)


def to_params(fit, form_window: str) -> dict:
    """FitResult -> the params JSON shape model.ts scores."""
    return {
        "type": "multinomial_logistic",
        "classes": list(fit.classes),
        "features": list(fit.feature_names),
        "coef": [[round(v, 6) for v in row] for row in fit.coef],
        "intercept": [round(v, 6) for v in fit.intercept],
        "form_window": form_window,
    }


SPEC = MarketSpec(
    market="pitch_result",
    family="multinomial_logistic",
    cell_sql=CELL_SQL,
    feature_names=("balls", "strikes", "two_strikes", "three_balls",
                   "pitcher_zone_delta", "batter_chase_delta"),
    classes=("strike_foul", "ball", "in_play"),
    primary_metric="logloss",
    metric_direction="lower",
    form_windows=("career", "d30", "d90"),
    to_params=to_params,
    bucket_step=ZONE_STEP,
)
