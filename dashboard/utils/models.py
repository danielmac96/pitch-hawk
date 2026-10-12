"""Pure helpers behind the Models page: what is served, what was validated.

No Streamlit and no Supabase here -- every function takes the rows the page
already fetched, so the judgements can be tested without credentials
(tests/dashboard/test_models.py).

Two pipelines write `model_runs`, and their rows are shaped differently:

  v2 cell models   folds = [{test_season, metrics: {...}}], status "promoted"
                   when activated, version set.
  markets_v3       folds = [{season, logloss, ...}] (flat), status always
                   "completed"; a run reaches production only through
                   `python -m modeling stage-v3` + `activate`.

So "the latest run for this market" and "what production serves" are separate
questions, and the page has to answer both.
"""

from __future__ import annotations

import pandas as pd

V3_PIPELINE = "markets_v3"

# The active row exists but game-predict does not read it: model.ts has no
# params.type == "log5" branch. Stops being true once a moneyline_v3 row is
# active together with the v3 bundle.
INERT_TYPES = {"log5"}

# (model metric, baseline metric, baseline label), first match wins. All are
# lower-is-better. Starter props are judged on MAE of the expected count:
# their P(over) is priced at the model's own median, so its log loss sits at
# ln 2 whatever the skill.
_SCORE_KEYS: tuple[tuple[str, str | None, str], ...] = (
    ("mae_expected", "mae_train_mean", "pitcher's training-season mean"),
    ("logloss", "slot_baseline_logloss", "lineup-slot rate"),
    ("logloss", "production_log5_logloss", "production log5"),
    ("logloss", "league_over85_logloss", "league-mean NB"),
    ("logloss", "league_only", "league rates"),
    ("logloss", None, ""),
    ("rmse", None, ""),
    ("brier", None, ""),
)


def pipeline_of(config) -> str:  # noqa: ANN001
    return (config or {}).get("pipeline") or "v2"


def live_stamps(*sources: list[dict]) -> dict[str, str]:
    """Latest `model_version` per market across the tables scoring writes to.

    Each source must already be ordered newest-first. `predictions` covers the
    per-pitch markets only; player props stamp `player_game_projections` and
    the pregame game markets stamp `game_predictions`, so reading one table
    reports every other market as drifted.
    """
    out: dict[str, str] = {}
    for rows in sources:
        for r in rows or []:
            if r.get("model_version"):
                out.setdefault(r["market"], r["model_version"])
    return out


def production(params: pd.DataFrame, stamps: dict[str, str]) -> pd.DataFrame:
    """Active registry rows against what live scoring actually stamped."""
    if params.empty:
        return params
    active = params[params["is_active"]].copy()
    active["live_stamp"] = active["market"].map(stamps)

    def state(r) -> str:  # noqa: ANN001
        if r.get("type") in INERT_TYPES:
            return "🚫 not read"
        if pd.isna(r["live_stamp"]):
            return "— no live rows"
        return "✅ match" if r["live_stamp"] == r["version"] else "⚠️ drift"

    active["state"] = active.apply(state, axis=1)
    return active.sort_values("market").reset_index(drop=True)


def _pick(metrics: dict) -> tuple[str, str | None, str] | None:
    for key, base, label in _SCORE_KEYS:
        if key in metrics and (base is None or base in metrics):
            return key, base, label
    return None


def scorecard(runs: pd.DataFrame, params: pd.DataFrame) -> pd.DataFrame:
    """One row per (market, pipeline): the latest run, model against baseline.

    `validation` is the walk-forward aggregate, `test` the frozen 2026
    holdout. `served` says whether that pipeline is what production runs
    for the market today -- a validated v3 run that was never staged reads
    "no".
    """
    if runs.empty:
        return pd.DataFrame()
    df = runs.copy()
    df["pipeline"] = df["config"].apply(pipeline_of)
    df = (df.sort_values("created_at", ascending=False)
            .drop_duplicates(["market", "pipeline"]))
    active = ({} if params.empty else
              params[params["is_active"]].set_index("market")["version"].to_dict())
    rows = []
    for r in df.to_dict("records"):
        oos, hold = r.get("oos_metrics") or {}, r.get("holdout_metrics") or {}
        pick = _pick(oos)
        if pick is None:  # workload / team_runs: components, no market metric
            continue
        key, base, label = pick
        v = str(active.get(r["market"], ""))
        served = v.startswith("v3_") if r["pipeline"] == V3_PIPELINE else (
            bool(r.get("version")) and v == r.get("version"))
        rows.append({
            "market": r["market"], "pipeline": r["pipeline"],
            "run": str(r["created_at"])[:10], "metric": key,
            "validation": oos.get(key),
            "val_baseline": oos.get(base) if base else None,
            "test_2026": hold.get(key),
            "test_baseline": hold.get(base) if base else None,
            "test_calibration": hold.get("calibration",
                                         hold.get("calibration_ratio")),
            "baseline": label,
            "beats_baseline": (None if not base or hold.get(base) is None
                               or hold.get(key) is None
                               else bool(hold[key] < hold[base])),
            "served": "yes" if served else "no",
        })
    return (pd.DataFrame(rows).sort_values(["market", "pipeline"])
            .reset_index(drop=True))


def unstaged_v3(runs: pd.DataFrame, params: pd.DataFrame) -> list[str]:
    """Markets with a recorded v3 run and no `v3_*` row in the registry."""
    if runs.empty:
        return []
    v3 = runs[runs["config"].apply(pipeline_of) == V3_PIPELINE]
    staged = (set() if params.empty else
              set(params[params["version"].astype(str).str.startswith("v3_")]
                  ["market"]))
    return sorted(set(v3["market"]) - staged)


def fold_frame(folds) -> pd.DataFrame:  # noqa: ANN001
    """Per-season primary metric from either pipeline's fold shape."""
    rows = []
    for f in folds or []:
        m = f.get("metrics") or f
        pick = _pick(m)
        if pick is None:
            continue
        key, base, _ = pick
        rows.append({"season": f.get("test_season", f.get("season")),
                     "metric": key, "model": m[key],
                     "baseline": m.get(base) if base else None})
    return pd.DataFrame(rows)


def live_calibration(rows: list[dict]) -> pd.DataFrame:
    """Graded projections: mean predicted probability over observed rate.

    1.0 is calibrated; 1.2 means the model says 20% more often than it
    happens. This is the number offline validation cannot give -- it is
    measured on what production actually served.
    """
    df = pd.DataFrame(rows or [])
    if df.empty:
        return df
    df = df[df["result"].isin(["hit", "miss"])].copy()
    if df.empty:
        return df
    df["p"] = df["probability"].astype(float)
    df["y"] = (df["result"] == "hit").astype(float)
    out = (df.groupby(["market", "model_version"])
             .agg(n=("y", "size"), mean_predicted=("p", "mean"),
                  observed=("y", "mean")).reset_index())
    out["ratio"] = out["mean_predicted"] / out["observed"].where(out["observed"] > 0)
    return out.round(4)
