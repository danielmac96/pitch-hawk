"""Model registry CLI — one place to see, test, ship, and undo model versions.

The registry itself lives in Supabase (model_params + the activate_model /
rollback_model RPCs — see docs/MODELS.md); this wraps it so day-to-day model
ops are one command instead of hand-written SQL.

Usage:
    python scripts/models.py list                      # every version, per market
    python scripts/models.py show pitch_result         # active row's params/metrics
    python scripts/models.py show pitch_result --version v1_20260707
    python scripts/models.py status [--days 7]         # what's live + graded results
    python scripts/models.py activate pitch_result v2_20260718
    python scripts/models.py rollback pitch_result
    python scripts/models.py train --dry-run           # passthrough to train_models.py

Requires SUPABASE_URL / SUPABASE_KEY in .env (service_role for activate,
rollback, and train — the RPCs are revoked from anon/authenticated).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.db.client import get_client  # noqa: E402

MARKETS = ["pitch_result", "ab_result", "pitch_speed_ou", "ab_pitches_ou",
           "game_moneyline"]


def _table(rows: list[dict], cols: list[str]) -> str:
    """Plain fixed-width table; empty cells for missing keys."""
    cells = [[("" if r.get(c) is None else str(r.get(c))) for c in cols] for r in rows]
    widths = [max(len(c), *(len(row[i]) for row in cells)) if cells else len(c)
              for i, c in enumerate(cols)]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    lines = [fmt.format(*cols), fmt.format(*("-" * w for w in widths))]
    lines += [fmt.format(*row) for row in cells]
    return "\n".join(lines)


def cmd_list(client, _args) -> int:
    rows = client.table("model_params") \
        .select("market,version,is_active,trained_at,activated_at,metrics,notes") \
        .order("market").order("trained_at", desc=True).execute().data or []
    for r in rows:
        r["active"] = "*" if r.get("is_active") else ""
        r["metrics"] = json.dumps(r.get("metrics") or {})
        r["trained_at"] = (r.get("trained_at") or "")[:16]
        r["activated_at"] = (r.get("activated_at") or "")[:16]
    print(_table(rows, ["market", "version", "active", "trained_at",
                        "activated_at", "metrics", "notes"]))
    return 0


def cmd_show(client, args) -> int:
    q = client.table("model_params") \
        .select("market,version,is_active,trained_at,activated_at,params,metrics,notes") \
        .eq("market", args.market)
    q = q.eq("version", args.version) if args.version else q.eq("is_active", True)
    rows = q.execute().data or []
    if not rows:
        which = args.version or "active"
        print(f"no {which} row for market {args.market}", file=sys.stderr)
        return 1
    print(json.dumps(rows[0], indent=2, default=str))
    return 0


def cmd_status(client, args) -> int:
    active = client.table("model_params") \
        .select("market,version,metrics,activated_at").eq("is_active", True) \
        .execute().data or []
    by_market = {r["market"]: r for r in active}

    cutoff = (datetime.now(timezone.utc) - timedelta(days=args.days)).isoformat()
    preds = client.table("predictions") \
        .select("market,model_version,result,profit_units") \
        .gte("created_at", cutoff).execute().data or []

    agg: dict[tuple[str, str], dict] = {}
    for p in preds:
        key = (p.get("market") or "?", p.get("model_version") or "?")
        a = agg.setdefault(key, {"n": 0, "graded": 0, "wins": 0, "profit": 0.0})
        a["n"] += 1
        if p.get("result") in ("win", "loss", "push"):
            a["graded"] += 1
            a["wins"] += 1 if p["result"] == "win" else 0
            a["profit"] += float(p.get("profit_units") or 0.0)

    rows = []
    for market in MARKETS:
        act = by_market.get(market)
        versions = sorted({v for (m, v) in agg if m == market})
        scored = [v for v in versions] or [act["version"] if act else "-"]
        for v in scored:
            a = agg.get((market, v), {"n": 0, "graded": 0, "wins": 0, "profit": 0.0})
            win_rate = f"{a['wins'] / a['graded']:.3f}" if a["graded"] else ""
            rows.append({
                "market": market,
                "active": act["version"] if act else "(heuristic fallback)",
                "scored_by": v,
                f"preds_{args.days}d": a["n"],
                "graded": a["graded"],
                "win_rate": win_rate,
                "profit_u": f"{a['profit']:+.2f}" if a["graded"] else "",
            })
    print(_table(rows, ["market", "active", "scored_by", f"preds_{args.days}d",
                        "graded", "win_rate", "profit_u"]))
    print("\n'active' is the registry; 'scored_by' is what live predictions "
          "actually used. They should match after the next live-poll redeploy.")
    return 0


def cmd_activate(client, args) -> int:
    client.rpc("activate_model", {"p_market": args.market,
                                  "p_version": args.version}).execute()
    print(f"activated {args.market} -> {args.version}")
    return 0


def cmd_rollback(client, args) -> int:
    res = client.rpc("rollback_model", {"p_market": args.market}).execute()
    print(f"rolled back {args.market} -> {res.data}")
    return 0


def cmd_train(_client, args) -> int:
    script = Path(__file__).resolve().parent / "train_models.py"
    return subprocess.call([sys.executable, str(script), *args.train_args])


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="models.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="every registered version, per market")

    p = sub.add_parser("show", help="dump one row's params + metrics as JSON")
    p.add_argument("market", choices=MARKETS)
    p.add_argument("--version", help="default: the active row")

    p = sub.add_parser("status", help="active version per market + graded results")
    p.add_argument("--days", type=int, default=7)

    p = sub.add_parser("activate", help="atomic swap via activate_model RPC")
    p.add_argument("market", choices=MARKETS)
    p.add_argument("version")

    p = sub.add_parser("rollback", help="reactivate the previously active version")
    p.add_argument("market", choices=MARKETS)

    p = sub.add_parser("train", help="fit + register new versions (train_models.py)")
    p.add_argument("train_args", nargs=argparse.REMAINDER,
                   help="flags passed through, e.g. --dry-run / --force / --emit DIR")
    return ap


COMMANDS = {"list": cmd_list, "show": cmd_show, "status": cmd_status,
            "activate": cmd_activate, "rollback": cmd_rollback, "train": cmd_train}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    client = None if args.cmd == "train" else get_client()
    return COMMANDS[args.cmd](client, args)


if __name__ == "__main__":
    sys.exit(main())
