"""What the dashboard's v4 page shows, as pure functions over model_runs rows
and v4_backfill_daily rows. Nothing here touches Streamlit or the network.

A v4 *batch* is one ladder run for one market: every rung shares a git sha
and was written within minutes. `batches()` groups rungs so the page can
show the latest ladder and every earlier one -- the iteration history.
"""

from __future__ import annotations

import pandas as pd

from modeling.v4 import catalog as C

RUNG_ORDER = ("i0_baseline", "i1_incumbent", "i2_glm", "i3_gbm", "i4_gbm_stack",
              "i3m_gbm_multiclass", "i5_tuned", "i6_calibrated")
RUNG_LABEL = {
    "i0_baseline": "naive baseline", "i1_incumbent": "incumbent (v3 / prod)",
    "i2_glm": "regularised GLM", "i3_gbm": "gradient boosting",
    "i4_gbm_stack": "boosting + v3 stack", "i3m_gbm_multiclass": "boosting, count as classes",
    "i5_tuned": "tuned boosting", "i6_calibrated": "calibrated best",
}


def v4_runs(runs: pd.DataFrame) -> pd.DataFrame:
    if runs.empty:
        return runs
    cfg = runs["config"].apply(lambda c: c or {})
    df = runs[cfg.apply(lambda c: c.get("pipeline") == "v4")].copy()
    if df.empty:
        return df
    c = df["config"]
    df["iteration"] = c.apply(lambda x: x.get("iteration"))
    df["chosen"] = c.apply(lambda x: bool(x.get("chosen")))
    df["primary_metric"] = c.apply(lambda x: x.get("primary_metric"))
    df["created_at"] = pd.to_datetime(df["created_at"], utc=True)
    return df


def batches(df: pd.DataFrame) -> pd.DataFrame:
    """Label each rung with its batch: same market and git sha, rungs written
    within 30 minutes of the previous one."""
    if df.empty:
        return df
    df = df.sort_values(["market", "created_at"]).copy()
    gap = df.groupby("market")["created_at"].diff() > pd.Timedelta(minutes=30)
    sha = df.groupby("market")["git_sha"].shift() != df["git_sha"]
    new = gap | sha
    df["batch"] = new.groupby(df["market"]).cumsum().astype(int)
    df["batch_at"] = df.groupby(["market", "batch"])["created_at"].transform("min")
    return df


def _p(m: dict | None, k: str):  # noqa: ANN202
    return (m or {}).get(k)


def overview(df: pd.DataFrame) -> pd.DataFrame:
    """One row per market: the latest batch's chosen rung against its refs."""
    if df.empty:
        return pd.DataFrame()
    df = batches(df)
    last = df[df["batch"] == df.groupby("market")["batch"].transform("max")]
    rows = []
    for mkt, g in last.groupby("market"):
        ch = g[g["chosen"]]
        if ch.empty:
            continue
        r = ch.iloc[0]
        oos, hold = r["oos_metrics"] or {}, r["holdout_metrics"] or {}
        val, inc, base = _p(oos, "primary"), _p(oos, "incumbent_primary"), _p(oos, "baseline_primary")
        ref = inc if inc is not None else base
        md = C.MARKETS.get(mkt)
        rows.append({
            "market": mkt, "kind": r["config"].get("kind"),
            "outcome": r["config"].get("outcome"),
            "served today": md.served_as if md else "",
            "chosen rung": RUNG_LABEL.get(r["iteration"], r["iteration"]),
            "status": r["status"], "metric": r["primary_metric"],
            "validation": val, "val incumbent": inc, "val baseline": base,
            "lift vs incumbent %": (None if val is None or ref is None or not ref
                                    else round(100 * (ref - val) / ref, 2)),
            "test 2026": _p(hold, "primary"),
            "test incumbent": _p(hold, "incumbent_primary"),
            "test baseline": _p(hold, "baseline_primary"),
            "rungs tried": len(g), "batches": int(df[df["market"] == mkt]["batch"].max()),
            "run at": r["created_at"],
        })
    return pd.DataFrame(rows).sort_values("market").reset_index(drop=True)


