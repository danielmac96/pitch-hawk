"""What is served, what was validated, and whether a run may be promoted.

One set of pure functions behind three readers, so they cannot disagree:

  * the dashboard's Models page (dashboard/utils/models.py re-exports these),
  * `python -m modeling report`, which rewrites the generated blocks of
    docs/models/LAB.md,
  * `python -m modeling stage-v3`, which refuses a run that fails `verdict`.

Nothing here touches Streamlit, and only `main` touches Supabase or R2.

Two pipelines write `model_runs`, and their rows are shaped differently:

  v2 cell models   folds = [{test_season, metrics: {...}}], status "promoted"
                   when activated, version set.
  markets_v3       folds = [{season, logloss, ...}] (flat), status always
                   "completed"; a run reaches production only through
                   `stage-v3` + `activate`.

So "the latest run for this market" and "what production serves" are separate
questions, and every reader has to answer both.
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

V3_PIPELINE = "markets_v3"
LAB_DOC = Path(__file__).resolve().parents[1] / "docs" / "models" / "LAB.md"

# The active row exists but game-predict does not read it: model.ts has no
# params.type == "log5" branch. Stops being true once a moneyline_v3 row is
# active together with the v3 bundle.
INERT_TYPES = {"log5"}

# (model metric, baseline metrics, baseline label), first match wins. All are
# lower-is-better. A market with several baselines must beat the best of them.
# Starter props are judged on MAE of the expected count: their P(over) is
# priced at the model's own median, so its log loss sits at ln 2 whatever the
# skill.
_SCORE_KEYS: tuple[tuple[str, tuple[str, ...], str], ...] = (
    ("mae_expected", ("mae_train_mean",), "pitcher's training-season mean"),
    ("logloss", ("slot_baseline_logloss",), "lineup-slot rate"),
    ("logloss", ("production_log5_logloss", "home_rate_baseline_logloss"),
     "home rate / production log5"),
    ("logloss", ("league_over85_logloss",), "league-mean NB"),
    ("logloss", ("league_only",), "league rates"),
    ("logloss", (), ""),
    ("rmse", (), ""),
    ("brier", (), ""),
)

# Promotion rule (docs/models/LAB.md, "Protocol"). Calibration is mean
# predicted over observed; the band is wider for a rare event because the
# ratio rests on far fewer positives, so a matching band would reject good
# models on sampling noise.
CAL_BAND = 0.10
CAL_BAND_RARE = 0.15
RARE_BASE_RATE = 0.15
CHAMPION_TOLERANCE = 0.02
_RARE_CLASS_KEYS = ("hr_calibration", "bb_calibration")


def pipeline_of(config) -> str:  # noqa: ANN001
    return (config or {}).get("pipeline") or "v2"


def proposal_of(config) -> str:  # noqa: ANN001
    return (config or {}).get("proposal") or ""


def _pick(metrics: dict) -> tuple[str, tuple[str, ...], str] | None:
    for key, bases, label in _SCORE_KEYS:
        if key in metrics and (not bases or any(b in metrics for b in bases)):
            return key, bases, label
    return None


def _baseline(metrics: dict, bases: tuple[str, ...]) -> float | None:
    vals = [metrics[b] for b in bases if metrics.get(b) is not None]
    return min(vals) if vals else None


def _shipped(oos: dict, m: dict) -> tuple[float | None, float | None]:
    """(primary log loss, calibration) for the variant that actually ships.

    A v3 calibrator is dropped when it did not beat the raw probability out
    of sample (markets._keep_cal), but a run records the calibrated numbers
    under the plain keys either way. Judging a market on a layer it does not
    ship would flatter it: batter_hr reads 0.972 calibrated and 0.957 as
    served.
    """
    raw = oos.get("uncalibrated_logloss")
    dropped = raw is not None and oos.get("logloss", raw) >= raw
    if dropped and "uncalibrated_logloss" in m:
        return (m["uncalibrated_logloss"],
                m.get("uncalibrated_calibration", m.get("calibration")))
    return m.get("logloss"), m.get("calibration", m.get("calibration_ratio"))


def _score(oos: dict, m: dict, key: str) -> float | None:
    return _shipped(oos, m)[0] if key == "logloss" else m.get(key)


# ── production ──────────────────────────────────────────────────────────────

def live_stamps(*sources: list[dict]) -> dict[str, str]:
    """Latest `model_version` per market across the tables scoring writes to.

    Each source must already be ordered newest-first. `predictions` covers the
    per-pitch markets only; player props stamp `player_game_projections` and
    the pregame game markets stamp `game_predictions`, so reading one table
    reports every other market as drifted.
    """
    out: dict[str, str] = {}
    for rows in sources:
        for r in rows or []:
            if r.get("model_version"):
                out.setdefault(r["market"], r["model_version"])
    return out


def production(params: pd.DataFrame, stamps: dict[str, str]) -> pd.DataFrame:
    """Active registry rows against what live scoring actually stamped."""
    if params.empty:
        return params
    active = params[params["is_active"]].copy()
    active["live_stamp"] = active["market"].map(stamps)

    def state(r) -> str:  # noqa: ANN001
        if r.get("type") in INERT_TYPES:
            return "🚫 not read"
        if pd.isna(r["live_stamp"]):
            return "— no live rows"
        return "✅ match" if r["live_stamp"] == r["version"] else "⚠️ drift"

    active["state"] = active.apply(state, axis=1)
    return active.sort_values("market").reset_index(drop=True)


def unstaged_v3(runs: pd.DataFrame, params: pd.DataFrame) -> list[str]:
    """Markets with a recorded v3 run and no `v3_*` row in the registry."""
    if runs.empty:
        return []
    v3 = runs[runs["config"].apply(pipeline_of) == V3_PIPELINE]
    staged = (set() if params.empty else
              set(params[params["version"].astype(str).str.startswith("v3_")]
                  ["market"]))
    return sorted(set(v3["market"]) - staged)


# ── runs ────────────────────────────────────────────────────────────────────

def scorecard(runs: pd.DataFrame, params: pd.DataFrame, *,
              by_proposal: bool = False) -> pd.DataFrame:
    """One row per (market, pipeline): the latest run, model against baseline.

    `validation` is the walk-forward aggregate, `test` the frozen 2026
    holdout. `served` says whether that pipeline is what production runs
    for the market today -- a validated v3 run that was never staged reads
    "no". With `by_proposal`, the latest run of every proposal is kept, so
    challengers sit beside the champion.
    """
    if runs.empty:
        return pd.DataFrame()
    df = runs.copy()
    df["pipeline"] = df["config"].apply(pipeline_of)
    df["proposal"] = df["config"].apply(proposal_of)
    keys = ["market", "pipeline"] + (["proposal"] if by_proposal else [])
    df = df.sort_values("created_at", ascending=False).drop_duplicates(keys)
    active = ({} if params.empty else
              params[params["is_active"]].set_index("market")["version"].to_dict())
    rows = []
    for r in df.to_dict("records"):
        oos, hold = r.get("oos_metrics") or {}, r.get("holdout_metrics") or {}
        pick = _pick(oos)
        if pick is None:  # workload / team_runs: components, no market metric
            continue
        key, bases, label = pick
        v = str(active.get(r["market"], ""))
        served = v.startswith("v3_") if r["pipeline"] == V3_PIPELINE else (
            bool(r.get("version")) and v == r.get("version"))
        test, test_base = _score(oos, hold, key), _baseline(hold, bases)
        rows.append({
            "market": r["market"], "pipeline": r["pipeline"],
            "proposal": r["proposal"], "run": str(r["created_at"])[:10],
            "metric": key,
            "validation": _score(oos, oos, key),
            "val_baseline": _baseline(oos, bases),
            "test_2026": test, "test_baseline": test_base,
            "test_calibration": _shipped(oos, hold)[1],
            # Whole-distribution score for count markets: every ladder line.
            "test_rps": hold.get("rps"),
            "test_rps_baseline": hold.get("rps_baseline"),
            "baseline": label,
            "beats_baseline": (None if test is None or test_base is None
                               else bool(test < test_base)),
            "promotable": ("" if r["pipeline"] != V3_PIPELINE
                           else "yes" if verdict(oos, hold)["ok"] else "no"),
            "served": "yes" if served else "no",
        })
    if not by_proposal:
        for row in rows:
            del row["proposal"]
    return (pd.DataFrame(rows).sort_values(keys).reset_index(drop=True))


def fold_frame(folds) -> pd.DataFrame:  # noqa: ANN001
    """Per-season primary metric from either pipeline's fold shape."""
    rows = []
    for f in folds or []:
        m = f.get("metrics") or f
        pick = _pick(m)
        if pick is None:
            continue
        key, bases, _ = pick
        rows.append({"season": f.get("test_season", f.get("season")),
                     "metric": key, "model": m[key],
                     "baseline": _baseline(m, bases)})
    return pd.DataFrame(rows)


