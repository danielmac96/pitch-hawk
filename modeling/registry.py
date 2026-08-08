"""model_params reads/writes and the promotion gate.

The gate compares OUT-OF-SAMPLE walk-forward metrics. The retired trainer
compared in-sample training loss, which cannot detect overfitting -- a version
that memorized its training cells looked strictly better and would promote.

Activation goes through the existing activate_model()/rollback_model() RPCs,
which are SECURITY DEFINER and atomic. Never flip is_active with an UPDATE:
the partial unique index permits exactly one active row per market, and a
two-statement swap can transiently violate it.
"""

from __future__ import annotations

from datetime import datetime, timezone

GATE_TOLERANCE = 0.02
SIGMA_BAND = (0.63, 0.73)


def make_version() -> str:
    return "v2_" + datetime.now(timezone.utc).strftime("%Y%m%d")


def gate(spec, new_oos: dict, active_oos: dict | None) -> tuple[bool, str]:  # noqa: ANN001
    """Decide promotion from out-of-sample metrics. Returns (promote, reason)."""
    key = spec.primary_metric
    new = new_oos.get(key)
    if new is None:
        return False, f"HELD: new run has no {key} -- cannot compare"

    # Regression veto: a mis-scaled sigma produces confidently wrong
    # probabilities while RMSE looks fine.
    if spec.family == "linear":
        cov = new_oos.get("sigma_coverage")
        if cov is None:
            return False, "HELD: linear model has no sigma_coverage"
        if not (SIGMA_BAND[0] <= cov <= SIGMA_BAND[1]):
            return False, (f"HELD: sigma_coverage {cov} outside "
                           f"{SIGMA_BAND} -- sigma is mis-scaled")

    if not active_oos or active_oos.get(key) is None:
        return True, f"no active baseline ({key}={new})"

    old = active_oos[key]
    worse = (new > old * (1 + GATE_TOLERANCE)
             if spec.metric_direction == "lower"
             else new < old * (1 - GATE_TOLERANCE))
    if worse:
        return False, (f"HELD: {key} {new} worse than active {old} "
                       f"by more than {GATE_TOLERANCE:.0%}")
    return True, f"{key} {new} vs active {old}"


def active(market: str) -> dict | None:
    from backend.db.client import get_client

    rows = (get_client().table("model_params")
            .select("version, params, metrics, activated_at")
            .eq("market", market).eq("is_active", True).limit(1)
            .execute().data)
    return rows[0] if rows else None


def active_oos(market: str) -> dict | None:
    """Out-of-sample metrics for the live version, from its baseline run."""
    from backend.db.client import get_client

    row = active(market)
    if not row:
        return None
    runs = (get_client().table("model_runs")
            .select("oos_metrics")
            .eq("market", market).eq("version", row["version"])
            .order("created_at", desc=True).limit(1)
            .execute().data)
    return runs[0]["oos_metrics"] if runs else None


def insert_version(market: str, version: str, params: dict, metrics: dict,
                   *, notes: str) -> None:
    """Insert inactive. Activation is always a separate, explicit step."""
    from backend.db.client import get_client

    get_client().table("model_params").upsert({
        "market": market, "version": version, "params": params,
        "metrics": metrics, "training_rows": int(metrics.get("n") or 0),
        "is_active": False, "notes": notes,
    }, on_conflict="market,version").execute()
    print(f"[modeling] inserted {market} {version} (inactive): {notes}")


def activate(market: str, version: str) -> None:
    from backend.db.client import get_client

    get_client().rpc("activate_model",
                     {"p_market": market, "p_version": version}).execute()
    print(f"[modeling] ACTIVATED {market} {version}")


def rollback(market: str) -> None:
    from backend.db.client import get_client

    get_client().rpc("rollback_model", {"p_market": market}).execute()
    print(f"[modeling] rolled back {market}")
