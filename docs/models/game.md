# Game markets — moneyline and total

**Question.** Pregame P(home wins); pregame and live total runs, model-fair
line and P(over).

**Structure.** Each team's expected offensive value (its nine batters' PA
distributions against the opposing starter and bullpen, wOBA-weighted over
expected trips) feeds a Poisson GLM for runs with home, temperature above
70°F and wind toward centre (both zero under a closed roof). Overdispersion
by moments → negative binomial per team. Moneyline = P(home outscores) +
0.52 × P(tie after 9), then a kept calibrator. Total = convolution of the two
teams. Live total = the stored pregame team means scaled by outs remaining.

**Served by.** `game-predict` (`game_predictions`, pregame, frozen) with the
team means in `probs` for the live total in `api`. Before lineups post, each
team's last scored lineup stands in.

## Results

| | OOS v3 | baselines | 2026 v3 | 2026 baselines |
|---|---|---|---|---|
| moneyline log loss | **0.6750** | production log5 0.7084 · home rate 0.6913 | **0.6821** | 0.7179 · 0.6916 |
| moneyline calibration | 0.999 | | 1.001 | |
| total P(over 8.5) log loss | **0.6894** | league 0.6936 | **0.6847** | 0.6931 |
| exact total NLL | **2.8686** | league 2.8786 | **2.8607** | 2.8736 |

## Known limits
* The total's edge is small, as it is for everyone; totals are close to
  efficient. 2026 P(over 8.5) calibration 0.92 — scoring rose; watch it.
* No bullpen fatigue or umpire terms yet; both are in the warehouse.
* The live moneyline is still MLB's own win probability (`mlb_winprob_v1`).