def verdict(oos: dict, holdout: dict | None, *,
            champion_oos: dict | None = None) -> dict:
    """Apply the promotion rule to one run. Returns {ok, reasons, notes}.

    A run with no market metric (workload, team_runs: components scored only
    through the markets built on them) passes with a note; there is nothing
    to judge it on in isolation.
    """
    oos, hold = oos or {}, holdout or {}
    reasons: list[str] = []
    notes: list[str] = []
    pick = _pick(oos)
    if pick is None:
        return {"ok": True, "reasons": [], "notes": ["component; no market metric"]}
    key, bases, label = pick

    val, val_base = _score(oos, oos, key), _baseline(oos, bases)
    if not bases:
        notes.append("no baseline recorded")
    elif val_base is not None and not val < val_base:
        reasons.append(f"validation {key} {val:.4f} does not beat "
                       f"{label} {val_base:.4f}")

    if not hold:
        reasons.append("no 2026 test recorded")
    else:
        test, test_base = _score(oos, hold, key), _baseline(hold, bases)
        if bases and test_base is None:
            notes.append("test baseline not recorded")
        elif test is not None and test_base is not None and not test < test_base:
            reasons.append(f"test {key} {test:.4f} does not beat "
                           f"{label} {test_base:.4f}")

        cals = {k: v for k, v in hold.items()
                if k.endswith("_calibration") and not k.startswith("uncal")}
        if not cals:
            c = _shipped(oos, hold)[1]
            cals = {} if c is None else {"calibration": c}
        rare = (hold.get("base_rate") is not None
                and min(hold["base_rate"], 1 - hold["base_rate"]) < RARE_BASE_RATE)
        for name, c in cals.items():
            band = (CAL_BAND_RARE if rare or name in _RARE_CLASS_KEYS
                    else CAL_BAND)
            if abs(c - 1.0) > band:
                reasons.append(f"test {name} {c:.3f} outside 1 ± {band:.2f}")

    if champion_oos:
        champ = _score(champion_oos, champion_oos, key)
        if champ and val is not None and val > champ * (1 + CHAMPION_TOLERANCE):
            reasons.append(f"validation {key} {val:.4f} is more than "
                           f"{CHAMPION_TOLERANCE:.0%} worse than the champion's "
                           f"{champ:.4f}")
    return {"ok": not reasons, "reasons": reasons, "notes": notes}


