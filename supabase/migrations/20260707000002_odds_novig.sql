-- De-vigged (no-vig) implied probability per odds row. For a two-sided quote
-- pair from one source (home/away ML, over/under total) novig_prob normalizes
-- out the book's margin: p / (p_home + p_away). Pick edges use this instead of
-- the raw implied prob, which is systematically inflated by vig.
alter table odds add column if not exists novig_prob numeric(6,4);

-- Which book (source) each prediction was priced against. "model_fair" marks a
-- micro-market (pitch speed / AB pitches) priced at even money vs the model's
-- own fair line — no real book publishes these, so it must never read as
-- beating a sportsbook.
alter table predictions add column if not exists book text;
