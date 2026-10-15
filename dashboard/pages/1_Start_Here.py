"""Start here: a new data scientist's map of Pitch Hawk's models.

Everything on this page is reference material that does not change with
each run: what is predicted, where the data comes from, how a model is
validated and chosen, what every metric means, and where to look next.
The live numbers are on the Model Lab · v4 and Models pages.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import streamlit as st

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from modeling.v4 import catalog as C  # noqa: E402
from modeling.v4 import evaluate as E  # noqa: E402
from modeling.v4 import ladder as LD  # noqa: E402
from modeling.v4 import report as V  # noqa: E402

st.set_page_config(page_title="Start here", page_icon="🧭", layout="wide")
st.title("Start here")
st.caption("A map of the models behind Pitch Hawk, for anyone joining the work. "
           "Read top to bottom once; come back to the glossary.")

st.header("1 · What we predict")
st.markdown(
    "Pitch Hawk publishes **18 markets** on MLB games: probabilities and "
    "distributions, not picks. Each has its own v4 model, fitted on that market's "
    "own outcome. *Grain* is what one row of training data is.")
cat = pd.DataFrame([{
    "market": m.name, "predicts": m.outcome, "grain": m.grain, "kind": m.kind,
    "primary metric": E.PRIMARY[m.kind], "naive baseline": f"training rate by {m.baseline_group}"
    if m.baseline_group else "training-season marginal",
    "incumbent": m.incumbent.label if m.incumbent else "—",
    "served before v4": m.served_as,
} for m in C.MARKETS.values()])
st.dataframe(cat, width="stretch", hide_index=True)
st.markdown(
    "- **binary**: one probability (P(1+ hit)). **multiclass**: probabilities over "
    "classes (next pitch: strike/foul, ball, in play). **count**: a full distribution "
    "over 0, 1, 2 … so every line on a ladder (Over 4.5 K, Over 5.5 K …) is read off "
    "one model. **gaussian**: a mean and a spread (pitch speed).\n"
    "- **Pregame** markets (batter, starter, game) are scored each morning and again "
    "as lineups post. **In-game** markets (pitch, plate appearance, rest of game, "
    "live total) are scored live, pitch by pitch, inside the edge functions.")

st.header("2 · Where the data comes from")
st.graphviz_chart("""
digraph {
  rankdir=LR; node [shape=box, style=rounded, fontname="Helvetica", fontsize=11];
  mlb [label="MLB Stats API\\n(play-by-play, box scores,\\nschedule, weather)"];
  r2 [label="R2 warehouse\\nParquet, 2015 → today\\npitches · at_bats · games\\nplayer_box · post_*"];
  frames [label="v4 frames (R2)\\none row per prediction\\nfeatures strictly before\\nthe game day"];
  lab [label="lab runner\\nladder · walk-forward\\nmodel_runs"];
  art [label="R2 artifacts\\n+ v4_models (trees)"];
  supa [label="Supabase\\nmodel_params (active)\\nprojections · predictions"];
  site [label="pitch-hawk.vercel.app"];
  dash [label="this dashboard"];
  mlb -> r2 [label="nightly ingest"];
  r2 -> frames [label="v4 frames"];
  frames -> lab -> art;
  lab -> supa [label="runs, daily rollup"];
  art -> supa [label="v4 serve / activate"];
  supa -> site; supa -> dash; r2 -> dash [style=dashed, label="backfill rows"];
}
""")
st.markdown(
    "- **Leakage rule.** Every feature for a game on day D uses only days before D "
    "(`modeling/v4/feats.py`, tested by shuffling a day's outcomes). In-game features "
    "use only the state before the pitch.\n"
    "- **Postseason** games are in the warehouse (`post_*` datasets) and in every v4 "
    "frame, flagged `is_post`. They are **never trained on**: each is predicted by its "
    "season's model and reported on its own (Model Lab → Postseason).\n"
    "- **v3 structure as a feature.** The previous pipeline (one plate-appearance model "
    "rolled up to every market) is kept: its out-of-sample outputs are inputs to v4 "
    "(`s_*`, `v3_*`) and its predictions are the incumbent v4 must beat.")

st.header("3 · How a model is built, chosen and tested")
st.markdown(
    f"Every market climbs the same fixed **ladder** of candidates, all scored on the "
    f"same folds (`modeling/v4/ladder.py`):")
st.dataframe(pd.DataFrame([{"rung": k, "what": V.RUNG_LABEL[k]} for k in V.RUNG_ORDER]),
             width="stretch", hide_index=True)
st.markdown(
    f"- **Walk-forward validation**: for each season S in {LD.TEST_SEASONS[0]}–"
    f"{LD.TEST_SEASONS[-2]}, fit on {LD.FIRST_TRAIN}…S−1 and predict S. The "
    f"**validation** number averages those seasons, excluding 2020 (60 games).\n"
    f"- **Test**: {LD.HOLDOUT}, scored for every rung but **never used to choose**. "
    "The dashboard shows it so you can see whether the choice held up.\n"
    "- **Choice**: the rung with the best validation primary metric.\n"
    "- **Gate** (`modeling/v4/gate.py`): the chosen rung must beat the baseline and the "
    "incumbent on validation and on the test, be calibrated on the test (mean predicted "
    "÷ observed within 1 ± 0.10, ±0.15 for rare events; σ coverage 0.63–0.73 for speed), "
    "and no season may be >5% worse than the incumbent. Pass → `stageable`; else `held`.\n"
    "- **Activation** is a human step (`python -m modeling v4 activate <market>`), "
    "refuses a held run, and `rollback_model('<market>')` undoes it.\n"
    "- **Backfill**: the walk-forward predictions *are* the history: every row from 2018 "
    "was predicted by a model that never saw its season. After training, the daily "
    "refresh appends each day's games scored by the frozen production fit.")

st.header("4 · Glossary")
gl = pd.DataFrame([
    ("log loss", "mean −ln(probability given to what happened); lower is better. 0.693 is a coin flip on a 50/50 event."),
    ("Brier", "mean squared error of a probability; lower is better."),
    ("calibration", "mean predicted ÷ observed. 1.00 is right; 1.20 says 'yes' 20% too often."),
    ("ECE", "expected calibration error over 10 probability bins."),
    ("AUC", "how well predictions rank yes above no; 0.5 is random. Reported, never chosen on."),
    ("RPS", "ranked probability score: the sum of Brier scores at every threshold of a count — every ladder line at once. Primary for counts."),
    ("count NLL", "−ln P(the exact count that happened)."),
    ("MAE expected", "mean absolute error of the expected count."),
    ("Gaussian NLL", "log loss of a mean-and-spread prediction; primary for pitch speed."),
    ("σ coverage", "share of outcomes within ±1σ; 0.68 if the spread is right."),
    ("lift vs incumbent", "% reduction in the primary metric against the incumbent on the same rows."),
    ("incumbent", "what would be served without v4: the v3 structural model, a v2 model, or the production formula."),
    ("baseline", "the naive prediction: the training seasons' rate (by lineup slot, count state …)."),
], columns=["term", "meaning"])
st.dataframe(gl, width="stretch", hide_index=True)

st.header("5 · Where to look next")
st.markdown(
    "| question | go to |\n|---|---|\n"
    "| Which model is chosen for a market, and why? | **Model Lab · v4** → Iterations |\n"
    "| How accurate is it, by season and on the 2026 test? | Model Lab → Validation & test |\n"
    "| Is it calibrated? | Model Lab → Calibration, Segments |\n"
    "| What drives it? | Model Lab → Features, and the **Feature dictionary** page |\n"
    "| How does it do in October? | Model Lab → Postseason |\n"
    "| Where does it fail? | Model Lab → Segments (by slot, count, inning, month …) |\n"
    "| How is it doing on the site? | Model Lab → Live on site, Backfill tracking |\n"
    "| How do I reproduce or roll it back? | Model Lab → Reproduce |\n"
    "| What was v2/v3, and the registry? | **Models** page; `docs/models/` |\n\n"
    "Code: `modeling/v4/` (catalog → frames/feats → ladder → gate → record → "
    "publish/activate), `supabase/functions/_shared/v4*.ts` (live scoring). "
    "Docs: `docs/models/V4-PLAN.md`, `docs/models/v4.md`, `docs/models/LAB.md`.")
