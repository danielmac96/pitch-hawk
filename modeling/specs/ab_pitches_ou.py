"""ab_pitches_ou -- distribution of pitches REMAINING in the plate appearance.

Not a coefficient model: model.ts's remaining_table branch looks up
`table["{balls}-{strikes}"]` and reads {mean, dist}, then pitchesOverProb()
sums dist to P(total > line). So the fitted object is a weighted histogram
keyed by count state, and `dist` maps remaining-pitch counts to probabilities.

The at_bats grain carries pitch_count (total pitches in the PA) but not a
per-pitch count state, so remaining is derived as `pitch_count - thrown` over
the reachable count states. form_windows is ("career",) because this family
uses no form features at all -- MarketSpec rejects an empty tuple, and a
one-element sweep is the honest way to say "nothing to sweep here".
"""

from __future__ import annotations

from modeling.spec import MarketSpec

# Pitch counts above this are lumped in: the tail past 12 is <0.5% of PAs and
# a long tail of singleton states makes the served dist noisy, not sharper.
MAX_REMAINING = 12

CELL_SQL = """
with pa as (
    select
        cast(strftime(a.game_date, '%Y') as int) as season,
        a.game_pk,
        a.at_bat_index,
        a.pitch_count
    from at_bats a
    where a.pitch_count between 1 and 30
),
-- Expand each PA into the count states it passed through, pairing each with
-- the pitches still to come from that state.
states as (
    select
        pa.season,
        p.balls,
        p.strikes,
        -- +1 because `remaining` is counted from BEFORE the pitch at this
        -- count state is thrown. model.ts computes
        -- `mean = ctx.pitch_count_pa + cell.mean`, where pitch_count_pa is
        -- pitches already thrown; at 0-0 nothing has been thrown, so the 0-0
        -- mean must equal the full PA length (~3.85, and v1 stores 3.882).
        -- Dropping the +1 shifts every served O/U line down by one pitch.
        least(pa.pitch_count - p.pitch_number + 1, {max_remaining}) as remaining
    from pa
    join pitches p
      on p.game_pk = pa.game_pk and p.at_bat_index = pa.at_bat_index
    where p.pitch_number <= pa.pitch_count
)
select
    season,
    balls,
    strikes,
    remaining,
    count(*) as n
from states
where remaining >= 0 and balls between 0 and 3 and strikes between 0 and 2
group by all
""".format(max_remaining=MAX_REMAINING)


def to_params(fit, form_window: str) -> dict:
    return {"type": "remaining_table", "table": fit.table}


SPEC = MarketSpec(
    market="ab_pitches_ou",
    family="remaining_table",
    cell_sql=CELL_SQL,
    feature_names=(),
    classes=None,
    primary_metric="logloss",
    metric_direction="lower",
    form_windows=("career",),
    to_params=to_params,
    datasets=("at_bats", "pitches"),
)