# ── live ────────────────────────────────────────────────────────────────────

def live_calibration(rows: list[dict]) -> pd.DataFrame:
    """Graded projections: mean predicted probability over observed rate.

    1.0 is calibrated; 1.2 means the model says 20% more often than it
    happens. This is the number offline validation cannot give -- it is
    measured on what production actually served.
    """
    df = pd.DataFrame(rows or [])
    if df.empty:
        return df
    df = df[df["result"].isin(["hit", "miss"])].copy()
    if df.empty:
        return df
    df["p"] = df["probability"].astype(float)
    df["y"] = (df["result"] == "hit").astype(float)
    out = (df.groupby(["market", "model_version"])
             .agg(n=("y", "size"), mean_predicted=("p", "mean"),
                  observed=("y", "mean")).reset_index())
    out["ratio"] = out["mean_predicted"] / out["observed"].where(out["observed"] > 0)
    return out.round(4)


def live_game_record(rows: list[dict]) -> pd.DataFrame:
    """Pregame game markets: share of graded picks that won, by version."""
    df = pd.DataFrame(rows or [])
    if df.empty:
        return df
    df = df[df["result"].isin(["win", "loss"])].copy()
    if df.empty:
        return df
    df["won"] = (df["result"] == "win").astype(float)
    df["confidence"] = df["confidence"].astype(float)
    return (df.groupby(["market", "model_version"])
              .agg(n=("won", "size"), mean_confidence=("confidence", "mean"),
                   won=("won", "mean")).reset_index().round(4))


# ── docs/models/LAB.md ──────────────────────────────────────────────────────

def _fmt(v) -> str:  # noqa: ANN001
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:.4f}"
    return str(v)


def md_table(df: pd.DataFrame, columns: list[str] | None = None) -> str:
    if df is None or df.empty:
        return "_none_"
    cols = columns or list(df.columns)
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in df[cols].to_dict("records"):
        lines.append("| " + " | ".join(_fmt(r[c]) for c in cols) + " |")
    return "\n".join(lines)


def replace_block(text: str, name: str, body: str) -> str:
    """Swap the text between `<!-- lab:begin NAME -->` and its end marker.

    Raises when the markers are missing rather than appending: a generated
    table landing somewhere unexpected in a hand-edited file is worse than a
    command that stops.
    """
    pat = re.compile(rf"(<!-- lab:begin {re.escape(name)} -->\n).*?"
                     rf"(<!-- lab:end {re.escape(name)} -->)", re.S)
    if not pat.search(text):
        raise ValueError(f"LAB.md has no '{name}' block markers")
    return pat.sub(lambda m: m.group(1) + body.rstrip() + "\n" + m.group(2),
                   text)