def ladder(df: pd.DataFrame, market: str, batch: int | None = None) -> pd.DataFrame:
    """Every rung of one batch, in ladder order."""
    df = batches(df[df["market"] == market])
    if df.empty:
        return df
    b = df["batch"].max() if batch is None else batch
    g = df[df["batch"] == b].copy()
    g["order"] = g["iteration"].map({k: i for i, k in enumerate(RUNG_ORDER)})
    out = pd.DataFrame({
        "rung": g["iteration"], "what": g["iteration"].map(RUNG_LABEL),
        "family": g["config"].apply(lambda c: c.get("family")),
        "chosen": g["chosen"].map({True: "★", False: ""}),
        "validation": g["oos_metrics"].apply(lambda m: _p(m, "primary")),
        "test 2026": g["holdout_metrics"].apply(lambda m: _p(m, "primary")),
        "test calibration": g["holdout_metrics"].apply(
            lambda m: _p(m, "calibration")),
        "features": g["config"].apply(lambda c: c.get("n_features")),
        "fit seconds": g["config"].apply(lambda c: c.get("seconds")),
        "status": g["status"], "notes": g["notes"], "order": g["order"],
        "run_id": g["run_id"],
    })
    return out.sort_values("order").drop(columns="order").reset_index(drop=True)


def history(df: pd.DataFrame, market: str) -> pd.DataFrame:
    """The chosen rung of every batch: how the market's model moved over time."""
    df = batches(df[df["market"] == market])
    ch = df[df["chosen"]]
    return pd.DataFrame({
        "batch": ch["batch"], "run at": ch["batch_at"], "git": ch["git_sha"],
        "chosen": ch["iteration"], "validation": ch["oos_metrics"].apply(lambda m: _p(m, "primary")),
        "test 2026": ch["holdout_metrics"].apply(lambda m: _p(m, "primary")),
        "status": ch["status"], "features": ch["config"].apply(lambda c: c.get("n_features")),
    }).reset_index(drop=True)


def folds_long(row: pd.Series) -> pd.DataFrame:
    """Per test season: model, baseline and incumbent primary, long form."""
    recs = []
    for f in row["folds"] or []:
        for series, key in (("v4 model", "primary"), ("baseline", "baseline_primary"),
                            ("incumbent", "incumbent_primary")):
            if f.get(key) is not None:
                recs.append({"season": f["season"], "series": series, "value": f[key]})
    return pd.DataFrame(recs)


def folds_table(row: pd.Series) -> pd.DataFrame:
    df = pd.DataFrame(row["folds"] or [])
    if df.empty:
        return df
    first = [c for c in ("season", "n", "train_rows", "primary", "baseline_primary",
                         "incumbent_primary") if c in df]
    return df[first + [c for c in df.columns if c not in first]]


def reliability(row: pd.Series) -> pd.DataFrame:
    cal = row.get("calibration") or {}
    recs = []
    for name, key in (("2026 test", "test_2026"), ("validation", "validation")):
        for b in cal.get(key) or []:
            recs.append({"set": name, **b})
    return pd.DataFrame(recs)


def importance(row: pd.Series) -> tuple[pd.DataFrame, str]:
    cal = row.get("calibration") or {}
    imp = cal.get("importance") or {}
    imp = {k: v for k, v in imp.items() if isinstance(v, (int, float))}
    df = pd.DataFrame({"feature": list(imp), "importance": list(imp.values())})
    return df.sort_values("importance", ascending=False), cal.get("importance_kind", "")


def daily_long(daily: pd.DataFrame, window: int = 14) -> pd.DataFrame:
    """Rolling n-weighted loss per series, for the tracking chart."""
    if daily.empty:
        return daily
    d = daily.sort_values("day").copy()
    out = []
    for series, col in (("v4 model", "loss"), ("incumbent", "incumbent_loss"),
                        ("baseline", "baseline_loss")):
        if col not in d or d[col].isna().all():
            continue
        num = (d[col] * d["n"]).rolling(window, min_periods=1).sum()
        den = d["n"].where(d[col].notna(), 0).rolling(window, min_periods=1).sum()
        out.append(pd.DataFrame({"day": d["day"], "series": series, "value": num / den,
                                 "source": d["source"]}))
    return pd.concat(out, ignore_index=True)


def season_summary(daily: pd.DataFrame) -> pd.DataFrame:
    if daily.empty:
        return daily
    g = daily.assign(wl=daily["loss"] * daily["n"],
                     wi=daily["incumbent_loss"] * daily["n"],
                     wb=daily["baseline_loss"] * daily["n"],
                     wp=daily["mean_pred"] * daily["n"],
                     wo=daily["observed"] * daily["n"]).groupby("season")
    n = g["n"].sum()
    return pd.DataFrame({
        "rows": n, "days": g.size(), "source": g["source"].first(),
        "v4 loss": g["wl"].sum() / n, "incumbent loss": g["wi"].sum() / n,
        "baseline loss": g["wb"].sum() / n,
        "mean predicted": g["wp"].sum() / n, "observed": g["wo"].sum() / n,
    }).reset_index()
