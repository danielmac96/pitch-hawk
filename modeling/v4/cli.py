"""python -m modeling v4 <command> -- one model per market.

    frames  --grain player     v3 pipeline + feature groups -> R2 frames
                               (batter_game, start, game, rog, live_total, pa_v3)
    frames  --grain micro      pitch and pa_state frames, season by season
    frames  --grain live_rest  add the rest-of-game target to a stored live_total
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
        cfg = S.load_index(store).get("rating_configs") if args.reuse_ratings else None
        FR.build_player_frames(store, rating_configs=cfg,
                               on_frame=lambda n, df: write_one(store, n, df))
        return 0
    if args.grain == "live_rest":
        from modeling.v4 import frames as FR
        S.put_frame(store, "live_total", FR.live_rest(S.get_frame(store, "live_total")))
        return 0
    from modeling.v4 import micro
    seasons = _seasons(args.seasons) or list(range(2015, 2027))
    micro.build_micro_frames(store, seasons,
                             grains=tuple(args.only.split(",")) if args.only
                             else ("pitch", "pa_state"))
    return 0


def write_one(store, name: str, df) -> None:  # noqa: ANN001
    from modeling.v4 import storage as S
    if name == "_rating_configs":
        idx = S.load_index(store)
        idx["rating_configs"] = df
        S.save_index(store, idx)
        return
    if name.startswith("_"):
        return
    if "pending" in df:  # today's slate is served, never stored as history
        df = df[~df["pending"].astype(bool)]
    S.put_frame(store, name, df)


def write_player_frames(store, out: dict) -> None:  # noqa: ANN001
    from modeling.v4 import storage as S
    for grain, df in out.items():
        if grain.startswith("_"):
            continue
        if "pending" in df:  # today's slate is served, never stored as history
            df = df[~df["pending"].astype(bool)]
        S.put_frame(store, grain, df)
    if out.get("_rating_configs"):
        idx = S.load_index(store)
        idx["rating_configs"] = out["_rating_configs"]
        S.save_index(store, idx)


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


def score_new(store, markets, *, publish: bool, frames: dict | None = None) -> dict:  # noqa: ANN001
    """Append production predictions for completed rows newer than each
    market's backfill: regular season and postseason, every grain. Reads the
    frames from R2 unless they are passed in memory (`v4 serve`)."""
    from modeling.v4 import catalog as C
    from modeling.v4 import ladder as LD
    from modeling.v4 import learners as L
    from modeling.v4 import record as REC
    from modeling.v4 import storage as S

    idx = S.load_index(store)
    done = {}
    for md in C.resolve(markets):
        meta = idx["backfill"].get(md.name)
        model, ameta = S.get_artifact(store, md.name)
        if not meta or model is None:
            print(f"[v4] {md.name}: no backfill/artifact yet; train first", flush=True)
            continue
        through = pd.Timestamp(meta.get("through") or "1900-01-01")
        if frames is not None and md.grain in frames:
            fr = frames[md.grain]
            fr = fr[fr["season"] >= through.year]
        else:
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
        pred = np.asarray(model.predict(new))
        y = L.y_of(new, md)
        from modeling.v4.catalog import SEGMENTS
        keep = [k for k in md.keys if k in new] + ["season", "game_date", "day"]
        keep += [k for k in SEGMENTS.get(md.grain, ()) if k in new and k not in keep]
        out = new[keep].copy()
        out["y"] = y
        out["pred"] = REC._headline(md, pred).astype(np.float32)
        out["loss"] = REC.row_loss(md.kind, pred, y).astype(np.float32)
        post = new["is_post"].fillna(0).astype(bool).to_numpy() if "is_post" in new \
            else np.zeros(len(new), bool)
        out["source"] = np.where(post, "production_postseason", "production")
        out["iteration"] = ameta.get("iteration")
        out["run_id"] = meta["run_id"]
        out["version"] = meta["version"]
        S.put_backfill(store, md.name, out, {**meta, "through": str(out["game_date"].max())},
                       append=True)
        daily = REC.daily_rollup(md, out)
        n = REC.publish_daily(daily) if publish else 0
        done[md.name] = len(out)
        print(f"[v4] {md.name}: scored {len(out):,} new rows through "
              f"{out['game_date'].max()}, {n} daily rows published", flush=True)
    return done


def cmd_score(args) -> int:
    score_new(_store(), args.markets, publish=args.publish)
    return 0


def cmd_serve(args) -> int:
    """One serve pass: frames with today's slate, backfill catch-up, publish.

    Rating configs from the last full build are reused (no tuning), which is
    what makes this cheap enough to run several times a day as lineups post.
    """
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from modeling.v4 import frames as FR
    from modeling.v4 import publish as PB
    from modeling.v4 import storage as S

    store = _store()
    date = args.date or datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    cfg = S.load_index(store).get("rating_configs")
    if cfg is None:
        print("[v4] no saved rating configs; this pass will tune (slow)", flush=True)
    out = FR.build_player_frames(store, date=date, rating_configs=cfg)
    if args.write_frames:
        write_player_frames(store, out)
    score_new(store, ["player", "live"], publish=not args.dry_run, frames=out)
    summary = PB.publish(store, out, out["_src"], date, out["_slate"], dry_run=args.dry_run)
    print("[v4] PUBLISH " + json.dumps(summary, default=str, indent=1), flush=True)
    return 0


def cmd_activate(args) -> int:
    from modeling.v4 import activate as A
    out = A.activate(_store(), args.markets, dry_run=args.dry_run)
    print("[v4] ACTIVATE " + json.dumps(out, default=str, indent=1), flush=True)
    return 0 if all(not str(v).startswith(("refused", "no ")) for v in out.values()) else 1


def cmd_status(args) -> int:
    from modeling.v4 import storage as S
    idx = S.load_index(_store())
    print(json.dumps(idx, indent=1, default=str))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m modeling v4")
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("frames")
    f.add_argument("--grain", choices=("player", "micro", "live_rest"), default="player",
                   help="live_rest: upgrade the stored live_total frame in place")
    f.add_argument("--seasons", help="micro only, e.g. 2015-2026")
    f.add_argument("--only", help="micro only: pitch,pa_state")
    f.add_argument("--reuse-ratings", action="store_true",
                   help="player only: reuse the saved rating configs (no tuning)")
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
    v = sub.add_parser("serve")
    v.add_argument("--date", help="slate date (default today, America/New_York)")
    v.add_argument("--write-frames", action="store_true")
    v.add_argument("--dry-run", action="store_true")
    a = sub.add_parser("activate")
    a.add_argument("markets", nargs="+")
    a.add_argument("--dry-run", action="store_true")
    sub.add_parser("status")
    return p


_COMMANDS = {"frames": cmd_frames, "train": cmd_train, "score": cmd_score,
             "serve": cmd_serve, "activate": cmd_activate, "status": cmd_status}


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    return _COMMANDS[args.cmd](args)
