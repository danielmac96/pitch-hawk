# Modeling methods (v3) — how every prediction on the board is made

This is the document to read before changing a model. It explains the v3
architecture (2026-10), the maths of each step, where each number is computed,
and how it is validated. The registry mechanics (insert, activate, roll back)
are in [`MODELS.md`](MODELS.md); per-market results are in
[`models/`](models/).

## 1. The idea in one paragraph

Almost every market on the board is a question about how **plate-appearance
outcomes** are distributed over a game: a batter's hits, home runs and total
bases; a starter's strikeouts, walks, hits allowed and outs; a team's runs, and
from them the total and the moneyline. v3 therefore fits **one** model of a
single plate appearance — P(K, BB, 1B, 2B, 3B, HR, OUT | batter, pitcher,
park, context) — on **as-of ratings that are computed identically in training
and in production**, and derives every market from it in closed form. A small
logistic **calibrator** per market, fitted walk-forward on real game outcomes,
absorbs what the closed-form roll-up gets wrong.

```
R2 warehouse (2015→)                         Supabase (serving)
  at_bats, games, player_box                   model_ratings  ◄── publish-ratings (nightly)
        │                                      model_params   ◄── stage-v3 + activate (human)
        ▼                                            │
  ratings.py  (as-of, exclusive of game day) ──┐     ▼
        │                                      │   game-predict → props.ts / v3.ts
        ▼                                      │       ├ player_game_projections (props)
  pa_model.py (7-class PA model)               │       └ game_predictions (ML, total)
        │                                      │   api → live total, rest-of-game
        ▼                                      │
  markets.py: workload, PA counts, runs GLM,   │
              calibrators — walk-forward ──────┘ same functions, same configs
```

## 2. What v3 replaced, and why

| problem (measured on the live record, 2026-10-07) | v3 answer |
|---|---|
| `batter_hit` served 0.648 vs 0.520 observed; `batter_hr` 0.127 vs 0.093. Fitted on career/d30/d90 bucket rates from R2, served from 30-day rolling stats in Postgres (1.7× the spread), then patched with hand-tuned `HR_K`, `HIT_K`, `CALIB_SHRINK`. | One rating function (§3) used by training **and** the nightly publish; a test pins them equal. No patch constants. |
| Hit, HR, TB, H+R+RBI and five starter props were six unrelated formulas (`basemodels.ts`). | One PA model; closed-form roll-ups (§5). |
| Expected PAs per batter a constant by slot. | A PA-count **distribution** by slot and home/away, mixed with the probability each trip is against the starter or the bullpen. |
| Starter props assumed 22.5 batters faced for everyone. | A workload model (outs and BF) from the pitcher's and his team's history, rest and quality. |
| Pregame moneyline = log5 on raw season win% with a hardcoded 0.542 home edge (the fitted row was never read). | Team runs as negative binomials from lineup-vs-pitching expectations; win probability from the two run distributions; calibrated. |
| Game total a hand-weighted formula, normal approximation. | Convolution of the two team-run distributions. |
| tb15/hrr graded as "≥1 hit"; every pitcher prop graded void (a stale `settle` deploy). | Grading from the official boxscore (`_shared/boxscore.ts`); labels for training from the same payload (`player_box`). |

## 3. Ratings (`modeling/ratings.py`)

For a player *p*, class *c* and day *d*:

```
S_c(d) = Σ_{p's PAs on days < d}  exp(-(d − day)/τ) · [class = c]
S_n(d) = Σ_{p's PAs on days < d}  exp(-(d − day)/τ)
r_c(d) = (S_c + k_c · L_c(d)) / (S_n + k_c)        then renormalised over c
```

* **Exclusive of the game day.** A player's own game never informs his rating
  for that game (the same leakage rule as the legacy spines).
* **L_c(d)** is the league rate as of *d* (τ = 365 days). The league moves —
  home runs per PA went 2.7% (2015) → 3.6% (2019) → 3.0% (2026) — so the prior
  moves with it.
* **τ and k_c are fitted**, not chosen: `tune()` picks τ (shared across
  classes) and k_c per class by the out-of-sample binary log loss of the
  *next* PA, on 2017–2025. Strikeouts stabilise in tens of PAs, triples
  barely at all; the grid spans that range.
* **Vectorised**: within a player, `S_c(d) = e^{-d/τ} · cumsum(c · e^{day/τ})`
  over earlier days, so every as-of value for ~2.3M PAs is two cumulative sums.
* Separate ratings exist for **batters**, **pitchers**, each team's
  **bullpen** (relief PAs pooled), and **parks**: observed outcomes at the
  venue over log5-*expected* outcomes for the matchups played there, so a
  park does not inherit its home team's talent.

**Train = serve.** `ratings_asof` (training) and `ratings_current` (nightly
publish) are the same arithmetic; `tests/modeling/test_ratings.py` and
`test_publish_ratings.py` assert they agree. The publish uses the τ/k stored
on the **active** `pa_outcome` row, i.e. the configuration the served model
was validated with.

## 4. The PA outcome model (`modeling/pa_model.py`)

