"""Backward-compatible alias for the stub odds provider.

The real abstraction now lives in `backend.ingestion.odds_provider`
(`OddsProvider`, `StubOddsProvider`, `get_provider`). This module is kept so
existing imports (`from backend.ingestion.odds_stub import get_odds,
calculate_edge`) keep working — it always uses the stub, regardless of
`ODDS_PROVIDER`, since callers importing this module by name are asking for
the stub specifically.
"""

from __future__ import annotations

from backend.ingestion.odds_provider import (
    StubOddsProvider,
    calculate_edge,
    implied_probability,
)

_STUB_ODDS: list[dict] = StubOddsProvider.ODDS
_stub = StubOddsProvider()


def get_odds(game_pk: int) -> list[dict]:
    return _stub.get_odds(game_pk)


__all__ = ["get_odds", "implied_probability", "calculate_edge", "_STUB_ODDS"]
