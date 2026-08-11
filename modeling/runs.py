"""Write training runs to model_runs.

build_run() is pure so it can be unit-tested without a database; record() is
the only function here that touches Supabase.

spec_hash exists to catch silent spec drift: two runs with the same market and
different hashes were not measuring the same thing, and comparing their metrics
is meaningless.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import subprocess
import uuid
from datetime import datetime, timezone

from modeling.validate import HOLDOUT_SEASON, WALK_FORWARD_SEASONS


def new_run_id() -> str:
    return f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S}-{uuid.uuid4().hex[:8]}"


def spec_hash(spec) -> str:  # noqa: ANN001
    payload = json.dumps({
        "market": spec.market,
        "family": spec.family,
        "cell_sql": spec.cell_sql,
        "features": list(spec.feature_names),
        "classes": list(spec.classes or ()),
        "form_windows": list(spec.form_windows),
    }, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def git_sha() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return None


def build_run(spec, sweep_result, *, holdout, calibration,  # noqa: ANN001
              params, status: str, notes: str = "",
              version: str | None = None) -> dict:
    return {
        "run_id": new_run_id(),
        "market": spec.market,
        "spec_hash": spec_hash(spec),
        "git_sha": git_sha(),
        "data_through": f"{HOLDOUT_SEASON}-12-31",
        "train_seasons": list(WALK_FORWARD_SEASONS),
        "config": {
            "form_window": sweep_result.form_window,
            "half_life": sweep_result.half_life,
            "family": spec.family,
            "primary_metric": spec.primary_metric,
        },
        "folds": [dataclasses.asdict(f) for f in sweep_result.folds],
        "oos_metrics": sweep_result.oos,
        "holdout_metrics": holdout,
        "calibration": calibration,
        "params": params,
        "version": version,
        "status": status,
        "notes": notes,
    }


def record(run: dict) -> str:
    """Insert one run. Returns its run_id."""
    from backend.db.client import get_client

    get_client().table("model_runs").insert(run).execute()
    print(f"[modeling] recorded run {run['run_id']} "
          f"({run['market']}, {run['status']})")
    return run["run_id"]
