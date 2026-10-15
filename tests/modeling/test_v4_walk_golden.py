"""tests/fixtures/v4_walk_golden.json: the per-pitch state the warehouse
flattener derives, which supabase/functions/_shared/v4live.ts::walkGame
must reproduce field for field (supabase/functions/tests/v4_walk_test.ts).

Regenerate after an intentional change to warehouse/mlb.py:

    UPDATE_GOLDEN=1 pytest tests/modeling/test_v4_walk_golden.py
"""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path

from warehouse.mlb import flatten_play_by_play

ROOT = Path(__file__).resolve().parents[1] / "fixtures"
FIELDS = ("at_bat_index", "pitch_number", "pitcher_id", "batter_id", "balls", "strikes",
          "outs", "inning", "top_inning", "on_first", "on_second", "on_third",
          "home_score", "away_score", "pitch_of_game", "times_through_order",
          "bat_side", "pitch_hand", "pitch_type", "description", "start_speed")


def _rows():
    pbp = json.loads((ROOT / "playbyplay_sample.json").read_text())
    pitches, _ = flatten_play_by_play(778001, date(2026, 7, 4), pbp)
    return [{f: p.get(f) for f in FIELDS} for p in pitches]


def test_walk_fixture_matches_flattener():
    rows = _rows()
    path = ROOT / "v4_walk_golden.json"
    if os.environ.get("UPDATE_GOLDEN"):
        path.write_text(json.dumps({"pitches": rows}, indent=1))
    assert json.loads(path.read_text())["pitches"] == rows
