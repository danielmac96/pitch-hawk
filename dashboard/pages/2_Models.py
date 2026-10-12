"""Models: what is live, what was validated, and how it was chosen.

Reads model_params (production truth), model_runs (the experiment record) and
the three tables live scoring stamps. Read-only -- promotion goes through
`python -m modeling`, never through a dashboard button. A UI that can change
what production serves is a UI that will, by accident.

The judgements live in utils/models.py; the per-model write-ups this page
summarises are in docs/models/.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

# Streamlit puts the main script's directory (dashboard/) on sys.path, not the
# repo root, and every other page here reads R2 rather than Postgres -- so this
# is the first page needing a Supabase client. Without this the import fails
# only at page-open time, which is a bad place to find out.
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from utils import models as M  # noqa: E402
from warehouse.config import supabase_client as get_client  # noqa: E402

CACHE_TTL = 300

st.set_page_config(page_title="Models", page_icon="🧪", layout="wide")
st.title("Models")
st.caption("Per-model process, features, training and next steps: "
           "`docs/models/README.md`.")


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_params() -> pd.DataFrame:
    df = pd.DataFrame(get_client().table("model_params")
                      .select("market, version, is_active, activated_at, "
                              "metrics, notes, type:params->>type")
                      .order("market").execute().data or [])
    return df


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_runs() -> pd.DataFrame:
    return pd.DataFrame(get_client().table("model_runs")
                        .select("*").order("created_at", desc=True)
                        .limit(200).execute().data or [])


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_live_versions() -> dict:
    db = get_client()
    pitch = (db.table("predictions").select("market, model_version")
             .order("created_at", desc=True).limit(500).execute().data or [])
    props = (db.table("player_game_projections").select("market, model_version")
             .order("scored_at", desc=True).limit(1000).execute().data or [])
    games = (db.table("game_predictions").select("market, model_version")
             .eq("phase", "pregame").in_("market", ["game_moneyline", "game_total"])
             .order("scored_at", desc=True).limit(200).execute().data or [])
    # Per-pitch markets first: game_predictions repeats them at game grain.
    return M.live_stamps(pitch, props, games)


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_graded_projections() -> list[dict]:
    return (get_client().table("player_game_projections")
            .select("market, model_version, probability, result")
            .in_("result", ["hit", "miss"])
            .order("graded_at", desc=True).limit(5000).execute().data or [])


params, runs_df, live = load_params(), load_runs(), load_live_versions()

st.header("Production")
if params.empty:
    st.warning("No rows in model_params.")
else:
    active = M.production(params, live)
    st.dataframe(active[["state", "market", "version", "live_stamp", "type",
                         "activated_at", "notes"]], width="stretch")
    unregistered = sorted(set(live) - set(active["market"]))
    if unregistered:
        st.caption("Scored with no registry row (a formula, not a fitted "
                   "model): " + ", ".join(f"`{m}` → `{live[m]}`"
                                          for m in unregistered))

    if (active["state"] == "⚠️ drift").any():
        st.error(
            "The registry's active version does not match what live scoring "
            "is stamping for at least one market. The edge function that "
            "scores it likely needs a redeploy.")
    if (active["state"] == "🚫 not read").any():
        st.warning(
            "🚫 = fitted and recorded, but **not scored in production**. "
            "model.ts has no `params.type == \"log5\"` branch, so "
            "game-predict uses log5HomeProb()'s default home advantage and "
            "never reads this row.")

    pending = M.unstaged_v3(runs_df, params)
    if pending:
        st.info(
            f"**v3 is validated but not staged** for {len(pending)} "
            "market(s): " + ", ".join(pending) + ". Their runs are in "
            "`model_runs`; production still serves the versions above until "
            "`python -m modeling stage-v3` and `activate` are run "
            "(order in docs/MODELS.md#v3-params).")

st.header("Scorecard")
st.caption("Latest run per market and pipeline. Validation = walk-forward "
           "out-of-sample aggregate (2020 excluded). Test = the frozen 2026 "
           "holdout. Lower is better for every metric shown.")
card = M.scorecard(runs_df, params)
if card.empty:
    st.info("No scored runs recorded yet.")
else:
    st.dataframe(card, width="stretch")

st.header("Live calibration")
st.caption("Graded player projections: mean predicted probability over "
           "observed rate (1.0 = calibrated). Markets with no graded rows "
           "do not appear -- check `settle` if a served market is missing.")
cal = M.live_calibration(load_graded_projections())
if cal.empty:
    st.info("No graded projections.")
else:
    st.dataframe(cal, width="stretch")

st.header("Runs")
if runs_df.empty:
    st.info("No runs recorded yet. Run: python -m modeling train <market>")
else:
    market = st.selectbox("Market", sorted(runs_df["market"].unique()))
    subset = runs_df[runs_df["market"] == market]
    st.dataframe(
        subset[["created_at", "run_id", "status", "version", "config",
                "oos_metrics", "holdout_metrics", "notes"]],
        width="stretch")

    st.subheader("Fold detail")
    run_id = st.selectbox("Run", subset["run_id"].tolist())
    row = subset[subset["run_id"] == run_id].iloc[0]
    folds = M.fold_frame(row["folds"])
    if folds.empty:
        st.info("This run recorded no scored folds.")
    else:
        metric = folds["metric"].iloc[0]
        long = folds.melt(id_vars=["season", "metric"],
                          value_vars=["model", "baseline"],
                          var_name="series").dropna(subset=["value"])
        st.plotly_chart(
            px.line(long, x="season", y="value", color="series", markers=True,
                    title=f"{market} — {metric} by test season"),
            width="stretch")
        st.caption("2020 is a 60-game COVID season; it is reported here but "
                   "excluded from the aggregate. 2026, where present, is the "
                   "holdout.")
