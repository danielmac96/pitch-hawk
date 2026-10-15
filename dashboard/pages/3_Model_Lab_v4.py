"""v4 Model Lab: one model per market, how each was built and chosen.

Per market: the outcome it predicts, the candidate ladder that was tried
(every rung, chosen or not), walk-forward validation against the naive
baseline and the incumbent, the 2026 test, reliability, feature importance,
and the backfilled predictions tracked day by day from 2018 to the latest
scored game.

Reads model_runs (config.pipeline = "v4") and v4_backfill_daily. Read-only:
staging goes through `python -m modeling`, never a button. The judgements
live in modeling/v4/report.py; the method in docs/models/V4-PLAN.md.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from modeling.report import fetch_all  # noqa: E402
from modeling.v4 import catalog as C  # noqa: E402
from modeling.v4 import report as V  # noqa: E402
from utils import palette  # noqa: E402
from warehouse.config import supabase_client as get_client  # noqa: E402

CACHE_TTL = 300

st.set_page_config(page_title="Model Lab v4", page_icon="🧬", layout="wide")
st.title("Model Lab · v4")
st.caption("One model per market, each fitted on its own outcome. Every candidate "
           "tried is recorded; 2026 is a test scored once, never used to choose. "
           "Method: `docs/models/V4-PLAN.md`.")


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_runs() -> pd.DataFrame:
    db = get_client()
    rows = fetch_all(lambda: db.table("model_runs").select("*")
                     .eq("config->>pipeline", "v4").order("created_at", desc=True),
                     cap=5000)
    return V.v4_runs(pd.DataFrame(rows))


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_daily(market: str) -> pd.DataFrame:
    db = get_client()
    rows = fetch_all(lambda: db.table("v4_backfill_daily").select("*")
                     .eq("market", market).order("day"), cap=10_000)
    df = pd.DataFrame(rows)
    if not df.empty:
        df["day"] = pd.to_datetime(df["day"])
    return df


p = palette.active()
COLORS = {"v4 model": p.series[0], "incumbent": p.series[1], "baseline": p.expected}
runs = load_runs()

if runs.empty:
    st.info("No v4 runs recorded yet. They are written by "
            "`python -m modeling v4 train <market|group> --record` (lab runner).")
    st.stop()

# ── overview ────────────────────────────────────────────────────────────────
st.header("Every market")
ov = V.overview(runs)
missing = sorted(set(C.MARKETS) - set(ov["market"]))
n_ok = int((ov["status"] == "stageable").sum())
c1, c2, c3 = st.columns(3)
c1.metric("Markets with a v4 model", f"{len(ov)} / {len(C.MARKETS)}")
c2.metric("Pass the v4 gate", n_ok)
c3.metric("Candidates recorded", len(runs))
if missing:
    st.caption("Not yet run: " + ", ".join(f"`{m}`" for m in missing))
st.dataframe(
    ov, width="stretch", hide_index=True,
    column_config={"lift vs incumbent %": st.column_config.NumberColumn(format="%.2f%%"),
                   "run at": st.column_config.DatetimeColumn(format="YYYY-MM-DD HH:mm")})
st.caption("Lower is better for every metric (log loss, RPS, Gaussian NLL). "
           "Validation = walk-forward 2018–2025 aggregate, 2020 excluded. "
           "Lift compares validation against the incumbent (or the baseline where "
           "no incumbent exists). `stageable` = passed the v4 gate; `held` = chosen "
           "but held, reasons on the market page.")

# ── one market ──────────────────────────────────────────────────────────────
st.header("Market")
market = st.selectbox("Market", ov["market"].tolist())
md = C.MARKETS.get(market)
mruns = runs[runs["market"] == market]
hist = V.history(mruns, market)
batch = st.selectbox("Ladder run", hist["batch"].tolist()[::-1],
                     format_func=lambda b: f"#{b} · {hist.set_index('batch').loc[b, 'run at']:%Y-%m-%d %H:%M} "
                                           f"· chose {hist.set_index('batch').loc[b, 'chosen']}")
lad = V.ladder(mruns, market, batch)
chosen_id = lad.loc[lad["chosen"] == "★", "run_id"]
row = mruns[mruns["run_id"] == chosen_id.iloc[0]].iloc[0] if len(chosen_id) else mruns.iloc[0]
cfg = row["config"]

tab_card, tab_ladder, tab_val, tab_cal, tab_imp, tab_track = st.tabs(
    ["Model card", "Iterations", "Validation & test", "Calibration", "Features",
     "Backfill tracking"])

with tab_card:
    a, b = st.columns([3, 2])
    with a:
        st.subheader(market)
        st.markdown(f"**Predicts:** {cfg.get('outcome')}")
        st.markdown(f"**Grain:** `{cfg.get('grain')}` · **kind:** `{cfg.get('kind')}` · "
                    f"**target column:** `{cfg.get('target')}`"
                    + (f" · **support:** 0..{cfg.get('cap')}+" if cfg.get("cap") else "")
                    + (f" · **reference line:** {cfg.get('line')}" if cfg.get("line") else ""))
        st.markdown(f"**Chosen:** {V.RUNG_LABEL.get(row['iteration'], row['iteration'])} "
                    f"(`{cfg.get('family')}`), version `{row.get('version')}`")
        st.markdown(f"**Primary metric:** `{cfg.get('primary_metric')}` · **baseline:** "
                    f"training-season rate by `{cfg.get('baseline_group') or 'nothing'}` · "
                    f"**incumbent:** {cfg.get('incumbent') or 'none'}")
        st.markdown(f"**Served in production today:** `{cfg.get('served_as')}` — v4 is "
                    "a shadow model until a human stages it.")
        status = "pass" if row["status"] == "stageable" else "warn"
        st.markdown(palette.status_chip(status, f"gate: {row['status']}"),
                    unsafe_allow_html=True)
        st.caption(row["notes"])
    with b:
        st.markdown("**Training**")
        st.markdown(
            f"- seasons {min(row['train_seasons'])}–{max(row['train_seasons'])}; "
            f"walk-forward tests {cfg.get('test_seasons')}\n"
            f"- excluded from the aggregate: {cfg.get('exclude_from_aggregate')}\n"
            f"- training rows per fold capped at {cfg.get('max_train_rows'):,}\n"
            f"- {cfg.get('n_features')} features"
            + (f", stacked: {', '.join(cfg.get('stack') or [])}" if cfg.get("stack") else "")
            + f"\n- hyperparameters: `{cfg.get('hyperparams')}`"
            f"\n- ladder wall time {cfg.get('seconds')}s · git `{row.get('git_sha')}`")
        art = (row.get("params") or {}).get("artifact")
        if art:
            st.markdown(f"- production fit: `{art}` (R2)")
    with st.expander("All features used"):
        st.write(", ".join(f"`{f}`" for f in cfg.get("features") or []))

with tab_ladder:
    st.caption("Every rung of the fixed ladder, scored on identical folds. The chosen "
               "rung (★) has the best validation metric; the 2026 column is shown "
               "for every rung so you can see whether the choice held up.")
    st.dataframe(lad.drop(columns=["run_id"]), width="stretch", hide_index=True)
    fig = go.Figure()
    fig.add_bar(x=lad["what"], y=lad["validation"], name="validation",
                marker_color=[p.series[0] if c == "★" else p.band for c in lad["chosen"]],
                text=[f"{v:.4f}" if v is not None else "" for v in lad["validation"]],
                textposition="outside")
    fig.add_scatter(x=lad["what"], y=lad["test 2026"], mode="markers", name="2026 test",
                    marker={"color": p.series[1], "size": 10, "symbol": "diamond"})
    lo = pd.concat([lad["validation"], lad["test 2026"]]).dropna()
    if len(lo):
        pad = (lo.max() - lo.min()) * 0.3 or 0.01
        fig.update_yaxes(range=[lo.min() - pad, lo.max() + pad])
    st.plotly_chart(palette.style(fig, p, height=360, legend=True,
                                  title=f"{cfg.get('primary_metric')} by rung (lower is better)"),
                    width="stretch", config=palette.plotly_config())
    st.subheader("History of this market's ladder")
    st.dataframe(hist, width="stretch", hide_index=True)

with tab_val:
    fl = V.folds_long(row)
    if not fl.empty:
        fig = go.Figure()
        for s, g in fl.groupby("series"):
            fig.add_scatter(x=g["season"], y=g["value"], name=s, mode="lines+markers",
                            line={"color": COLORS.get(s), "width": 2.5 if s == "v4 model" else 1.5})
        fig.add_vrect(x0=2019.5, x1=2020.5, fillcolor=p.band, line_width=0)
        fig.add_vrect(x0=2025.5, x1=2026.5, fillcolor=p.band, line_width=0,
                      annotation_text="test", annotation_position="top left")
        st.plotly_chart(palette.style(fig, p, height=340, legend=True,
                                      title=f"{cfg.get('primary_metric')} by test season"),
                        width="stretch", config=palette.plotly_config())
        st.caption("Shaded: 2020 (60 games, reported, excluded from the aggregate) "
                   "and 2026 (the test season).")
    st.subheader("Aggregates")
    agg = pd.DataFrame({"validation (2018–25)": pd.Series(row["oos_metrics"]),
                        "test 2026": pd.Series(row["holdout_metrics"] or {})})
    st.dataframe(agg[agg.index.map(lambda k: not str(k).startswith("_"))],
                 width="stretch")
    st.subheader("Every fold")
    st.dataframe(V.folds_table(row), width="stretch", hide_index=True)

with tab_cal:
    rel = V.reliability(row)
    if rel.empty:
        st.info("No reliability curve for this kind (Gaussian markets are judged on "
                "sigma coverage, in the aggregates).")
    else:
        fig = go.Figure()
        mx = float(max(rel["pred"].max(), rel["obs"].max()))
        fig.add_scatter(x=[0, mx], y=[0, mx], mode="lines", name="perfect",
                        line={"color": p.expected, "width": 1})
        for i, (s, g) in enumerate(rel.groupby("set")):
            fig.add_scatter(x=g["pred"], y=g["obs"], mode="lines+markers", name=s,
                            line={"color": p.series[i]},
                            hovertemplate="pred %{x:.3f}<br>obs %{y:.3f}<br>n %{text}",
                            text=g["n"])
        fig.update_xaxes(title="mean predicted")
        fig.update_yaxes(title="observed")
        st.plotly_chart(palette.style(fig, p, height=380, legend=True,
                                      title="Reliability (equal-count bins)"),
                        width="stretch", config=palette.plotly_config())
        st.dataframe(rel, width="stretch", hide_index=True)

with tab_imp:
    imp, kind = V.importance(row)
    if imp.empty:
        st.info("No importance recorded for this rung.")
    else:
        top = imp.head(25).iloc[::-1]
        fig = go.Figure(go.Bar(x=top["importance"], y=top["feature"], orientation="h",
                               marker_color=p.series[0]))
        st.plotly_chart(palette.style(fig, p, height=max(300, 20 * len(top)),
                                      title=kind or "importance"),
                        width="stretch", config=palette.plotly_config())
        st.dataframe(imp, width="stretch", hide_index=True)

with tab_track:
    daily = load_daily(market)
    if daily.empty:
        st.info("No backfill published for this market yet.")
    else:
        last = daily["day"].max()
        st.markdown(f"**{daily['n'].sum():,}** predictions over **{len(daily):,}** game-days, "
                    f"{daily['day'].min():%Y-%m-%d} → **{last:%Y-%m-%d}**. Sources: "
                    + ", ".join(f"`{s}` ({n:,} days)" for s, n in
                                daily["source"].value_counts().items()))
        win = st.slider("Rolling window (game-days)", 3, 60, 14)
        dl = V.daily_long(daily, win)
        fig = go.Figure()
        for s, g in dl.groupby("series"):
            fig.add_scatter(x=g["day"], y=g["value"], name=s, mode="lines",
                            line={"color": COLORS.get(s), "width": 2 if s == "v4 model" else 1.2})
        st.plotly_chart(palette.style(fig, p, height=340, legend=True,
                                      title=f"Rolling {daily['primary_metric'].iat[0]} "
                                            "(lower is better)"),
                        width="stretch", config=palette.plotly_config())
        fig = go.Figure()
        d = daily.sort_values("day")
        fig.add_scatter(x=d["day"], y=d["mean_pred"].rolling(win, min_periods=1).mean(),
                        name="mean predicted", line={"color": p.series[0]})
        fig.add_scatter(x=d["day"], y=d["observed"].rolling(win, min_periods=1).mean(),
                        name="observed", line={"color": p.series[2]})
        st.plotly_chart(palette.style(fig, p, height=300, legend=True,
                                      title="Predicted vs observed (rolling)"),
                        width="stretch", config=palette.plotly_config())
        st.subheader("By season")
        st.dataframe(V.season_summary(daily), width="stretch", hide_index=True)
