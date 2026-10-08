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
    markets = [args.market] if args.market else list(all_markets())
    specs = [get_spec(m) for m in markets]
    # Only the spines these markets actually join. This used to build the two
    # pitcher spines unconditionally, which made a batter market unbuildable
    # without editing the CLI -- exactly the market-name branching the spec
    # contract exists to avoid.
    needed = {s for spec in specs for s in spec.spines}
    features.build_spines(store, needed, seasons=seasons, con=con)
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


def cmd_pa(args) -> int:
    """Tune the ratings, walk-forward the PA outcome model, record the run.

    Records a model_runs row (market `pa_outcome`) holding the fitted params
    AND the rating configs -- the nightly ratings publish reads the configs
    from the active `pa_outcome` row, so the hyperparameters a model was
    validated with are the ones production rates players by. Never promotes.
    """
    import numpy as np

    from modeling import pa_model as P
    from modeling import runs as runs_mod

    pa = P.load_pa(_store())
    pa, configs = P.attach_ratings(pa, tune=True)
    print("[pa] rating configs:", P.dumps(configs), flush=True)
    X = P.design(pa)
    y = pa["y"].to_numpy(int)
    season = pa["season"].to_numpy(int)

    folds = P.walk_forward(pa, X, C=args.C)
    oos = P.aggregate(folds)
    print("[pa] walk-forward aggregate:", oos, flush=True)

    pre = (season >= P.FIRST_TRAIN_SEASON) & (season < P.HOLDOUT)
    held = season == P.HOLDOUT
    holdout = None
    if held.any():
        hp = P.fit(X[pre], y[pre], C=args.C)
        holdout = P.metrics(P.predict(hp, X[held]), y[held])
        L = pa[[f"L_{c}" for c in range(P.NC)]].to_numpy()
        holdout["league_only"] = P.metrics(L[held], y[held])["logloss"]
        print("[pa] 2026 holdout:", holdout, flush=True)

    final = P.fit(X[season >= P.FIRST_TRAIN_SEASON],
                  y[season >= P.FIRST_TRAIN_SEASON], C=args.C)
    final["ratings"] = {k: (v.to_json() if hasattr(v, "to_json") else v)
                        for k, v in configs.items()}
    coef = np.asarray(final["coef"])
    for i, f in enumerate(P.FEATURES):
        print(f"  {f:>10} " + " ".join(f"{v:+.3f}" for v in coef[:, i]))

    if args.record:
        run = {
            "run_id": runs_mod.new_run_id(), "market": "pa_outcome",
            "spec_hash": "pa_multinomial_v1", "git_sha": runs_mod.git_sha(),
            "data_through": f"{P.HOLDOUT}-12-31",
            "train_seasons": list(range(P.FIRST_TRAIN_SEASON, P.HOLDOUT + 1)),
            "config": {"family": "pa_multinomial", "C": args.C,
                       "primary_metric": "logloss"},
            "folds": folds, "oos_metrics": oos, "holdout_metrics": holdout,
            "calibration": None, "params": final, "version": None,
            "status": "completed",
            "notes": "lab run: PA outcome model + rating configs",
        }
        runs_mod.record(run)
    return 0


def cmd_markets(args) -> int:
    """Every player and game market, walk-forward, stacked on the PA model."""
    from modeling import markets

    markets.run(_store(), record=args.record, C=args.C)
    return 0


def cmd_publish_ratings(args) -> int:
    """Nightly: today's ratings -> Supabase model_ratings (serving inputs)."""
    from modeling import publish_ratings

    return publish_ratings.main(_store(), dry_run=args.dry_run)


# pitcher_bb is deliberately absent. On the 2026-10-08 run its expected-walks
# MAE (1.063) did not beat the pitcher's own average (1.056) and its 2026
# holdout calibration was 0.90, so it stays on base_v1 until a run shows it
# winning. Stage it explicitly with --market pitcher_bb to override.
V3_MARKETS = ("pa_outcome", "workload", "team_runs", "game_moneyline",
              "batter_hit", "batter_hr", "batter_tb15", "batter_hrr",
              "pitcher_k", "pitcher_hits", "pitcher_outs", "pitcher_er")


