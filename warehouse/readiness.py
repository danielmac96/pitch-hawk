"""Is the warehouse complete enough to train on? One table, per season.

`status` answers "did last night run"; this answers "can a model trust 2019".
It reports, per dataset and season, what the manifest claims (days, rows,
verified days) and, for `pitches`, what the files actually hold: the share of
rows with a value in the columns models depend on, and whether `outs` stays in
range.

Cheap by construction. Column fill and the `outs` range come from Parquet
FOOTERS (`parquet_metadata`), not from scanning rows, so a full-history report
is ~2,000 small range reads rather than a 700 MB scan. A column that a file
predates is absent from its footer and counts as unfilled, which is exactly
the case this exists to find: the pitch-physics columns were added in 2026-09
and only re-ingested days carry them.

Read-only.
"""

from __future__ import annotations

from collections import defaultdict

from warehouse import duck, manifest
from warehouse.config import DERIVED_DATASETS, POSTSEASON_DATASETS, object_key
from warehouse.store import ObjectStore

# One representative column per group a model reads. If release_pos_x is
# filled the other release / accel / pfx columns are too -- they are written
# from the same pitchData block.
PITCH_COLUMNS = ("start_speed", "spin_rate", "release_pos_x", "pfx_x",
                 "launch_speed")
MANIFEST_DATASETS = (("pitches", "at_bats", "games") + DERIVED_DATASETS
                     + POSTSEASON_DATASETS)

# A season passes when every pitch-day is verified, the physics columns are
# present on essentially every tracked pitch, and no pitch has outs > 2.
# start_speed is the yardstick for "tracked": a pitch with no velocity was not
# tracked at all, so physics fill is judged relative to it.
MIN_PHYSICS_VS_SPEED = 0.98


def manifest_rows(m: dict) -> list[dict]:
    """Per dataset and season: days, rows, bytes per row, verified days."""
    out = []
    for ds in MANIFEST_DATASETS:
        agg: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
        for day in manifest.days(m, ds):
            e = manifest.entry(m, ds, day) or {}
            a = agg[day[:4]]
            a[0] += 1
            a[1] += e.get("rows") or 0
            a[2] += e.get("bytes") or 0
            a[3] += bool(e.get("verified_at"))
        for season in sorted(agg):
            d, r, b, v = agg[season]
            out.append({"dataset": ds, "season": int(season), "days": d,
                        "rows": r, "bytes_per_row": round(b / max(r, 1), 1),
                        "verified_days": v})
    return out


def pitch_fill(store: ObjectStore, m: dict, season: int, con=None) -> dict:
    """Share of the season's pitch rows with a value in each PITCH_COLUMNS
    entry, and the largest `outs` any file reports -- from footers only."""
    con = con or duck.connect(store)
    days = [d for d in manifest.days(m, "pitches") if d[:4] == str(season)]
    if not days:
        return {}
    total = sum((manifest.entry(m, "pitches", d) or {}).get("rows") or 0
                for d in days)
    files = ", ".join("'" + store.uri(object_key("pitches", d)) + "'"
                      for d in days)
    cols = ", ".join(f"'{c}'" for c in PITCH_COLUMNS + ("outs",))
    rows = con.execute(f"""
        select path_in_schema,
               sum(num_values) - sum(coalesce(stats_null_count, 0)) as filled,
               max(case when path_in_schema = 'outs'
                        then try_cast(stats_max_value as integer) end) as max_v
        from parquet_metadata([{files}])
        where path_in_schema in ({cols})
        group by 1""").fetchall()
    got = {name: (filled, max_v) for name, filled, max_v in rows}
    out = {"season": season, "rows": total,
           "max_outs": (got.get("outs") or (None, None))[1]}
    for c in PITCH_COLUMNS:
        out[c] = round(float((got.get(c) or (0, None))[0] or 0)
                       / max(total, 1), 4)
    return out


def judge(man: list[dict], fill: list[dict]) -> list[dict]:
    """One verdict per season, with the reasons it is not ready."""
    pitches = {r["season"]: r for r in man if r["dataset"] == "pitches"}
    box = {r["season"]: r for r in man if r["dataset"] == "player_box"}
    out = []
    for f in fill:
        s, why = f["season"], []
        p = pitches.get(s, {})
        if p.get("verified_days", 0) < p.get("days", 0):
            why.append(f"{p.get('days', 0) - p.get('verified_days', 0)} "
                       f"pitch-days unverified")
        if f["release_pos_x"] < MIN_PHYSICS_VS_SPEED * f["start_speed"]:
            why.append("pitch physics not filled")
        if f["max_outs"] is not None and f["max_outs"] > 2:
            why.append("outs out of range")
        if box.get(s, {}).get("days", 0) < p.get("days", 0):
            why.append("player_box days missing")
        out.append({"season": s, "ready": not why, "why": "; ".join(why)})
    return out


def build(store: ObjectStore, seasons=None, m: dict | None = None) -> dict:
    m = manifest.load(store) if m is None else m
    man = manifest_rows(m)
    have = sorted({r["season"] for r in man if r["dataset"] == "pitches"})
    want = [s for s in have if not seasons or s in set(seasons)]
    con = duck.connect(store)
    fill = [pitch_fill(store, m, s, con) for s in want]
    return {"manifest": man, "pitch_fill": fill, "verdict": judge(man, fill)}


def to_markdown(rep: dict) -> str:
    """The report as Markdown tables -- pasted into docs/models/LAB.md by
    `python -m modeling report`, and printed by `python -m warehouse readiness`."""
    verdict = {v["season"]: v for v in rep["verdict"]}
    pitches = {r["season"]: r for r in rep["manifest"]
               if r["dataset"] == "pitches"}
    lines = ["| season | pitch-days | verified | pitches | "
             + " | ".join(PITCH_COLUMNS) + " | max outs | ready |",
             "|---|---|---|---|" + "---|" * len(PITCH_COLUMNS) + "---|---|"]
    for f in rep["pitch_fill"]:
        s, p, v = f["season"], pitches.get(f["season"], {}), verdict[f["season"]]
        lines.append(
            f"| {s} | {p.get('days', 0)} | {p.get('verified_days', 0)} | "
            f"{f['rows']:,} | "
            + " | ".join(f"{f[c]:.1%}" for c in PITCH_COLUMNS)
            + f" | {f['max_outs']} | "
            + ("yes" if v["ready"] else f"no: {v['why']}") + " |")

    other = [r for r in rep["manifest"] if r["dataset"] != "pitches"]
    by_ds: dict[str, list[dict]] = defaultdict(list)
    for r in other:
        by_ds[r["dataset"]].append(r)
    lines += ["", "| dataset | seasons | days | rows | verified days |",
              "|---|---|---|---|---|"]
    for ds, rs in by_ds.items():
        lines.append(
            f"| `{ds}` | {min(r['season'] for r in rs)}-"
            f"{max(r['season'] for r in rs)} | {sum(r['days'] for r in rs):,} | "
            f"{sum(r['rows'] for r in rs):,} | "
            f"{sum(r['verified_days'] for r in rs):,} |")
    return "\n".join(lines)
