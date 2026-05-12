"""Smoke-test data feeds. Run from project root: python scripts/verify_feeds.py"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ingestion.mlb_api import get_live_games, get_play_by_play  # noqa: E402

FALLBACK_GAME_PK = 745431


def _summarize(pitch: dict) -> dict:
    return {k: v for k, v in pitch.items() if k != "raw_json"}


async def main() -> int:
    print("=== verify_feeds ===")
    failures = 0

    try:
        live = await get_live_games()
        print(f"[OK] get_live_games(): {len(live)} live game(s)")
    except Exception as exc:
        print(f"[FAIL] get_live_games(): {exc}")
        live = []
        failures += 1

    if live:
        game_pk = live[0]["game_pk"]
        print(f"     using live game_pk={game_pk}: "
              f"{live[0].get('away_team')} @ {live[0].get('home_team')}")
    else:
        game_pk = FALLBACK_GAME_PK
        print(f"No live games — using fallback game_pk={game_pk}")

    try:
        pitches = await get_play_by_play(game_pk)
        print(f"[OK] get_play_by_play({game_pk}): {len(pitches)} pitches")
        for p in pitches[:5]:
            print(json.dumps(_summarize(p), default=str, indent=2))
    except Exception as exc:
        print(f"[FAIL] get_play_by_play({game_pk}): {exc}")
        failures += 1

    print(f"=== done: {'OK' if failures == 0 else f'{failures} failure(s)'} ===")
    return failures


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