def cmd_stage_v3(args) -> int:
    """Copy the latest markets-v3 run per market into model_params, INACTIVE.

    The lab and CI only record runs. This is the human step that turns a run
    into a version, named v3_<YYYYMMDD> so the edge functions (and anyone
    reading model_version on a row) can tell the families apart. Activation
    is still a separate `python -m modeling activate <market> <version>`,
    pa_outcome first: the nightly ratings publish reads its rating configs.
    """
    from datetime import date

    from warehouse.config import supabase_client

    version = args.version or f"v3_{date.today():%Y%m%d}"
    client = supabase_client()
    markets = tuple(args.market) if args.market else V3_MARKETS
    for market in markets:
        rows = (client.table("model_runs")
                .select("run_id, params, oos_metrics, config, created_at")
                .eq("market", market).order("created_at", desc=True).limit(10)
                .execute().data)
        rows = [r for r in rows if (r.get("config") or {}).get("pipeline") == "markets_v3"]
        if not rows:
            print(f"[modeling] {market}: no markets_v3 run recorded; skipped")
            continue
        r = rows[0]
        registry.insert_version(market, version, r["params"], r.get("oos_metrics") or {},
                                notes=f"staged from model_runs {r['run_id']}")
    print(f"\nActivate in this order (pa_outcome first -- publish-ratings reads it):\n"
          + "\n".join(f"  python -m modeling activate {m} {version}" for m in markets))
    return 0


def cmd_research(args) -> int:
    """Run a read-only lab diagnostic from modeling/research/."""
    import importlib

    mod = importlib.import_module(f"modeling.research.{args.name}")
    mod.main(_store(), args)
    return 0


def cmd_list(args) -> int:
    from warehouse.config import supabase_client as get_client
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
    from warehouse.config import supabase_client as get_client
    client = get_client()
    for market in all_markets():
        row = registry.active(market)
        # Look wherever this market's output actually lands. Per-pitch and
        # per-plate-appearance markets stamp `predictions`; the batter markets
        # are per-GAME and stamp `player_game_projections` instead, so reading
        # only `predictions` reported live=None for them forever and printed a
        # redeploy warning for a pipeline that was working correctly.
        stamped = None
        for table, ordering in (("predictions", "created_at"),
                                ("player_game_projections", "updated_at")):
            hit = (client.table(table).select("model_version")
                   .eq("market", market).order(ordering, desc=True)
                   .limit(1).execute().data)
            if hit:
                stamped = hit[0]["model_version"]
                break
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

    pa = sub.add_parser("pa", help="PA outcome model: tune ratings, walk-forward, record")
    pa.add_argument("--C", type=float, default=1.0)
    pa.add_argument("--record", action="store_true")
    mk = sub.add_parser("markets", help="all player/game markets: walk-forward, record")
    mk.add_argument("--C", type=float, default=1.0)
    mk.add_argument("--record", action="store_true")
    pr = sub.add_parser("publish-ratings", help="today's ratings -> model_ratings")
    pr.add_argument("--dry-run", action="store_true")
    sv = sub.add_parser("stage-v3", help="latest markets-v3 runs -> model_params (inactive)")
    sv.add_argument("--version", default=None)
    sv.add_argument("--market", action="append",
                    help="stage only these markets (repeatable); default: every v3 market that beat its baseline")
    rs = sub.add_parser("research", help="read-only lab diagnostic (modeling/research/)")
    rs.add_argument("name")
    rs.add_argument("--seasons", default=None)
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
    "research": cmd_research, "pa": cmd_pa, "markets": cmd_markets,
    "publish-ratings": cmd_publish_ratings, "stage-v3": cmd_stage_v3,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return _COMMANDS[args.command](args)
