"""python -m modeling v4 <command> -- one model per market.

    frames  --grain player     v3 pipeline + feature groups -> R2 frames
                               (batter_game, start, game, rog, live_total, pa_v3)
    frames  --grain micro      pitch and pa_state frames, season by season
    train   <market|group>...  the candidate ladder, walk-forward; with
                               --record writes every candidate to model_runs,
                               the chosen model's backfill and artifact to R2,
                               and with --publish the daily rollup to Supabase
    score                      keep current: score frame rows newer than each
                               market's backfill with its frozen production
                               model, append, republish the daily rollup
    status                     what the v4 index holds

Groups: player, batter, starter, game, pitch, pa, live (modeling/v4/catalog.py).
Nothing here changes what production serves; there is no promote.
"""

from __future__ import annotations

import argparse
import gc
import json
import time

import numpy as np
import pandas as pd


def _store():
    from warehouse.config import r2_config
    from warehouse.store import R2Store
    return R2Store(r2_config())


def _seasons(arg: str | None):
    if not arg:
        return None
    lo, _, hi = arg.partition("-")
    return list(range(int(lo), int(hi or lo) + 1))


def cmd_frames(args) -> int:
    from modeling.v4 import storage as S

    store = _store()
    if args.grain == "player":
        from modeling.v4 import frames as FR
        out = FR.build_player_frames(store)
        for grain, df in out.items():
            S.put_frame(store, grain, df)
        return 0
    from modeling.v4 import micro
    seasons = _seasons(args.seasons) or list(range(2015, 2027))
    micro.build_micro_frames(store, seasons,
                             grains=tuple(args.only.split(",")) if args.only
                             else ("pitch", "pa_state"))
    return 0


def cmd_train(args) -> int:
    from modeling.v4 import catalog as C
    from modeling.v4 import ladder as LD
    from modeling.v4 import record as REC
    from modeling.v4 import storage as S

    store = _store()
    summary = {}
    failed = []
    for md in C.resolve(args.markets):
        t0 = time.time()
        try:
            info = S.frame_info(store, md.grain) or {}
            have = set(info.get("columns") or [])
            cols = [c for c in LD.market_columns(md) if not have or c in have]
            frame = S.get_frame(store, md.grain, columns=cols)
            print(f"[v4] {md.name}: frame {md.grain} {frame.shape}", flush=True)
            lad, res = LD.run_market(
                md, frame, iterations=args.iterations.split(",") if args.iterations else None,
                max_train_rows=args.max_rows)
            out = REC.persist(store, lad, res, record=args.record, publish=args.publish,
                              save_artifact=not args.no_artifact)
            R = res["results"]
            summary[md.name] = {
                "chosen": res["chosen"], "gate": res["verdict"],
                "primary": {k: round(float(v.primary), 6) for k, v in R.items()},
                "test_2026": {k: (v.holdout or {}).get("primary") for k, v in R.items()},
                "backfill_rows": out["backfill_rows"], "minutes": round((time.time() - t0) / 60, 1),
                "dropped_features": lad.dead,
            }
            print(f"[v4] SUMMARY {md.name} " + json.dumps(summary[md.name], default=str),
                  flush=True)
        except Exception as exc:  # noqa: BLE001 -- one market must not sink the rest
            import traceback
            traceback.print_exc()
            failed.append(md.name)
            print(f"::error::v4 {md.name} failed: {exc}", flush=True)
        finally:
            gc.collect()
    print("[v4] ALL " + json.dumps(summary, default=str, indent=1), flush=True)
    return 1 if failed else 0


def cmd_score(args) -> int:
    """Append production predictions for frame rows newer than the backfill."""
    from modeling.v4 import catalog as C
    from modeling.v4 import ladder as LD
    from modeling.v4 import learners as L
    from modeling.v4 import record as REC
    from modeling.v4 import storage as S

    store = _store()
    idx = S.load_index(store)
    for md in C.resolve(args.markets):
        meta = idx["backfill"].get(md.name)
        model, ameta = S.get_artifact(store, md.name)
        if not meta or model is None:
            print(f"[v4] {md.name}: no backfill/artifact yet; train first", flush=True)
            continue
        through = pd.Timestamp(meta.get("through") or "1900-01-01")
        info = S.frame_info(store, md.grain) or {}
        seasons = [s for s in info.get("seasons", []) if s >= through.year]
        cols = [c for c in LD.market_columns(md) if c in set(info.get("columns") or [])]
        fr = S.get_frame(store, md.grain, seasons=seasons, columns=cols)
        if fr.empty or "game_date" not in fr:
            continue
        new = fr[pd.to_datetime(fr["game_date"]) > through]
        new = new[new[md.target].notna()]
        if new.empty:
            print(f"[v4] {md.name}: current through {through.date()}", flush=True)
            continue
        pred = model.predict(new)
        y = L.y_of(new, md)
        out = new[[k for k in md.keys if k in new] + ["season", "game_date", "day"]].copy()
        out["y"] = y
        out["pred"] = REC._headline(md, np.asarray(pred)).astype(np.float32)
        out["loss"] = REC.row_loss(md.kind, np.asarray(pred), y).astype(np.float32)
        out["source"] = "production"
        out["iteration"] = ameta.get("iteration")
        out["run_id"] = meta["run_id"]
        out["version"] = meta["version"]
        S.put_backfill(store, md.name, out, {**meta, "through": str(out["game_date"].max())},
                        append=True)
        daily = REC.daily_rollup(md, out)
        n = REC.publish_daily(daily) if args.publish else 0
        print(f"[v4] {md.name}: scored {len(out):,} new rows through "
              f"{out['game_date'].max()}, {n} daily rows published", flush=True)
    return 0


def cmd_status(args) -> int:
    from modeling.v4 import storage as S
    idx = S.load_index(_store())
    print(json.dumps(idx, indent=1, default=str))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m modeling v4")
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("frames")
    f.add_argument("--grain", choices=("player", "micro"), default="player")
    f.add_argument("--seasons", help="micro only, e.g. 2015-2026")
    f.add_argument("--only", help="micro only: pitch,pa_state")
    t = sub.add_parser("train")
    t.add_argument("markets", nargs="+")
    t.add_argument("--record", action="store_true")
    t.add_argument("--publish", action="store_true")
    t.add_argument("--iterations", help="comma list, default the whole ladder")
    t.add_argument("--max-rows", type=int, default=None)
    t.add_argument("--no-artifact", action="store_true")
    s = sub.add_parser("score")
    s.add_argument("markets", nargs="*", default=["player", "live", "pitch", "pa"])
    s.add_argument("--publish", action="store_true")
    sub.add_parser("status")
    return p


_COMMANDS = {"frames": cmd_frames, "train": cmd_train, "score": cmd_score,
             "status": cmd_status}


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    return _COMMANDS[args.cmd](args)
