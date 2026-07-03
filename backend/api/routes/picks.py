"""Public picks feed + track record.

GET /picks/today — today's published picks (rows from the `picks` table, the
                   curated/tracked pick history written by the prediction
                   pipeline). Shape mirrors frontend/picks-data.js PICKS.
GET /record      — honest aggregation of *graded* picks. Empty/zero until
                   picks have actually settled; never the sample numbers.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter

from backend.db.client import get_client

router = APIRouter(tags=["picks"])

_MARKET_LABELS = {
    "ab_result": "At-Bat Result",
    "ab_pitches_ou": "Pitches in AB",
    "pitch_speed_ou": "Next Pitch Speed",
    "pitch_result": "Next Pitch Result",
    "game_moneyline": "Moneyline",
}


def _pick_out(row: dict) -> dict:
    payload = row.get("payload") or {}
    return {
        "id": str(row.get("id")),
        "market": row.get("market"),
        "pick": row.get("label") or row.get("recommendation"),
        "line": float(row["line"]) if row.get("line") is not None else None,
        "price": row.get("price"),
        "confidence": float(row["confidence"]) if row.get("confidence") is not None else None,
        "edge": float(row["edge"]) if row.get("edge") is not None else None,
        "units": float(row.get("units") or 1),
        "book": row.get("book"),
        "status": row.get("status") or "pending",
        "game": payload.get("game") or {},
        "pitcher": payload.get("pitcher") or {},
        "batter": payload.get("batter") or {},
        "bullets": payload.get("bullets") or [],
    }


@router.get("/picks/today")
async def picks_today() -> list[dict]:
    today = date.today().isoformat()
    rows = (
        get_client().table("picks")
        .select("*")
        .eq("pick_date", today)
        .order("edge", desc=True)
        .limit(50)
        .execute().data
        or []
    )
    return [_pick_out(r) for r in rows]


def _bucket() -> dict:
    return {"wins": 0, "losses": 0, "pushes": 0, "units": 0.0, "risked": 0.0, "picks": 0}


def _tally(bucket: dict, row: dict) -> None:
    status = row.get("status")
    units = float(row.get("units") or 1)
    profit = float(row.get("profit_units") or 0)
    bucket["picks"] += 1
    bucket["risked"] += units
    bucket["units"] += profit
    if status == "win":
        bucket["wins"] += 1
    elif status == "loss":
        bucket["losses"] += 1
    elif status == "push":
        bucket["pushes"] += 1


def _finish(bucket: dict) -> dict:
    risked = bucket.pop("risked")
    bucket["units"] = round(bucket["units"], 2)
    bucket["roi"] = round(100.0 * bucket["units"] / risked, 1) if risked else 0.0
    return bucket


@router.get("/record")
async def record() -> dict:
    rows = (
        get_client().table("picks")
        .select("pick_date,market,label,recommendation,price,units,status,profit_units,payload,graded_at")
        .in_("status", ["win", "loss", "push"])
        .order("graded_at", desc=True)
        .limit(5000)
        .execute().data
        or []
    )
    overall, last30 = _bucket(), _bucket()
    by_market: dict[str, dict] = defaultdict(_bucket)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()
    for r in rows:
        _tally(overall, r)
        _tally(by_market[r.get("market") or "other"], r)
        if (r.get("pick_date") or "") >= cutoff:
            _tally(last30, r)

    recent = [{
        "date": r.get("pick_date"),
        "matchup": ((r.get("payload") or {}).get("game") or {}).get("matchup")
                   or "{away} @ {home}".format(
                       away=((r.get("payload") or {}).get("game") or {}).get("away", "?"),
                       home=((r.get("payload") or {}).get("game") or {}).get("home", "?")),
        "pick": r.get("label") or r.get("recommendation"),
        "market": r.get("market"),
        "price": r.get("price"),
        "units": float(r.get("units") or 1),
        "result": r.get("status"),
    } for r in rows[:12]]

    return {
        "updated": datetime.now(timezone.utc).date().isoformat(),
        "overall": _finish(overall),
        "last30": _finish(last30),
        "byMarket": [
            {"market": m, "label": _MARKET_LABELS.get(m, m), **_finish(b)}
            for m, b in sorted(by_market.items())
        ],
        "recent": recent,
    }
