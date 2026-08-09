"""python -m modeling <command> -- the whole workbench loop.

    build     pull features from R2 into the local cell cache (the only
              command that touches R2)
    sweep     walk-forward over every (form_window, half_life), print results
    train     sweep, pick the best, evaluate on the 2026 holdout, record the
              run; --promote also gates and activates
    baseline  score the currently-active params through the same walk-forward
              harness so the gate has a comparable number
    list/show/status/activate/rollback   registry operations

There is deliberately no --force. The gate holding a version is the gate
working; overriding it is a decision that belongs in a human's hands via an
explicit `activate`.
"""

from __future__ import annotations

import argparse
import json

from modeling import features, registry, runs, validate
from modeling.spec import all_markets, get_spec


def _store():
    from warehouse.config import r2_config
    from warehouse.store import R2Store
    return R2Store(r2_config())


def _seasons(arg: str | None):
    if not arg:
        return None
    lo, _, hi = arg.partition("-")
    return list(range(int(lo), int(hi or lo) + 1))


def cmd_build(args) -> int:
    from warehouse import duck

    store = _store()
    con = duck.connect(store)
    seasons = _seasons(args.seasons)
    # Both spines: pitch-grain markets join form_spine, plate-appearance-grain
    # markets join form_spine_ab. Building both here keeps `build` a single
    # R2 pass -- the cost rule in the plan header.
    features.build_form_spine(store, seasons=seasons, con=con)
    features.build_form_spine_ab(store, seasons=seasons, con=con)
    markets = [args.market] if args.market else list(all_markets())
    for market in markets:
        features.build_cells(store, get_spec(market), seasons=seasons, con=con)
    return 0


def cmd_sweep(args) -> int:
    spec = get_spec(args.market)
    validate.sweep(spec, features.load_cells(spec))
    return 0


def cmd_train(args) -> int:
    spec = get_spec(args.market)
    cells = features.load_cells(spec)

    results = validate.sweep(spec, cells)
    winner = validate.best(results, spec)
    print(f"[modeling] best: window={winner.form_window} "
          f"half_life={winner.half_life} oos={winner.oos}")

    # Holdout: fit on everything before 2026, evaluate on 2026 only.
    from modeling.fit import fit
    pre = cells[cells["season"] < validate.HOLDOUT_SEASON]
    held = cells[cells["season"] == validate.HOLDOUT_SEASON]
    holdout_fit = fit(spec, pre, form_window=winner.form_window,
                      half_life=winner.half_life)
    holdout = (validate.evaluate(spec, holdout_fit, held, winner.form_window)
               if len(held) else None)
    print(f"[modeling] holdout({validate.HOLDOUT_SEASON}): {holdout}")

    # Production fit uses EVERY season including the holdout. The holdout
    # verified the recipe; the shipped coefficients should see all the data.
    final = fit(spec, cells, form_window=winner.form_window,
                half_life=winner.half_life)
    params = spec.to_params(final, winner.form_window)

    promote, reason = (False, "not requested")
    if args.promote:
        promote, reason = registry.gate(spec, winner.oos,
                                        registry.active_oos(spec.market))
    print(f"[modeling] gate: {reason}")

    version = registry.make_version() if args.promote else None
    run = runs.build_run(spec, winner, holdout=holdout, calibration=None,
                         params=params,
                         status="promoted" if promote else "completed",
                         notes=reason, version=version)
    runs.record(run)

    if args.promote:
        registry.insert_version(spec.market, version, params, winner.oos,
                                notes=reason)
        if promote:
            registry.activate(spec.market, version)
    return 0


def cmd_baseline(args) -> int:
    """Give the live versions comparable out-of-sample numbers.

    Their params are known, so they are SCORED through the walk-forward harness
    without refitting. Without this the first gate has nothing to compare to.
    """
    for market in ([args.market] if args.market else all_markets()):
        spec = get_spec(market)
        row = registry.active(market)
        if not row:
            print(f"[modeling] {market}: no active version, skipping")
            continue
        cells = features.load_cells(spec)
        from modeling.fit import from_params
        params = row["params"]
        try:
            stand_in = from_params(params, spec)
        except ValueError as exc:
            # Skip loudly. Recording an uncomputable baseline is worse than
            # having none: the gate would compare against it.
            print(f"[modeling] {market}: SKIPPED -- {exc}")
            continue
        window = params.get("form_window", spec.form_windows[0])
        folds = [validate.FoldResult(
            season, 0.0, float(cells[cells["season"] == season]["n"].sum()),
            validate.evaluate(spec, stand_in,
                              cells[cells["season"] == season], window))
            for season in validate.WALK_FORWARD_SEASONS
            if len(cells[cells["season"] == season])]
        sweep_like = validate.SweepResult(window, None, folds,
                                          validate.aggregate(folds))
        runs.record(runs.build_run(
            spec, sweep_like, holdout=None, calibration=None, params=params,
            status="completed", version=row["version"],
            notes="baseline backfill: active params scored, not refitted"))
        print(f"[modeling] {market} {row['version']} baseline: {sweep_like.oos}")
    return 0


def cmd_list(args) -> int:
    from backend.db.client import get_client
    rows = (get_client().table("model_params")
            .select("market, version, is_active, activated_at, metrics")
            .order("market").execute().data)
    for r in rows:
        flag = "ACTIVE" if r["is_active"] else "      "
        print(f"{flag} {r['market']:<16} {r['version']:<14} {r['metrics']}")
    return 0


def cmd_show(args) -> int:
    print(json.dumps(registry.active(args.market), indent=2))
    return 0


def cmd_status(args) -> int:
    from backend.db.client import get_client
    client = get_client()
    for market in all_markets():
        row = registry.active(market)
        live = (client.table("predictions").select("model_version")
                .eq("market", market).order("created_at", desc=True)
                .limit(1).execute().data)
        stamped = live[0]["model_version"] if live else None
        registered = row["version"] if row else None
        flag = "OK " if stamped == registered else "!! "
        print(f"{flag}{market:<16} registry={registered} live={stamped}")
        if stamped != registered:
            print("     ^ mismatch: live-poll may need a redeploy")
    return 0


def cmd_activate(args) -> int:
    registry.activate(args.market, args.version)
    return 0


def cmd_rollback(args) -> int:
    registry.rollback(args.market)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m modeling",
                                 description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="build feature cells from R2 (touches R2)")
    b.add_argument("--market")
    b.add_argument("--seasons", help="e.g. 2019-2026")

    for name, helptext in (("train", "sweep, validate, record, optionally promote"),
                           ("sweep", "walk-forward over every hyperparameter pair")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("market")
        if name == "train":
            p.add_argument("--promote", action="store_true",
                           help="gate on OOS metrics and activate if it passes")

    bl = sub.add_parser("baseline", help="score active params for a comparable OOS number")
    bl.add_argument("--market")

    sub.add_parser("list", help="every version, per market")
    sub.add_parser("status", help="registry version vs what live scoring stamps")

    for name, helptext in (("show", "active params for one market"),
                           ("rollback", "reactivate the prior version")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("market")

    a = sub.add_parser("activate", help="make a version live")
    a.add_argument("market")
    a.add_argument("version")
    return ap


_COMMANDS = {
    "build": cmd_build, "sweep": cmd_sweep, "train": cmd_train,
    "baseline": cmd_baseline, "list": cmd_list, "show": cmd_show,
    "status": cmd_status, "activate": cmd_activate, "rollback": cmd_rollback,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return _COMMANDS[args.command](args)
