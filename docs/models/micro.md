# Per-pitch and per-at-bat markets (unchanged v2)

`pitch_result`, `ab_result`, `pitch_speed_ou` and `ab_pitches_ou` are still
the v2 cell models documented in [`../MODELS.md`](../MODELS.md). They were
not rebuilt in the v3 pass. What is known about them:

* `pitch_speed_ou` prices at a model-fair line equal to its own prediction,
  so its graded hit rate sits near 50% by construction (47.5% live). The fix
  is a pitch-mix mixture (P(fastball | count, pitcher) × per-type velocity)
  priced at a fixed per-pitcher line.
* `ab_result` still applies the serve-time `CALIB_SHRINK = 0.7`. The v3 PA
  model, conditioned on the count, is the natural replacement.
* Several features are `intercept_folded` (trained as zero, served live).

These are the next models to move onto the v3 ratings.
