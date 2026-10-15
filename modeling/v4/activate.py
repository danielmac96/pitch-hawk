"""Stage and activate v4 markets -- the step that puts a v4 model on the site.

    python -m modeling v4 activate <market|group>... [--dry-run]

For each market:

  1. the latest CHOSEN v4 run in model_runs, which must be `stageable`
     (the v4 gate passed: modeling/v4/gate.py). A held run is refused; there
     is no override, the same rule as every other registry path here.
  2. in-game markets (pitch, pa_state, rog, live_total grains): the R2
     production fit is exported (modeling/v4/export.py) into v4_models, and
     the TypeScript scorer serves it ("serving": "trees").
     Pregame markets are served by the publisher ("serving": "offline"):
     `python -m modeling v4 serve` scores the slate with the R2 fit.
  3. a model_params row {type: "v4", serving, run_id, fallback} is inserted
     and activated atomically (activate_model). `fallback` is the params of
     the version it replaces, which game-predict / live-poll fall back to for
     anything v4 did not cover -- and `rollback_model` restores outright.
"""

from __future__ import annotations

import json

from modeling import registry
from modeling.v4 import catalog as C
from modeling.v4 import export as X
from modeling.v4 import storage as S

TREE_GRAINS = {"pitch", "pa_state", "rog", "live_total"}


def latest_chosen(db, market: str) -> dict | None:  # noqa: ANN001
    rows = (db.table("model_runs").select("run_id,version,status,oos_metrics,holdout_metrics,"
                                          "config,params,notes,created_at")
            .eq("market", market).eq("config->>pipeline", "v4")
            .eq("config->>chosen", "true").order("created_at", desc=True).limit(1)
            .execute().data or [])
    return rows[0] if rows else None


def activate(store, markets: list[str], *, dry_run: bool = False) -> dict:  # noqa: ANN001
    from warehouse.config import supabase_client

    db = supabase_client()
    out = {}
    for md in C.resolve(markets):
        run = latest_chosen(db, md.name)
        if not run:
            out[md.name] = "no v4 run"
            continue
        if run["status"] != "stageable":
            out[md.name] = f"refused: run {run['run_id']} is {run['status']} ({run['notes']})"
            continue
        model, meta = S.get_artifact(store, md.name)
        if model is None:
            out[md.name] = "refused: no production artifact in R2"
            continue
        version = run["version"] or meta.get("version")
        serving = "trees" if md.grain in TREE_GRAINS else "offline"
        current = registry.active(md.name)
        params = {
            "type": "v4", "serving": serving, "run_id": run["run_id"],
            "iteration": run["config"].get("iteration"), "kind": md.kind,
            "artifact": meta.get("key"),
            "fallback": (current or {}).get("params"),
            "fallback_version": (current or {}).get("version"),
        }
        metrics = {"oos": run["oos_metrics"], "holdout": run["holdout_metrics"]}
        spec = None
        if serving == "trees":
            spec = X.export(model)
            params["spec_kb"] = round(X.size_kb(spec), 1)
        if dry_run:
            out[md.name] = {"version": version, "serving": serving,
                            "replaces": params["fallback_version"],
                            "spec_kb": params.get("spec_kb")}
            continue
        if spec is not None:
            db.table("v4_models").upsert({
                "market": md.name, "version": version, "spec": json.loads(json.dumps(spec)),
                "size_kb": params["spec_kb"], "run_id": run["run_id"]},
                on_conflict="market,version").execute()
        registry.insert_version(md.name, version, params, metrics,
                                notes=f"v4 {run['config'].get('iteration')} ({serving}); "
                                      f"replaces {params['fallback_version']}")
        registry.activate(md.name, version)
        out[md.name] = {"activated": version, "serving": serving,
                        "replaces": params["fallback_version"]}
    return out
