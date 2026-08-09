"""Models: what is live, what was tried, and how it was chosen.

Reads model_params (production truth) and model_runs (the experiment record).
Read-only -- promotion goes through `python -m modeling train --promote`, never
through a dashboard button. A UI that can change what production serves is a UI
that will, by accident.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

# Streamlit puts the main script's directory (dashboard/) on sys.path, not the
# repo root, and every other page here reads R2 rather than Postgres -- so this
# is the first page needing backend/. Without this the import fails only at
# page-open time, which is a bad place to find out.
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from backend.db.client import get_client  # noqa: E402

CACHE_TTL = 300

# game_moneyline is fitted and recorded but cannot be served: model.ts has no
# params.type == "log5" branch, so game-predict falls back to log5HomeProb()'s
# default homeAdv. Flagged in the UI so an inert "active" row is never mistaken
# for one production is actually reading.
INERT_MARKETS = {"game_moneyline"}

st.set_page_config(page_title="Models", page_icon="🧪", layout="wide")
st.title("Models")


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_params() -> pd.DataFrame:
    return pd.DataFrame(get_client().table("model_params")
                        .select("market, version, is_active, activated_at, metrics, notes")
                        .order("market").execute().data or [])


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_runs() -> pd.DataFrame:
    return pd.DataFrame(get_client().table("model_runs")
                        .select("*").order("created_at", desc=True)
                        .limit(200).execute().data or [])


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_live_versions() -> dict:
    rows = (get_client().table("predictions")
            .select("market, model_version")
            .order("created_at", desc=True).limit(500).execute().data or [])
    out = {}
    for r in rows:
        out.setdefault(r["market"], r["model_version"])
    return out


params, runs_df, live = load_params(), load_runs(), load_live_versions()

st.header("Production")
if params.empty:
    st.warning("No rows in model_params.")
else:
    active = params[params["is_active"]].copy()
    active["live_stamp"] = active["market"].map(live)
    active["match"] = active.apply(
        lambda r: "✅" if r["live_stamp"] == r["version"] else "⚠️", axis=1)
    active.loc[active["market"].isin(INERT_MARKETS), "match"] = "🚫"
    st.dataframe(active[["match", "market", "version", "live_stamp",
                         "activated_at", "metrics"]], width="stretch")

    drift = active[active["match"] == "⚠️"]
    if not drift.empty:
        st.error(
            f"{len(drift)} market(s) where the registry's active version does "
            f"not match what live scoring is stamping. The live-poll edge "
            f"function likely needs a redeploy.")
    inert = active[active["match"] == "🚫"]
    if not inert.empty:
        st.warning(
            "🚫 = fitted and recorded, but **not scored in production**. "
            "model.ts has no `params.type == \"log5\"` branch, so "
            "game-predict uses log5HomeProb()'s default home advantage and "
            "never reads this row.")

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
    folds = pd.DataFrame(row["folds"] or [])
    if folds.empty:
        st.info("This run recorded no folds.")
    else:
        # Each family reports its own primary metric, so pick whichever the
        # run actually carries rather than assuming log-loss.
        folds["metric"] = folds["metrics"].apply(
            lambda m: next((m[k] for k in ("logloss", "rmse", "brier")
                            if k in m), None))
        st.plotly_chart(
            px.line(folds, x="test_season", y="metric", markers=True,
                    title=f"{market} — out-of-sample by test season"),
            width="stretch")
        st.caption("2020 is a 60-game COVID season; it is reported here but "
                   "excluded from the aggregate.")
