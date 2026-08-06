-- Seed game_predictions from the per-pitch rows still inside the 21-day window.
--
-- Without this the recap section of /api/board is empty on the day it ships:
-- game-predict only starts writing pregame rows from now forward, and settle
-- only grades what exists. Measured 2026-08-06 there were 231,363 surviving
-- `predictions` rows across 274 games, which is ~21 days of history available
-- for free.
--
-- Honest labelling matters here:
--
--   phase='pregame' is the EARLIEST per-pitch row for a (game, market) -- the
--   model's first call on that game. It is not a true pregame call: it was made
--   at the first pitch, not hours before. True pregame rows begin with
--   game-predict. The distinction is recorded here rather than papered over,
--   because the pregame series is what the track record is built from.
--
--   phase='live' is the LATEST row -- the model's final in-game read.
--
-- `result` is deliberately NOT copied across. The raw rows grade a single pitch
-- or at-bat; a game-level row grades the whole game. Leaving them ungraded lets
-- settleGamePredictions() grade them correctly against the game's realized
-- aggregates on its next pass (400/run, every 10 minutes).
--
-- Idempotent: on conflict do nothing, so re-running is a no-op and it can never
-- overwrite a real pregame row written by game-predict.

insert into game_predictions (
    game_pk, official_date, market, phase,
    predicted_value, probs, recommendation, confidence,
    line, price, edge, book, model_version,
    home_team_id, away_team_id, home_abbr, away_abbr,
    n_pitch_predictions, scored_at, updated_at
)
with ranked as (
    select
        p.*,
        row_number() over (partition by p.game_pk, p.market order by p.id asc)  as first_rn,
        row_number() over (partition by p.game_pk, p.market order by p.id desc) as last_rn,
        count(*)     over (partition by p.game_pk, p.market)                    as n_rows
    from predictions p
    where p.market is not null
),
picked as (
    select r.*, 'pregame' as phase from ranked r where r.first_rn = 1
    union all
    select r.*, 'live'    as phase from ranked r where r.last_rn  = 1
)
select
    k.game_pk,
    g.official_date,
    k.market,
    k.phase,
    k.predicted_value,
    k.probs,
    k.recommendation,
    k.confidence,
    k.line,
    k.price,
    k.edge,
    k.book,
    coalesce(k.model_version, ''),
    g.home_team_id,
    g.away_team_id,
    g.home_abbr,
    g.away_abbr,
    k.n_rows,
    k.created_at,
    now()
from picked k
join games g on g.game_pk = k.game_pk
where g.official_date is not null
on conflict (game_pk, market, phase) do nothing;
