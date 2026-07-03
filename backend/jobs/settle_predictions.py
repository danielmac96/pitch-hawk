"""Grade pending prediction rows once real outcomes are known.

A prediction row records the PA position at prediction time
(`at_bat_index`, `pitch_number` = last pitch already thrown; both may be
None right before the first pitch). Grading:

  * pitch_speed_ou / pitch_result — resolved by the NEXT pitch after that
    position (first pitch of the next AB if the AB ended).
  * ab_result / ab_pitches_ou     — resolved by the `at_bats` row for that AB.

Profit is computed off the stored American price when the row has one
(1 unit staked), else a flat ±1 unit. Rows whose outcome can never arrive
(game over, no later pitch) are voided with 0 profit.

The same rules are mirrored in the settle edge function
(supabase/functions/settle) — that's the production path; this module keeps
the local FastAPI stack self-sufficient.
"""

from __future__ import annotations

from datetime import datetime, timezone

from backend.db.client import get_client

BATCH = 200


def _win_profit(price: int | None) -> float:
    if price is None:
        return 1.0
    if price > 0:
        return round(price / 100.0, 3)
    return round(100.0 / abs(price), 3)


def _next_pitch(pitches: list[dict], abi: int | None, pn: int | None) -> dict | None:
    """First pitch strictly after (abi, pn); (None, None) -> first pitch overall."""
    key = (abi if abi is not None else -1, pn if pn is not None else -1)
    later = [
        p for p in pitches
        if (p["at_bat_index"], p["pitch_number"]) > key
        and p.get("at_bat_index") is not None and p.get("pitch_number") is not None
    ]
    if not later:
        return None
    return min(later, key=lambda p: (p["at_bat_index"], p["pitch_number"]))


def _grade_row(row: dict, pitches: list[dict], abs_by_idx: dict[int, dict],
               game_live: bool) -> tuple[str, float] | None:
    """(result, profit_units) or None if not resolvable yet."""
    market = row.get("market")
    rec = row.get("recommendation")
    if not rec:
        return ("void", 0.0)
    abi, pn = row.get("at_bat_index"), row.get("pitch_number")

    if market in ("pitch_speed_ou", "pitch_result"):
        nxt = _next_pitch(pitches, abi, pn)
        if nxt is None:
            return None if game_live else ("void", 0.0)
        if market == "pitch_speed_ou":
            speed, line = nxt.get("start_speed"), row.get("line")
            if speed is None or line is None:
                return ("void", 0.0)
            actual = "over" if float(speed) > float(line) else "under"
        else:
            actual = nxt.get("result_category")
            if actual is None:
                return ("void", 0.0)
        won = rec == actual
        return ("win", _win_profit(row.get("price"))) if won else ("loss", -1.0)

    if market in ("ab_result", "ab_pitches_ou"):
        target_abi = abi if abi is not None else 0
        ab = abs_by_idx.get(target_abi)
        if ab is None:
            return None if game_live else ("void", 0.0)
        if market == "ab_result":
            actual = ab.get("result")
            if actual is None:
                return ("void", 0.0)
            won = rec == actual
        else:
            pc, line = ab.get("pitch_count"), row.get("line")
            if pc is None or line is None:
                return ("void", 0.0)
            if float(pc) == float(line):
                return ("push", 0.0)
            actual = "over" if float(pc) > float(line) else "under"
            won = rec == actual
        return ("win", _win_profit(row.get("price"))) if won else ("loss", -1.0)

    return None  # unknown market: leave for a smarter grader


def settle_pending() -> int:
    """Grade up to BATCH pending rows. Returns number graded."""
    client = get_client()
    pending = (
        client.table("predictions")
        .select("id,game_pk,at_bat_index,pitch_number,market,recommendation,line,price")
        .is_("result", "null")
        .order("id")
        .limit(BATCH)
        .execute().data
        or []
    )
    if not pending:
        return 0

    graded = 0
    now = datetime.now(timezone.utc).isoformat()
    for game_pk in sorted({r["game_pk"] for r in pending if r.get("game_pk")}):
        rows = [r for r in pending if r.get("game_pk") == game_pk]
        pitches = (
            client.table("pitches")
            .select("at_bat_index,pitch_number,start_speed,result_category")
            .eq("game_pk", game_pk)
            .order("at_bat_index").order("pitch_number")
            .limit(5000)
            .execute().data
            or []
        )
        ab_rows = (
            client.table("at_bats")
            .select("at_bat_index,result,pitch_count")
            .eq("game_pk", game_pk)
            .limit(500)
            .execute().data
            or []
        )
        abs_by_idx = {a["at_bat_index"]: a for a in ab_rows if a.get("at_bat_index") is not None}
        ls = (
            client.table("live_state")
            .select("status,updated_at")
            .eq("game_pk", game_pk)
            .limit(1)
            .execute().data
        )
        game_live = bool(ls) and (ls[0].get("status") or "").lower() in ("live", "in progress")

        for r in rows:
            outcome = _grade_row(r, pitches, abs_by_idx, game_live)
            if outcome is None:
                continue
            result, profit = outcome
            client.table("predictions").update({
                "result": result,
                "profit_units": profit,
                "graded_at": now,
            }).eq("id", r["id"]).execute()
            graded += 1
    return graded
