"""Put v4 on the site: score today's slate and write what the board reads.

    python -m modeling v4 publish [--date YYYY-MM-DD]

For every pregame market whose ACTIVE model_params row is a v4 row
(params.type = "v4"), the pending rows of today's games -- regular season or
postseason -- are scored with that market's frozen production fit (R2
artifact) and written to the tables production already serves from:

    batter_* / pitcher_*      player_game_projections  (upsert; re-scored each run,
                                                         as lineups post)
    game_moneyline/game_total game_predictions phase='pregame' (frozen once a v4
                                                         row exists, like every
                                                         pregame call)

Same keys and column shapes as the v3 writer in game-predict, so the board,
the API and settle need no change; model_version says which model made a
row. game-predict skips a v4 market for any (game, player) this publisher
covered and keeps its previous writer for the rest, so a failed publish
degrades to the incumbent rather than to nothing.

Also written: v4_serve_features, the pregame half of every in-game v4
market's inputs (pitcher, batter, umpire snapshots, per batter-game and per
game values), which the TypeScript tree scorer joins with the live state.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from modeling import derive as D
from modeling.v4 import catalog as C
from modeling.v4 import record as REC
from modeling.v4 import storage as S

PREGAME_GRAINS = {"batter_game", "start", "game"}
SERVE_TABLE = "v4_serve_features"


def _r4(x) -> float | None:  # noqa: ANN001
    return None if x is None or not np.isfinite(x) else round(float(x), 4)


def active_v4(db) -> dict[str, dict]:  # noqa: ANN001
    rows = (db.table("model_params").select("market,version,params")
            .eq("is_active", True).execute().data or [])
    return {r["market"]: r for r in rows if (r.get("params") or {}).get("type") == "v4"}


def american(p: float) -> int | None:
    if not 0 < p < 1:
        return None
    return -round(p / (1 - p) * 100) if p >= 0.5 else round((1 - p) / p * 100)


def count_ladder(pmf: np.ndarray, lo: float = 0.02, hi: float = 0.98) -> list[dict]:
    out = []
    for k in range(len(pmf) - 1):
        p = D.over_prob(pmf, k + 0.5)
        if lo <= p <= hi:
            out.append({"line": k + 0.5, "p_over": round(float(p), 4)})
    return out


def _per_pa(p: float, e_pa: float) -> float | None:
    if not (0 < p < 1) or not e_pa or e_pa <= 0:
        return None
    return 1 - (1 - p) ** (1 / e_pa)


# ── rows ────────────────────────────────────────────────────────────────────

BATTER_LINE = {"batter_hit": None, "batter_hr": None, "batter_tb15": 1.5, "batter_hrr": 0.5}


def batter_rows(md, fr: pd.DataFrame, pred: np.ndarray, version: str, date: str) -> list[dict]:  # noqa: ANN001
    now = datetime.now(timezone.utc).isoformat()
    out = []
    for r, p in zip(fr.itertuples(index=False), pred):
        e_pa = float(getattr(r, "e_pa", np.nan))
        line = BATTER_LINE[md.name]
        ppa = _per_pa(float(p), e_pa) if md.name in ("batter_hit", "batter_hr", "batter_hrr") else None
        out.append({
            "game_pk": int(r.game_pk), "player_id": int(r.player_id), "market": md.name,
            "official_date": date, "team_id": int(r.team_id),
            "opponent_id": int(r.opp_team) if np.isfinite(r.opp_team) else None,
            "is_home": bool(r.is_home), "lineup_slot": int(r.slot),
            "opposing_pitcher_id": int(r.opp_sp) if np.isfinite(r.opp_sp) else None,
            "role": "batter", "probability": _r4(p), "line": line,
            "expected_value": None, "expected_pa": _r4(e_pa),
            "per_pa_probability": _r4(ppa) if ppa is not None else None,
            "ladder": [{"line": line if line is not None else 0.5, "p_over": _r4(p)}],
            "model_version": version, "book": "model_fair", "updated_at": now,
        })
    return out


def starter_rows(md, fr: pd.DataFrame, pmf: np.ndarray, version: str, date: str) -> list[dict]:  # noqa: ANN001
    now = datetime.now(timezone.utc).isoformat()
    out = []
    for r, pm in zip(fr.itertuples(index=False), pmf):
        line = D.median_line(pm)
        out.append({
            "game_pk": int(r.game_pk), "player_id": int(r.player_id), "market": md.name,
            "official_date": date, "team_id": int(r.team_id),
            "opponent_id": int(r.opp_team) if np.isfinite(r.opp_team) else None,
            "is_home": bool(r.is_home), "role": "pitcher", "lineup_slot": None,
            "opposing_pitcher_id": None,
            "probability": _r4(D.over_prob(pm, line)), "line": line,
            "expected_value": _r4(float(pm @ np.arange(len(pm)))),
            "expected_pa": None, "per_pa_probability": None,
            "ladder": count_ladder(pm), "model_version": version, "book": "model_fair",
            "updated_at": now,
        })
    return out


def game_rows(md, fr: pd.DataFrame, pred: np.ndarray, version: str, date: str,  # noqa: ANN001
              games: dict[int, dict]) -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    out = []
    for r, p in zip(fr.itertuples(index=False), pred):
        g = games.get(int(r.game_pk), {})
        base = {"game_pk": int(r.game_pk), "official_date": date, "phase": "pregame",
                "home_team_id": g.get("home_team_id") or int(r.home_team_id),
                "away_team_id": g.get("away_team_id") or int(r.away_team_id),
                "home_abbr": g.get("home_abbr"), "away_abbr": g.get("away_abbr"),
                "home_pitcher_id": g.get("home_pitcher_id"),
                "away_pitcher_id": g.get("away_pitcher_id"),
                "scored_at": now, "updated_at": now, "model_version": version,
                "book": "model_fair", "edge": None}
        if md.name == "game_moneyline":
            ph = float(p)
            side = "home" if ph >= 0.5 else "away"
            ps = ph if side == "home" else 1 - ph
            out.append({**base, "market": md.name, "predicted_value": _r4(ph),
                        "confidence": _r4(ps), "recommendation": side, "line": None,
                        "probs": {"home": _r4(ph), "away": _r4(1 - ph)},
                        "price": american(ps)})
        else:
            pm = np.asarray(p, float)
            line = D.median_line(pm)
            po = D.over_prob(pm, line)
            side = "over" if po >= 0.5 else "under"
            out.append({**base, "market": md.name,
                        "predicted_value": _r4(float(pm @ np.arange(len(pm)))),
                        "confidence": _r4(max(po, 1 - po)), "recommendation": side,
                        "line": line, "price": american(max(po, 1 - po)),
                        "probs": {"p_over": _r4(po), "pmf": [_r4(x) for x in pm],
                                  # The live total path (api/index.ts) reads these.
                                  "mu_home": _r4(getattr(r, "v3_mu_home", np.nan)),
                                  "mu_away": _r4(getattr(r, "v3_mu_away", np.nan)),
                                  "alpha": _r4(getattr(r, "v3_alpha", np.nan))}})
    return out


# ── serve-feature snapshot for the in-game scorers ──────────────────────────

def _clean_dict(d: dict) -> dict:
    return {k: (None if v is None or (isinstance(v, float) and not math.isfinite(v))
                else (float(v) if isinstance(v, (np.floating, float)) else
                      int(v) if isinstance(v, (np.integer,)) else v))
            for k, v in d.items()}


def serve_features(frames: dict, src: dict | None, date: str) -> list[dict]:
    """Pregame inputs of the in-game markets, keyed for the TS scorer."""
    from modeling import ratings as R
    from modeling.v4 import feats as F
    from modeling.v4 import micro

    rows = []
    day = int(R.day_index(pd.Series([pd.Timestamp(date)]))[0])
    b = frames["batter_game"]
    pend_b = b[b.get("pending", False).astype(bool)] if "pending" in b else b.iloc[0:0]
    rog_cols = [c for c in C.get("batter_hit_rog").features if c in pend_b]
    for r in pend_b.to_dict("records"):
        rows.append({"kind": "batter_game", "key": f"{int(r['game_pk'])}:{int(r['player_id'])}",
                     "as_of": date, "features": _clean_dict({c: r.get(c) for c in rog_cols})})
    g = frames["game"]
    pend_g = g[g["pending"].astype(bool)] if "pending" in g else g.iloc[0:0]
    lt_cols = [c for c in C.get("game_total_live").features if c in pend_g] + ["v3_alpha"]
    for r in pend_g.to_dict("records"):
        rows.append({"kind": "game", "key": str(int(r["game_pk"])), "as_of": date,
                     "features": _clean_dict({c: r.get(c) for c in lt_cols})})
    if src:
        pitchers = sorted(set(frames["start"].loc[frames["start"]["pending"].astype(bool),
                                                  "player_id"].astype(int)))
        batters = sorted(set(pend_b["player_id"].astype(int)))
        if pitchers:
            pf = pd.DataFrame({"pitcher_id": pitchers, "day": day,
                               "season": int(date[:4])})
            ps = F.pitcher_stuff(pf, src["pitcher_day"], "pitcher_id")
            pr = micro._pa_rates(pf, src["pitcher_pa_day"], "pitcher_id", "p_", 15) \
                if "pitcher_pa_day" in src else pd.DataFrame(index=pf.index)
            for i, pid in enumerate(pitchers):
                rows.append({"kind": "pitcher", "key": str(pid), "as_of": date,
                             "features": _clean_dict({**ps.iloc[i].to_dict(),
                                                      **pr.iloc[i].to_dict()})})
        if batters:
            bf = pd.DataFrame({"batter_id": batters, "day": day, "season": int(date[:4])})
            bd = F.batter_discipline(bf, src["batter_day"], "batter_id")
            br = micro._pa_rates(bf, src["batter_pa_day"], "batter_id", "b_", 30) \
                if "batter_pa_day" in src else pd.DataFrame(index=bf.index)
            for i, bid in enumerate(batters):
                rows.append({"kind": "batter", "key": str(bid), "as_of": date,
                             "features": _clean_dict({**bd.iloc[i].to_dict(),
                                                      **br.iloc[i].to_dict()})})
        ump = src["ump_day"]
        if len(ump):
            uids = sorted(set(ump["uid"].dropna().astype(int)))
            uf = pd.DataFrame({"hp_umpire_id": uids, "day": day, "season": int(date[:4])})
            u = F.umpire(uf, ump)
            for i, uid in enumerate(uids):
                rows.append({"kind": "umpire", "key": str(uid), "as_of": date,
                             "features": _clean_dict(u.iloc[i].to_dict())})
    return rows


# ── publish ─────────────────────────────────────────────────────────────────

def publish(store, frames: dict, src: dict | None, date: str, slate: list[dict], *,  # noqa: ANN001
            dry_run: bool = False) -> dict:
    from warehouse.config import supabase_client

    db = None if dry_run else supabase_client()
    active = {} if dry_run else active_v4(db)
    summary: dict = {"date": date, "active": sorted(active), "markets": {}}
    games_meta = {g["game_pk"]: g for g in slate}
    if db is not None and games_meta:
        meta = (db.table("games").select("game_pk,home_abbr,away_abbr")
                .in_("game_pk", list(games_meta)).execute().data or [])
        for m in meta:
            games_meta.setdefault(m["game_pk"], {}).update(m)
    proj, gp = [], []
    for md in C.MARKETS.values():
        if md.grain not in PREGAME_GRAINS:
            continue
        if not dry_run and md.name not in active:
            continue
        fr = frames[md.grain]
        fr = fr[fr["pending"].astype(bool)] if "pending" in fr else fr.iloc[0:0]
        if fr.empty:
            summary["markets"][md.name] = 0
            continue
        model, meta = S.get_artifact(store, md.name)
        if model is None:
            summary["markets"][md.name] = "no artifact"
            continue
        version = (active.get(md.name) or {}).get("version") or meta.get("version")
        pred = np.asarray(model.predict(fr))
        if md.grain == "batter_game":
            proj += batter_rows(md, fr, pred, version, date)
        elif md.grain == "start":
            proj += starter_rows(md, fr, pred, version, date)
        else:
            gp += game_rows(md, fr, pred, version, date, games_meta)
        summary["markets"][md.name] = len(fr)
    serve = serve_features(frames, src, date)
    summary.update(projection_rows=len(proj), game_rows=len(gp), serve_rows=len(serve))
    if dry_run:
        summary["sample"] = {"projection": proj[:2], "game": gp[:2], "serve": serve[:2]}
        return summary
    if proj:
        for i in range(0, len(proj), 500):
            db.table("player_game_projections").upsert(
                REC.clean(proj[i:i + 500]), on_conflict="game_pk,player_id,market").execute()
    if gp:
        # Frozen once a v4 row exists; a row from the previous writer for a
        # game not yet started is replaced (the switch to v4), never a v4 one.
        pks = sorted({r["game_pk"] for r in gp})
        have = (db.table("game_predictions").select("game_pk,market,model_version")
                .eq("phase", "pregame").in_("game_pk", pks).execute().data or [])
        frozen = {(h["game_pk"], h["market"]) for h in have
                  if str(h.get("model_version") or "").startswith("v4")}
        write = [r for r in gp if (r["game_pk"], r["market"]) not in frozen]
        if write:
            db.table("game_predictions").upsert(
                REC.clean(write), on_conflict="game_pk,market,phase").execute()
        summary["game_rows_frozen"] = len(gp) - len(write)
    if serve:
        for i in range(0, len(serve), 500):
            db.table(SERVE_TABLE).upsert(REC.clean(serve[i:i + 500]),
                                         on_conflict="kind,key,as_of").execute()
    return summary
