"""Phase 2 backfill — populate rolling stats, matchups, and player_info.

Idempotent and re-runnable. Skip flags let you run subsets.

Usage:
    python scripts/backfill_phase2.py
    python scripts/backfill_phase2.py --skip-rolling
    python scripts/backfill_phase2.py --skip-matchups --skip-players
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.db.client import get_client  # noqa: E402
from backend.ingestion.player_info import ensure_players  # noqa: E402

_MATCHUP_BATCH = 500
_AT_BATS_PAGE = 10000


def _table_count(table: str) -> int | None:
    try:
        return get_client().table(table).select("*", count="exact", head=True).execute().count
    except Exception as exc:
        print(f"  [warn] failed to count {table}: {exc}")
        return None


# --- Step 1: rolling stats ----------------------------------------------------

def refresh_rolling_stats() -> None:
    client = get_client()
    print("[rolling] before:",
          "pitchers=", _table_count("pitcher_rolling_stats"),
          "batters=",  _table_count("batter_rolling_stats"))
    try:
        n1 = client.rpc("refresh_pitcher_rolling_stats", {}).execute().data
        print(f"[rolling] refresh_pitcher_rolling_stats -> {n1}")
    except Exception as exc:
        print(f"[rolling] refresh_pitcher_rolling_stats failed: {exc}")
    try:
        n2 = client.rpc("refresh_batter_rolling_stats", {}).execute().data
        print(f"[rolling] refresh_batter_rolling_stats -> {n2}")
    except Exception as exc:
        print(f"[rolling] refresh_batter_rolling_stats failed: {exc}")
    print("[rolling] after:",
          "pitchers=", _table_count("pitcher_rolling_stats"),
          "batters=",  _table_count("batter_rolling_stats"))


# --- Step 2: matchup_history from at_bats ------------------------------------

def populate_matchup_history() -> None:
    client = get_client()
    print("[matchups] paging through at_bats...")
    pairs: dict[tuple[int, int], dict] = {}
    offset = 0
    total = 0
    while True:
        rows = (
            client.table("at_bats")
            .select("pitcher_id,batter_id,result")
            .order("id")
            .range(offset, offset + _AT_BATS_PAGE - 1)
            .execute().data
            or []
        )
        if not rows:
            break
        for r in rows:
            pid = r.get("pitcher_id")
            bid = r.get("batter_id")
            if pid is None or bid is None:
                continue
            key = (int(pid), int(bid))
            agg = pairs.setdefault(key, {"pa": 0, "h": 0, "so": 0, "bb": 0})
            agg["pa"] += 1
            res = r.get("result")
            if res == "strikeout":
                agg["so"] += 1
            elif res == "walk":
                agg["bb"] += 1
            elif res == "hit":
                agg["h"] += 1
        total += len(rows)
        print(f"[matchups] paged {total} at-bats, distinct pairs={len(pairs)}")
        if len(rows) < _AT_BATS_PAGE:
            break
        offset += _AT_BATS_PAGE

    if not pairs:
        print("[matchups] no pairs found.")
        return

    rows_to_upsert = [
        {
            "pitcher_id": p, "batter_id": b,
            "pa_count": v["pa"], "h_count": v["h"],
            "so_count": v["so"], "bb_count": v["bb"],
        }
        for (p, b), v in pairs.items()
    ]
    print(f"[matchups] upserting {len(rows_to_upsert)} rows in batches of {_MATCHUP_BATCH}...")
    for i in range(0, len(rows_to_upsert), _MATCHUP_BATCH):
        batch = rows_to_upsert[i:i + _MATCHUP_BATCH]
        try:
            client.table("matchup_history").upsert(
                batch, on_conflict="pitcher_id,batter_id",
            ).execute()
        except Exception as exc:
            print(f"[matchups] batch {i} failed: {exc}")
    print("[matchups] after:", _table_count("matchup_history"))


# --- Step 3: player_info -----------------------------------------------------

def _distinct_ids() -> tuple[list[int], list[int]]:
    client = get_client()
    pitchers: set[int] = set()
    batters: set[int] = set()
    # Page through pitches to collect distinct ids (the supabase-py select
    # API doesn't expose `distinct`, so we accumulate client-side).
    offset = 0
    while True:
        rows = (
            client.table("pitches")
            .select("pitcher_id,batter_id")
            .order("id")
            .range(offset, offset + _AT_BATS_PAGE - 1)
            .execute().data
            or []
        )
        if not rows:
            break
        for r in rows:
            if r.get("pitcher_id") is not None:
                pitchers.add(int(r["pitcher_id"]))
            if r.get("batter_id") is not None:
                batters.add(int(r["batter_id"]))
        if len(rows) < _AT_BATS_PAGE:
            break
        offset += _AT_BATS_PAGE
    return sorted(pitchers), sorted(batters)


def _existing_player_ids() -> set[int]:
    client = get_client()
    out: set[int] = set()
    offset = 0
    while True:
        rows = (
            client.table("player_info")
            .select("player_id")
            .order("player_id")
            .range(offset, offset + _AT_BATS_PAGE - 1)
            .execute().data
            or []
        )
        if not rows:
            break
        for r in rows:
            pid = r.get("player_id")
            if pid is not None:
                out.add(int(pid))
        if len(rows) < _AT_BATS_PAGE:
            break
        offset += _AT_BATS_PAGE
    return out


def populate_player_info() -> None:
    print("[players] enumerating distinct ids in pitches...")
    pitchers, batters = _distinct_ids()
    existing = _existing_player_ids()
    missing_p = [p for p in pitchers if p not in existing]
    missing_b = [b for b in batters  if b not in existing]
    print(f"[players] need pitchers={len(missing_p)} batters={len(missing_b)}; "
          f"already in player_info={len(existing)}")
    if not missing_p and not missing_b:
        return
    asyncio.run(ensure_players(missing_p, missing_b))
    print("[players] after:", _table_count("player_info"))


# --- main --------------------------------------------------------------------

def main(argv: list[str]) -> int:
    skip_rolling = "--skip-rolling" in argv
    skip_matchups = "--skip-matchups" in argv
    skip_players = "--skip-players" in argv

    print("=== Phase 2 backfill ===")
    if not skip_rolling:
        refresh_rolling_stats()
    if not skip_matchups:
        populate_matchup_history()
    if not skip_players:
        populate_player_info()

    print("=== summary ===")
    for t in (
        "pitcher_rolling_stats", "batter_rolling_stats",
        "matchup_history", "player_info",
        "game_context", "pitcher_game_log",
    ):
        print(f"  {t:24s} = {_table_count(t)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
