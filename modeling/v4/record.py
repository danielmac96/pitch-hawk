"""Turn a ladder result into the record: runs, backfill, daily rollup, model.

    rows   = runs_for(lad, result)            # one model_runs row per candidate
    bf     = backfill_frame(lad, result)      # row-level OOS predictions
    daily  = daily_rollup(md, bf)             # per (market, day) metrics
    persist(store, lad, result, record=True)  # all of the above, written

Every candidate becomes a run, chosen or not: a registry that holds only
winners cannot show that a version was chosen rather than merely produced
(docs/MODELS.md). The chosen one carries the version, the gate's verdict and
the artifact key; the others say why they lost.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from modeling.v4 import evaluate as E
from modeling.v4 import ladder as LD
from modeling.v4 import learners as L
from modeling.v4 import storage as S

PIPELINE = "v4"
PROPOSAL = "P-009"
DAILY_TABLE = "v4_backfill_daily"


def version_tag() -> str:
    return f"v4_{datetime.now(timezone.utc):%Y%m%d}"


def _jsonable(o):  # noqa: ANN001
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, float) and not np.isfinite(o):
        return None
    if hasattr(o, "to_json"):
        return o.to_json()
    return str(o)


def clean(obj):  # noqa: ANN001
    """JSON round-trip with non-finite floats as null (Postgres jsonb refuses NaN)."""
    s = json.dumps(obj, default=_jsonable, allow_nan=True)
    return json.loads(s.replace("NaN", "null").replace("-Infinity", "null")
                      .replace("Infinity", "null"))


def spec_hash(md, iteration: str, feats: list[str]) -> str:  # noqa: ANN001
    payload = json.dumps({"market": md.name, "kind": md.kind, "target": md.target,
                          "grain": md.grain, "iteration": iteration,
                          "features": sorted(feats), "cap": md.cap, "line": md.line},
                         sort_keys=True)
    return "v4_" + hashlib.sha256(payload.encode()).hexdigest()[:14]


def _with_refs(c: LD.Candidate, base: LD.Candidate | None,
               inc: LD.Candidate | None) -> tuple[list, dict, dict | None]:
    """Fold/oos/holdout dicts with the baseline's and incumbent's primary
    beside the model's, so every reader compares like with like."""
    bb = {f["season"]: f["primary"] for f in (base.folds if base else [])}
    ib = {f["season"]: f["primary"] for f in (inc.folds if inc else [])}
    folds = [{**f, "baseline_primary": bb.get(f["season"]),
              "incumbent_primary": ib.get(f["season"])} for f in c.folds]
    oos = {**c.oos,
           "baseline_primary": base.oos.get("primary") if base else None,
           "incumbent_primary": inc.oos.get("primary") if inc else None}
    if c.post:
        oos["postseason"] = {
            **{k: v for k, v in c.post.items() if k != "curve"},
            "baseline_primary": (base.post or {}).get("primary") if base else None,
            "incumbent_primary": (inc.post or {}).get("primary") if inc else None}
    hold = None
    if c.holdout:
        hold = {**c.holdout,
                "baseline_primary": (base.holdout or {}).get("primary") if base else None,
                "incumbent_primary": (inc.holdout or {}).get("primary") if inc else None}
    return folds, oos, hold


def importance(lad: LD.Ladder, c: LD.Candidate) -> tuple[dict, str]:
    m = c.holdout_model
    if m is not None and hasattr(m, "permutation_importance") and LD.HOLDOUT in c.preds:
        te = lad.frame[lad.season == LD.HOLDOUT]
        try:
            return m.permutation_importance(te), \
                f"permutation, 2026 sample, increase in {E.PRIMARY[lad.md.kind]}"
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)[:200]}, "failed"
    inf = c.info or {}
    base = inf.get("base") if isinstance(inf.get("base"), dict) else inf
    return base.get("importance", {}), base.get("importance_kind", "")


