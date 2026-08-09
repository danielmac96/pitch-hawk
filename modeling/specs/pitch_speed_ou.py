"""pitch_speed_ou -- expected release speed of the next pitch, plus a sigma.

Scored by the `linear` branch of model.ts, which turns (mu, sigma) into
P(over line) through speedOverProb() -> normCdf(). That makes sigma a
first-class output, not a diagnostic: a well-fit mu with a mis-scaled sigma has
good RMSE and produces confidently wrong probabilities. modeling/registry.py
vetoes promotion when out-of-sample sigma coverage leaves [0.63, 0.73].

Cells carry both mean_speed and var_speed so the fitter can combine
between-cell and within-cell variance. A cell is an aggregate of thousands of
pitches; the spread *inside* it is real spread the model must own.

pitcher_velo is the feature model.ts computes as a blend of the pitcher's
fastball velo toward the league mean, so the bucket here is centred on
LEAGUE.avg_speed for the same train/serve alignment reason as the other markets.
"""

from __future__ import annotations

from modeling.spec import MarketSpec

VELO_STEP = 0.5

# Must equal LEAGUE.avg_speed in model.ts.
VELO_BASELINE = 92.8

CELL_SQL = """
select
    cast(strftime(p.game_date, '%Y') as int)                      as season,
    p.balls,
    p.strikes,
    least(p.pitch_number, 10)                                     as pitch_of_pa,
    cast(floor(coalesce(f.career_velo - {baseline}, 0) / {step}) as int)
                                                                  as career_velo_bucket,
    cast(floor(coalesce(f.d30_velo    - {baseline}, 0) / {step}) as int)
                                                                  as d30_velo_bucket,
    cast(floor(coalesce(f.d90_velo    - {baseline}, 0) / {step}) as int)
                                                                  as d90_velo_bucket,
    avg(p.start_speed)                                            as mean_speed,
    coalesce(var_pop(p.start_speed), 0.0)                         as var_speed,
    count(*)                                                      as n
from pitches p
join form_spine f
  on f.pitcher_id = p.pitcher_id and f.game_date = p.game_date
where f.career_n > 0 and p.start_speed is not null
group by all
""".format(step=VELO_STEP, baseline=VELO_BASELINE)


def to_params(fit, form_window: str) -> dict:
    return {
        "type": "linear",
        "features": list(fit.feature_names),
        "coef": [round(v, 6) for v in fit.coef],
        "intercept": round(float(fit.intercept), 6),
        "sigma": round(float(fit.sigma), 4),
        "form_window": form_window,
    }


SPEC = MarketSpec(
    market="pitch_speed_ou",
    family="linear",
    cell_sql=CELL_SQL,
    feature_names=("balls", "strikes", "pitch_of_pa", "pitcher_velo"),
    classes=None,
    primary_metric="rmse",
    metric_direction="lower",
    form_windows=("career", "d30", "d90"),
    to_params=to_params,
    bucket_step=VELO_STEP,
    bucket_col="velo_bucket",
    bucket_baseline=VELO_BASELINE,
)
