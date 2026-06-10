"""In-memory live-game store. SINGLE uvicorn worker only.

Each poller tick derives live_state + the current plate-appearance pitches in
memory and writes them here. /live, /live/{game_pk}, and the SSE stream read
from this store so the request path never round-trips through Supabase — that
read-back was ~half of the avoidable end-to-end latency.

Supabase stays the audit log / ML training store; it is written fire-and-forget
off to the side and is also used as a graceful-degradation fallback whenever the
store is empty (e.g. right after a restart, before the first poll completes).

State here lives in this process only, which is why the poller and store require
a single worker — see the startup guard in main.py.
"""

from __future__ import annotations

import time


class LiveStore:
    def __init__(self) -> None:
        # game_pk -> live_state dict (includes "game_pk")
        self._states: dict[int, dict] = {}
        # game_pk -> current-PA pitches, oldest first, in the /live shape
        self._pa_pitches: dict[int, list[dict]] = {}
        # game_pk -> wall-clock time of last update (for diagnostics)
        self._updated_at: dict[int, float] = {}

    def update(
        self, game_pk: int, state: dict, pa_pitches: list[dict] | None
    ) -> bool:
        """Replace the stored snapshot for a game.

        Returns True when this looks like a *new pitch* (last_pitch_ts advanced),
        so callers can decide whether to push an SSE update.
        """
        prev = self._states.get(game_pk)
        changed = not prev or prev.get("last_pitch_ts") != state.get("last_pitch_ts")
        self._states[game_pk] = state
        if pa_pitches is not None:
            self._pa_pitches[game_pk] = pa_pitches
        self._updated_at[game_pk] = time.time()
        return changed

    def get_state(self, game_pk: int) -> dict | None:
        return self._states.get(game_pk)

    def all_states(self) -> list[dict]:
        return list(self._states.values())

    def get_pa_pitches(self, game_pk: int) -> list[dict] | None:
        return self._pa_pitches.get(game_pk)

    def has_data(self) -> bool:
        return bool(self._states)


_store = LiveStore()


def get_store() -> LiveStore:
    return _store