def runs_for(lad: LD.Ladder, result: dict, *, git_sha: str | None,
             artifact_key: str | None = None, version: str | None = None) -> list[dict]:
    from modeling import runs as runs_mod

    md, R = lad.md, result["results"]
    base, inc = R.get("i0_baseline"), R.get("i1_incumbent")
    chosen = result["chosen"]
    rows = []
    for it, c in R.items():
        folds, oos, hold = _with_refs(c, base, inc)
        is_chosen = it == chosen
        feats = c.info.get("features") or (c.info.get("base") or {}).get("features") or []
        imp, imp_kind = importance(lad, c) if is_chosen or it in LD.MODEL_ITERATIONS \
            else ({}, "")
        if is_chosen:
            v = result["verdict"]
            status = "stageable" if v["ok"] else "held"
            notes = ("gate PASS" if v["ok"] else "gate HOLD: " + "; ".join(v["reasons"]))
            if v["notes"]:
                notes += " | " + "; ".join(v["notes"])
        else:
            status = "candidate"
            ch = R.get(chosen)
            notes = (f"not chosen: validation {E.PRIMARY[md.kind]} {c.primary:.5f} vs "
                     f"chosen {chosen} {ch.primary:.5f}" if ch and it in LD.MODEL_ITERATIONS
                     else "reference")
        rows.append(clean({
            "run_id": runs_mod.new_run_id(), "market": md.name,
            "spec_hash": spec_hash(md, it, feats), "git_sha": git_sha,
            "data_through": f"{LD.HOLDOUT}-12-31",
            "train_seasons": list(range(LD.FIRST_TRAIN, LD.HOLDOUT + 1)),
            "config": {
                "pipeline": PIPELINE, "proposal": PROPOSAL, "iteration": it,
                "family": c.family, "chosen": is_chosen, "grain": md.grain,
                "kind": md.kind, "target": md.target, "outcome": md.outcome,
                "primary_metric": E.PRIMARY[md.kind], "classes": list(md.classes),
                "cap": md.cap, "line": md.line, "features": feats,
                "n_features": len(feats), "stack": result["stack"],
                "hyperparams": c.info.get("hyperparams"),
                "max_train_rows": lad.max_rows, "test_seasons": lad.seasons,
                "exclude_from_aggregate": list(LD.EXCLUDE),
                "seconds": c.seconds, "served_as": md.served_as,
                "incumbent": md.incumbent.label if md.incumbent else None,
                "baseline_group": md.baseline_group,
            },
            "folds": folds, "oos_metrics": oos, "holdout_metrics": hold,
            "calibration": {"test_2026": c.curve_test, "validation": c.curve_val,
                            "postseason": (c.post or {}).get("curve", []),
                            "postseason_by_season": c.post_folds,
                            "importance": imp, "importance_kind": imp_kind},
            "params": {"info": {k: v for k, v in c.info.items() if k != "features"},
                       "fold_info": {str(k): v for k, v in c.fold_info.items()},
                       "artifact": artifact_key if is_chosen else None},
            "version": version if is_chosen else None,
            "status": status, "notes": notes,
        }))
    return rows


# ── backfill ────────────────────────────────────────────────────────────────

