"""Feature dictionary: every v4 model input, what it means, and what it moves.

Definitions come from modeling/v4/featdoc.py (generated from naming rules,
tested so nothing is undocumented). Importance comes from each market's
latest chosen v4 run: permutation importance on the 2026 test season for
boosted models, standardised coefficients for GLMs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import streamlit as st

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from modeling.report import fetch_all  # noqa: E402
from modeling.v4 import featdoc  # noqa: E402
from modeling.v4 import report as V  # noqa: E402

st.set_page_config(page_title="Feature dictionary", page_icon="📖", layout="wide")
st.title("Feature dictionary")
st.caption("Every input any v4 model can use. 'As of' says what the feature may know: "
           "pregame features use only days before the game; in-game features only the "
           "state before the pitch.")


@st.cache_data(ttl=300, show_spinner=False)
def importance_matrix() -> pd.DataFrame:
    try:
        from warehouse.config import supabase_client
        db = supabase_client()
        rows = fetch_all(lambda: db.table("model_runs").select("market,created_at,config,calibration,git_sha")
                         .eq("config->>pipeline", "v4").eq("config->>chosen", "true")
                         .order("created_at", desc=True), cap=2000)
    except Exception:  # noqa: BLE001 -- the dictionary is useful without credentials
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df = df.drop_duplicates("market")
    recs = []
    for r in df.to_dict("records"):
        imp = (r.get("calibration") or {}).get("importance") or {}
        tot = sum(abs(v) for v in imp.values() if isinstance(v, (int, float))) or 1.0
        for f, v in imp.items():
            if isinstance(v, (int, float)):
                recs.append({"feature": f, "market": r["market"], "share": abs(v) / tot})
    return pd.DataFrame(recs)


d = pd.DataFrame(featdoc.dictionary())
imp = importance_matrix()
if not imp.empty:
    top = imp.groupby("feature")["share"].agg(["mean", "count"]).rename(
        columns={"mean": "mean importance share", "count": "markets ranking it"})
    d = d.merge(top, left_on="feature", right_index=True, how="left")

c1, c2, c3 = st.columns([2, 1, 1])
q = c1.text_input("Search", placeholder="velocity, umpire, slot, walks …")
groups = c2.multiselect("Group", sorted(d["group"].unique()))
mk = c3.selectbox("Used by market", ["any"] + sorted({m for ms in d["markets"] for m in ms.split(", ")}))
view = d
if q:
    ql = q.lower()
    view = view[view.apply(lambda r: ql in r["feature"].lower() or ql in r["meaning"].lower()
                           or ql in r["group"].lower(), axis=1)]
if groups:
    view = view[view["group"].isin(groups)]
if mk != "any":
    view = view[view["markets"].str.contains(rf"\b{mk}\b")]
st.caption(f"{len(view)} of {len(d)} features")
st.dataframe(view, width="stretch", hide_index=True,
             column_config={"mean importance share": st.column_config.ProgressColumn(
                 format="%.3f", min_value=0, max_value=float(d.get("mean importance share",
                                                                    pd.Series([0.1])).max() or 0.1))})

if not imp.empty:
    st.header("What each market leans on")
    st.caption("Share of each chosen model's importance, top 12 features per market "
               "(permutation importance on the 2026 test, or |standardised coefficient|).")
    market = st.selectbox("Market", sorted(imp["market"].unique()))
    sub = imp[imp["market"] == market].nlargest(12, "share").merge(
        d[["feature", "group", "meaning"]], on="feature", how="left")
    st.bar_chart(sub.set_index("feature")["share"].iloc[::-1], horizontal=True)
    st.dataframe(sub, width="stretch", hide_index=True)

st.header("Groups")
st.dataframe(d.groupby("group").agg(features=("feature", "count"),
                                    example=("feature", "first"),
                                    source=("source", "first"),
                                    as_of=("as_of", "first")).reset_index(),
             width="stretch", hide_index=True)
