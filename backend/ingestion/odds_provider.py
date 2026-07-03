"""Pluggable odds providers.

`get_odds(game_pk)` resolves to whichever provider `ODDS_PROVIDER` selects:
  * "stub"     -> StubOddsProvider (deterministic placeholder lines)
  * "supabase" -> SupabaseOddsProvider (latest ingested rows from the `odds`
                  table — populated by the odds-ingest edge function)

Row shape (shared by every provider):
    {"market": str, "line": float | None,
     "over_price": int | None, "under_price": int | None, "source": str}
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod


def implied_probability(american_odds: int | None) -> float | None:
    if american_odds is None:
        return None
    if american_odds >= 0:
        return 100.0 / (american_odds + 100.0)
    return abs(american_odds) / (abs(american_odds) + 100.0)


def calculate_edge(model_prob: float | None, american_odds: int | None) -> float | None:
    """model probability minus the (vigged) implied probability of the price."""
    imp = implied_probability(american_odds)
    if model_prob is None or imp is None:
        return None
    return round(model_prob - imp, 4)


class OddsProvider(ABC):
    @abstractmethod
    def get_odds(self, game_pk: int) -> list[dict]: ...


class StubOddsProvider(OddsProvider):
    """Deterministic placeholder lines for the two O/U micro-markets.

    Real per-pitch/per-at-bat prices have no free public source; these rows
    exist so the edge plumbing stays exercised end-to-end. They are labeled
    `stub` so the frontend can badge them honestly.
    """

    ODDS: list[dict] = [
        {"market": "pitch_speed_ou", "line": 92.5, "over_price": -110,
         "under_price": -110, "source": "stub"},
        {"market": "ab_pitches_ou", "line": 3.5, "over_price": -115,
         "under_price": -105, "source": "stub"},
    ]

    def get_odds(self, game_pk: int) -> list[dict]:
        return [dict(row) for row in self.ODDS]


class SupabaseOddsProvider(OddsProvider):
    """Latest ingested odds snapshot per market from the `odds` table."""

    def get_odds(self, game_pk: int) -> list[dict]:
        from backend.db.client import get_client

        rows = (
            get_client().table("odds")
            .select("market,line,over_price,under_price,source,fetched_at")
            .eq("game_pk", game_pk)
            .order("fetched_at", desc=True)
            .limit(50)
            .execute().data
            or []
        )
        latest: dict[str, dict] = {}
        for r in rows:  # newest first; keep the first row seen per market
            key = f"{r.get('market')}::{r.get('source')}"
            if key not in latest:
                latest[key] = {
                    "market": r.get("market"),
                    "line": float(r["line"]) if r.get("line") is not None else None,
                    "over_price": r.get("over_price"),
                    "under_price": r.get("under_price"),
                    "source": r.get("source") or "supabase",
                }
        return list(latest.values())


_PROVIDERS = {
    "stub": StubOddsProvider,
    "supabase": SupabaseOddsProvider,
}

_provider: OddsProvider | None = None


def get_provider() -> OddsProvider:
    global _provider
    if _provider is None:
        name = (os.environ.get("ODDS_PROVIDER") or "stub").lower()
        cls = _PROVIDERS.get(name)
        if cls is None:
            print(f"[odds_provider] unknown ODDS_PROVIDER={name!r}; using stub")
            cls = StubOddsProvider
        _provider = cls()
    return _provider


def get_odds(game_pk: int) -> list[dict]:
    return get_provider().get_odds(game_pk)