def row_loss(kind: str, pred: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Per-row contribution to the primary metric (its mean IS the metric)."""
    if kind == "binary":
        p = np.clip(pred, E.EPS, 1 - E.EPS)
        return -(y * np.log(p) + (1 - y) * np.log(1 - p))
    if kind == "multiclass":
        P = np.clip(pred, E.EPS, 1)
        P = P / P.sum(axis=1, keepdims=True)
        return -np.log(P[np.arange(len(y)), y.astype(int)])
    if kind == "count":
        P = pred / np.maximum(pred.sum(axis=1, keepdims=True), 1e-12)
        F = np.cumsum(P, axis=1)
        ind = (np.arange(P.shape[1])[None, :] >= np.minimum(y, P.shape[1] - 1)[:, None])
        return ((F - ind) ** 2).sum(axis=1)
    mu, sd = pred[:, 0], np.maximum(pred[:, 1], 1e-3)
    z = (y - mu) / sd
    return 0.5 * z ** 2 + np.log(sd) + 0.5 * np.log(2 * np.pi)


def _headline(md, pred: np.ndarray) -> np.ndarray:  # noqa: ANN001
    """One number per row for the daily 'mean predicted' line."""
    if md.kind == "binary":
        return pred
    if md.kind == "multiclass":
        return pred[:, 0]
    if md.kind == "count":
        return pred @ np.arange(pred.shape[1])
    return pred[:, 0]


def backfill_frame(lad: LD.Ladder, result: dict, *, run_id: str, version: str) -> pd.DataFrame:
    md, R = lad.md, result["results"]
    c = R[result["chosen"]]
    seasons = [s for s in lad.seasons if s in c.preds]
    mask = np.isin(lad.season, seasons)
    fr = lad.frame[mask]
    # Rows are in frame order within each season; preds are stored per season
    # in that same order.
    order = np.concatenate([np.flatnonzero(lad.season == s) for s in seasons])
    fr = lad.frame.iloc[order]
    keep = [k for k in md.keys if k in fr] + [k for k in ("season", "game_date", "day")
                                              if k in fr and k not in md.keys]
    out = fr[keep].reset_index(drop=True).copy()
    y = lad.y[order]
    out["y"] = y
    pred = np.concatenate([c.preds[s] for s in seasons])
    out["pred"] = _headline(md, pred).astype(np.float32)
    out["loss"] = row_loss(md.kind, pred, y).astype(np.float32)
    if md.kind == "multiclass":
        for k, cls in enumerate(md.classes):
            out[f"p_{cls}"] = pred[:, k]
    elif md.kind == "count":
        for k in range(pred.shape[1]):
            out[f"pmf_{k}"] = pred[:, k]
        if md.line is not None:
            out["p_over"] = E._over(pred, md.line).astype(np.float32)
    elif md.kind == "gaussian":
        out["sigma"] = pred[:, 1]
    for label, it in (("incumbent", "i1_incumbent"), ("baseline", "i0_baseline")):
        r = R.get(it)
        if r is None:
            continue
        rp = np.concatenate([r.preds[s] for s in seasons])
        out[f"{label}_pred"] = _headline(md, rp).astype(np.float32)
        out[f"{label}_loss"] = row_loss(md.kind, rp, y).astype(np.float32)
    out["source"] = np.where(out["season"] == LD.HOLDOUT, "test_2026", "walk_forward")
    post = _post_backfill(lad, result, keep)
    if post is not None:
        out = pd.concat([out, post], ignore_index=True)
    out["iteration"] = result["chosen"]
    out["run_id"] = run_id
    out["version"] = version
    return out


def _post_backfill(lad: LD.Ladder, result: dict, keep: list[str]) -> pd.DataFrame | None:
    """The postseason rows, each predicted by its season's model."""
    md, R = lad.md, result["results"]
    c = R[result["chosen"]]
    ps = sorted(c.post_preds)
    if not ps:
        return None
    order = np.concatenate([np.flatnonzero(lad.post_season == s) for s in ps])
    fr = lad.post_frame.iloc[order]
    out = fr[[k for k in keep if k in fr]].reset_index(drop=True).copy()
    y = lad.post_y[order]
    pred = np.concatenate([c.post_preds[s] for s in ps])
    out["y"] = y
    out["pred"] = _headline(md, pred).astype(np.float32)
    out["loss"] = row_loss(md.kind, pred, y).astype(np.float32)
    if md.kind == "multiclass":
        for k, cls in enumerate(md.classes):
            out[f"p_{cls}"] = pred[:, k]
    elif md.kind == "count":
        for k in range(pred.shape[1]):
            out[f"pmf_{k}"] = pred[:, k]
        if md.line is not None:
            out["p_over"] = E._over(pred, md.line).astype(np.float32)
    elif md.kind == "gaussian":
        out["sigma"] = pred[:, 1]
    for label, it in (("incumbent", "i1_incumbent"), ("baseline", "i0_baseline")):
        r = R.get(it)
        if r is None or not r.post_preds:
            continue
        rp = np.concatenate([r.post_preds[s] for s in ps])
        out[f"{label}_pred"] = _headline(md, rp).astype(np.float32)
        out[f"{label}_loss"] = row_loss(md.kind, rp, y).astype(np.float32)
    out["source"] = "postseason"
    return out


def daily_rollup(md, bf: pd.DataFrame) -> pd.DataFrame:  # noqa: ANN001
    if bf.empty:
        return pd.DataFrame()
    day = pd.to_datetime(bf["game_date"]).dt.date if "game_date" in bf else bf["day"]
    g = bf.assign(_d=day).groupby("_d")
    obs = (bf["y"] if md.kind != "multiclass" else (bf["y"] == 0).astype(float))
    if md.kind == "count":
        obs = np.minimum(bf["y"], md.cap)
    out = pd.DataFrame({
        "n": g.size(),
        "season": g["season"].first(),
        "mean_pred": g["pred"].mean(),
        "observed": obs.groupby(day.to_numpy()).mean().reindex(g.size().index).to_numpy(),
        "loss": g["loss"].mean(),
    })
    for c in ("incumbent_loss", "baseline_loss"):
        if c in bf:
            out[c] = g[c].mean()
    out["source"] = g["source"].first()
    out = out.reset_index().rename(columns={"_d": "day"})
    out["market"] = md.name
    out["primary_metric"] = E.PRIMARY[md.kind]
    out["run_id"] = bf["run_id"].iat[0]
    out["version"] = bf["version"].iat[0]
    return out


def publish_daily(daily: pd.DataFrame) -> int:
    from warehouse.config import supabase_client

    if daily.empty:
        return 0
    rows = clean([{**r, "day": str(r["day"])} for r in daily.to_dict("records")])
    db = supabase_client()
    for i in range(0, len(rows), 500):
        db.table(DAILY_TABLE).upsert(rows[i:i + 500], on_conflict="market,day").execute()
    return len(rows)


# ── everything, for one market ──────────────────────────────────────────────

def persist(store, lad: LD.Ladder, result: dict, *, record: bool,  # noqa: ANN001
            publish: bool, save_artifact: bool = True) -> dict:
    from modeling import runs as runs_mod

    md = lad.md
    chosen = result["chosen"]
    if chosen is None:
        return {"market": md.name, "chosen": None}
    version = version_tag()
    run_id_hint = runs_mod.new_run_id()
    artifact_key = None
    if save_artifact and store is not None:
        model = lad.production_fit(chosen)
        artifact_key = S.put_artifact(store, md.name, run_id_hint, model, {
            "version": version, "iteration": chosen, "kind": md.kind,
            "grain": md.grain, "features": model.info().get("features")
            or (model.info().get("base") or {}).get("features"),
            "trained_through": LD.HOLDOUT, "status": "stageable"
            if result["verdict"]["ok"] else "held"})
    rows = runs_for(lad, result, git_sha=runs_mod.git_sha(),
                    artifact_key=artifact_key, version=version)
    chosen_row = next(r for r in rows if r["config"]["chosen"])
    bf = backfill_frame(lad, result, run_id=chosen_row["run_id"], version=version)
    daily = daily_rollup(md, bf)
    if store is not None:
        S.put_backfill(store, md.name, bf, {
            "run_id": chosen_row["run_id"], "version": version, "iteration": chosen,
            "kind": md.kind, "keys": list(md.keys), "through": str(bf["game_date"].max())
            if "game_date" in bf else None})
    if record:
        for r in rows:
            runs_mod.record(r)
    n_daily = publish_daily(daily) if publish else 0
    return {"market": md.name, "chosen": chosen, "verdict": result["verdict"],
            "runs": len(rows), "backfill_rows": len(bf), "daily_rows": n_daily,
            "rows": rows, "backfill": bf, "daily": daily}
