-- player_streaks timed out on the request path once it was asked about a full
-- page of players rather than a handful.
--
-- Cause: the only filter on the player was `x.player_id = any(...)`, and x is
-- the lateral VALUES fan-out, not a column of at_bats — so nothing was
-- indexable and the plan seq-scanned all 53k at-bats. Adding the equivalent
-- predicate on at_bats' own columns gives the planner a BitmapOr over the two
-- indexes below; the lateral filter stays because it is what actually picks the
-- right side of the fan-out.
--
-- Necessary but not sufficient — see 20260825125116, which bounds the work per
-- player. Kept as its own migration because the indexes are the durable part.
create index if not exists at_bats_pitcher_idx on at_bats (pitcher_id);
create index if not exists at_bats_batter_idx  on at_bats (batter_id);