def render_leaderboard(params: pd.DataFrame, runs: pd.DataFrame,
                       stamps: dict[str, str], graded: list[dict],
                       games: list[dict], today: str) -> str:
    prod = production(params, stamps)
    unregistered = sorted(set(stamps) - set(prod["market"])) if not prod.empty \
        else sorted(stamps)
    parts = [f"_Generated {today} by `python -m modeling report`. "
             f"Do not edit by hand._", "", "**Serving**", "",
             md_table(prod, ["market", "version", "live_stamp", "state"])]
    if unregistered:
        parts += ["", "Scored with no registry row: " + ", ".join(
            f"`{m}` → `{stamps[m]}`" for m in unregistered) + "."]
    pending = unstaged_v3(runs, params)
    if pending:
        parts += ["", "Validated v3 runs not staged: " + ", ".join(
            f"`{m}`" for m in pending) + "."]
    parts += ["", "**Runs** — latest per market, pipeline and proposal; "
              "lower is better", "",
              md_table(scorecard(runs, params, by_proposal=True),
                       ["market", "pipeline", "proposal", "run", "metric",
                        "validation", "val_baseline", "test_2026",
                        "test_baseline", "test_calibration", "test_rps",
                        "test_rps_baseline", "promotable", "served"]),
              "", "**Live** — graded player projections "
              "(ratio = predicted ÷ observed)", "",
              md_table(live_calibration(graded)),
              "", "**Live** — pregame game markets", "",
              md_table(live_game_record(games))]
    return "\n".join(parts)


def fetch_all(build, *, page: int = 1000, cap: int = 50_000) -> list[dict]:
    """Every row of a PostgREST query. `build()` returns a fresh query.

    Supabase caps a response at 1,000 rows whatever `.limit()` asks for, so a
    single request silently returns the newest thousand: the first leaderboard
    generated here reported 198 graded batter_hit rows when there were 395.
    """
    out: list[dict] = []
    while len(out) < cap:
        rows = build().range(len(out), len(out) + page - 1).execute().data or []
        out += rows
        if len(rows) < page:
            break
    return out


def main(args) -> int:  # noqa: ANN001
    """Rewrite LAB.md's generated blocks from model_runs and the live tables."""
    from datetime import date

    from warehouse.config import supabase_client

    db = supabase_client()
    params = pd.DataFrame(db.table("model_params").select(
        "market, version, is_active, activated_at, type:params->>type")
        .order("market").execute().data or [])
    runs = pd.DataFrame(db.table("model_runs").select(
        "market, created_at, status, version, config, oos_metrics, "
        "holdout_metrics").order("created_at", desc=True).limit(500)
        .execute().data or [])
    pitch = (db.table("predictions").select("market, model_version")
             .order("created_at", desc=True).limit(500).execute().data or [])
    props = (db.table("player_game_projections").select("market, model_version")
             .order("scored_at", desc=True).limit(1000).execute().data or [])
    graded = fetch_all(lambda: db.table("player_game_projections")
                       .select("market, model_version, probability, result")
                       .in_("result", ["hit", "miss"])
                       .order("game_pk").order("player_id").order("market"))
    games = fetch_all(lambda: db.table("game_predictions")
                      .select("market, model_version, confidence, result")
                      .eq("phase", "pregame")
                      .in_("market", ["game_moneyline", "game_total"])
                      .order("scored_at", desc=True).order("game_pk")
                      .order("market"))

    today = date.today().isoformat()
    board = render_leaderboard(params, runs, live_stamps(pitch, props, games),
                               graded, games, today)
    if args.print:
        print(board)
        return 0

    text = LAB_DOC.read_text(encoding="utf-8")
    text = replace_block(text, "leaderboard", board)
    if args.readiness:
        from modeling.cli import _store
        from warehouse import readiness

        rep = readiness.build(_store())
        ready = sum(v["ready"] for v in rep["verdict"])
        text = replace_block(text, "readiness", (
            f"_Generated {today} by `python -m modeling report --readiness`. "
            f"{ready} of {len(rep['verdict'])} seasons ready._\n\n"
            + readiness.to_markdown(rep)))
    LAB_DOC.write_text(text, encoding="utf-8", newline="\n")
    print(f"[modeling] wrote {LAB_DOC.relative_to(LAB_DOC.parents[2])}")
    return 0
