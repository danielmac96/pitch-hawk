"""game_moneyline -- the home-field advantage term in log5.

WARNING, and the reason this market is trained but never promoted:
model.ts has NO `params.type === "log5"` branch. game-predict/index.ts calls
log5HomeProb(homeWinPct, awayWinPct) and takes the function's default
`homeAdv = 0.542`; it never reads model_params for this market. A promoted
row here would be recorded, versioned, and completely inert in production.

It is still in the workbench so the number is measured and tracked rather than
being an unexamined constant in a function signature -- and so that whenever
the edge function does learn to read it, the validation and promotion path
already exists. See docs/MODELS.md.

One parameter, so form_windows is ("career",) and the half-life sweep is the
only dimension that moves.
"""

from __future__ import annotations

from modeling.spec import MarketSpec

CELL_SQL = """
select
    season,
    0                                                    as balls,
    0                                                    as strikes,
    case when home_score > away_score then 1 else 0 end  as home_win,
    count(*)                                             as n
from games
where home_score is not null and away_score is not null
  and home_score <> away_score
group by all
"""


def to_params(fit, form_window: str) -> dict:
    return {"type": "log5", "home_adv": round(float(fit.intercept), 4)}


SPEC = MarketSpec(
    market="game_moneyline",
    family="log5",
    cell_sql=CELL_SQL,
    feature_names=(),
    classes=None,
    primary_metric="brier",
    metric_direction="lower",
    form_windows=("career",),
    to_params=to_params,
    datasets=("games",),
)