Multinomial logistic regression over 7 classes (OUT is the reference). For
each class *c*: `bat_c = logit r^bat_c − logit L_c`, `pit_c` likewise,
`park_c = log f_c`, `lg_c = logit L_c`; plus same-hand, left-handed pitcher,
batting at home, reliever, and second / third-plus time through the order.
With coefficients 1 on `bat_c`, `pit_c`, `lg_c` this is exactly the log5
odds-ratio formula; fitting lets the data correct log5 where it is wrong.

* Fitted on 2016+ (2015 is ratings burn-in), standardised for the optimiser
  and mapped back to raw-scale coefficients so the scorer needs nothing else.
* **Walk-forward**: fold *S* trains on 2016…S−1, tests on S, S = 2018…2025;
  2020 reported but excluded from aggregates; **2026 is the frozen holdout**.
* Baselines reported per fold: league-only rates and raw log5.

## 5. From a PA to a market (`modeling/derive.py`, `_shared/props.ts`)

**Batter, PA by PA.** Slot *s*'s *i*-th trip is the team's (s + 9(i−1))-th
batter, so `q_i = P(starter BF ≥ s + 9(i−1))`, and the trip's distribution is
`q_i · p_vs_starter(tto=min(i,3)) + (1 − q_i) · p_vs_bullpen`. The bullpen is
the team's pooled relief rating with handedness at the league's measured
left-handed share.

**Batter, over a game.** With N ~ P(PA = k | slot, home) (empirical, starters
only):

* P(hit ≥ 1) = Σ_k P(N = k) · (1 − Π_{i≤k} (1 − h_i)); same for HR
* P(TB ≥ 2) by dynamic programming over trips, total bases capped at 2
* H+R+RBI ≥ 1: structural P(hit ≥ 1) plus calibrator inputs for expected
  times on base, batting top-5, and the lineup's expected offence (runs and
  RBIs need teammates)

**Starter.** Outs recorded O and batters faced follow a workload model:
a linear location model on the pitcher's decayed outs and pitches per start,
his team's starter leash, days of rest, first start of a season, and
out-getting quality; plus the empirical integer residual distribution. Given
O = o: strikeouts ~ Binomial(o, pK/(pK+pOUT)); baserunners F ~ NegBin(o,
p_out); hits | F ~ Binomial(F, pH/(pH+pBB)). `p` is the pitcher's per-PA
distribution averaged over the lineup he faces, weighted by how many PAs fall
in each time through the order. Earned runs: a Poisson GLM on log expected
outs and log expected run value per out, with a moment-estimated NB
dispersion. Lines are the **median** half-point (the model-fair line);
P(over) is read from the full distribution, then calibrated.

**Team runs and the game.** A lineup's expected offensive value (wOBA-style
weights over each batter's expected trips) feeds a Poisson GLM for runs with
home, temperature above 70°F and wind toward centre field (both zero under a
closed roof, parsed exactly as `mlb.ts` parses MLB's strings); overdispersion
α by moments → NB2. Totals convolve the two teams; the moneyline is P(home
scores more) + P(tie after 9) × 0.52, then calibrated. The live total scales
the stored pregame team means by the outs each side has left.

## 6. Calibration and validation

Every market's structural probability goes through
`sigmoid(a + b·logit p + Σ w_j x_j)`, fitted on seasons before the test
season using structural probabilities that were themselves produced by
PA-model folds that never saw those games (stacked walk-forward). Reported per
market and fold: log loss, Brier, calibration-in-the-large, accuracy, base
rate, the **uncalibrated** log loss (so the calibrator's contribution is
visible) and a **naive baseline**:

| market group | baseline |
|---|---|
| batter props | training rate for that lineup slot |
| starter props | MAE of the pitcher's training-season mean vs the model's expected count |
| moneyline | constant home rate; **production's log5** formula replayed |
| total | league-mean NB for P(over 8.5) and the exact total |

## 7. Serving parity

* `modeling/serve.py` is the per-entity serving computation in Python;
  `_shared/props.ts` is its TypeScript twin. `props_golden_test.ts` emits
  fixtures from TypeScript; `tests/modeling/test_props_parity.py` requires the
  Python to match to **1e-9** (workload pmfs, batter and starter markets,
  team runs, moneyline, totals).
* `test_train_serve_consistency.py` requires training's bulk roll-up to equal
  the per-batter serving roll-up to 1e-12, so the calibrators are applied to
  the numbers they were fitted on.

## 8. Running it

```bash
python -m warehouse player-box --catchup 2600   # once: per-player box history
python -m modeling markets --record             # train + validate everything
python -m modeling stage-v3                     # runs -> inactive v3_<date> rows
python -m modeling activate pa_outcome v3_<date>
python -m modeling publish-ratings              # nightly afterwards (warehouse.yml)
python -m modeling activate <market> v3_<date>  # workload, team_runs, then markets
```

From a development branch without dispatch rights, commit a request to
`modeling/lab/request.json` (see `.github/workflows/model-lab.yml`).

## 9. Known limits

* PAs are treated as independent given the matchup; calibrators absorb the
  average error, not game-specific clustering (a blow-out inning).
* Pregame we do not know which relievers will pitch; bullpen PAs use the
  team's pooled relief rating.
* Before lineups post, game markets use each team's last scored lineup;
  batter props are only published once the real lineup is posted.
* The per-pitch and per-at-bat micro markets (`pitch_result`, `ab_result`,
  `pitch_speed_ou`, `ab_pitches_ou`) are still the v2 cell models; see
  `models/micro.md`.
