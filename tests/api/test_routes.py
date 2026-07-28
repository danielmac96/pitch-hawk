"""Route-level tests via FastAPI's TestClient.

Each test mounts only the router under test on a throwaway FastAPI() app —
never the real `backend.api.main:app`, whose lifespan starts a poller that
hits the live MLB Stats API and a real Supabase project. Module-level
`get_client` references inside each route module are monkeypatched to a
FakeSupabaseClient (see tests/conftest.py), so this file has zero external
dependencies.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.conftest import FakeSupabaseClient


def _client_for(router) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


# --- /predictions/{game_pk} --------------------------------------------------

def test_predictions_404_when_no_live_state(monkeypatch, stub_predictor_cache):
    from backend.api.routes import predictions as mod

    fake = FakeSupabaseClient({"live_state": []})
    monkeypatch.setattr(mod, "get_client", lambda: fake)
    monkeypatch.setattr(mod, "insert_predictions", lambda *a, **k: None)
    monkeypatch.setattr(mod, "current_pa_position", lambda game_pk: (None, None))

    resp = _client_for(mod.router).get("/predictions/123")
    assert resp.status_code == 404


def test_predictions_200_runs_all_four_markets(monkeypatch, stub_predictor_cache):
    from backend.api.routes import predictions as mod

    fake = FakeSupabaseClient({
        "live_state": [{
            "game_pk": 123, "pitcher_id": 1, "batter_id": 2,
            "balls": 1, "strikes": 1, "pitch_count_pa": 2, "inning": 3,
        }],
    })
    monkeypatch.setattr(mod, "get_client", lambda: fake)
    monkeypatch.setattr(mod, "insert_predictions", lambda *a, **k: None)
    monkeypatch.setattr(mod, "current_pa_position", lambda game_pk: (1, 2))

    resp = _client_for(mod.router).get("/predictions/123")
    assert resp.status_code == 200
    body = resp.json()
    markets = {p["market"] for p in body["predictions"]}
    assert markets == {"pitch_speed_ou", "pitch_result", "ab_result", "ab_pitches_ou"}


def test_predictions_rejects_non_positive_game_pk():
    from backend.api.routes import predictions as mod

    resp = _client_for(mod.router).get("/predictions/-1")
    assert resp.status_code == 422


# --- /edge/{game_pk} ---------------------------------------------------------

def test_edge_sorts_rows_by_edge_descending(monkeypatch, stub_predictor_cache):
    from backend.api.routes import edge as mod

    fake = FakeSupabaseClient({
        "live_state": [{
            "game_pk": 123, "pitcher_id": 1, "batter_id": 2,
            "balls": 0, "strikes": 0, "pitch_count_pa": 0, "inning": 1,
        }],
    })
    monkeypatch.setattr(mod, "get_client", lambda: fake)

    resp = _client_for(mod.router).get("/edge/123")
    assert resp.status_code == 200
    rows = resp.json()
    edges = [r["edge"] for r in rows if r["edge"] is not None]
    assert edges == sorted(edges, reverse=True)


def test_edge_404_when_no_live_state(monkeypatch, stub_predictor_cache):
    from backend.api.routes import edge as mod

    monkeypatch.setattr(mod, "get_client", lambda: FakeSupabaseClient({"live_state": []}))
    resp = _client_for(mod.router).get("/edge/999")
    assert resp.status_code == 404


# --- /odds/{game_pk} ---------------------------------------------------------

def test_odds_returns_stub_ou_markets():
    from backend.api.routes import odds as mod

    resp = _client_for(mod.router).get("/odds/123")
    assert resp.status_code == 200
    rows = resp.json()
    # the stub only prices the two O/U micro-markets, all sourced "stub"
    assert {r["market"] for r in rows} == {"pitch_speed_ou", "ab_pitches_ou"}
    assert all(r["source"] == "stub" for r in rows)


# --- /sportsbooks, /track/click ----------------------------------------------

def test_sportsbooks_includes_disclaimer_and_books():
    from backend.api.routes import bets as mod

    resp = _client_for(mod.router).get("/sportsbooks")
    assert resp.status_code == 200
    body = resp.json()
    assert "disclaimer" in body
    assert len(body["books"]) == 5


def test_track_click_route_is_gone(monkeypatch):
    """POST /track/click was removed with the bet_clicks table in 2026-07
    (migration 20260728000001). The funnel never recorded a row."""
    from backend.api.routes import bets as mod

    resp = _client_for(mod.router).post("/track/click", json={"game_pk": 1})
    assert resp.status_code == 404


# --- /admin/tables/preview ----------------------------------------------------

def test_admin_preview_degrades_to_error_entry_on_missing_table(monkeypatch):
    from backend.api.routes import admin as mod

    monkeypatch.setattr(mod, "get_client", lambda: FakeSupabaseClient({"pitches": [{"id": 1}]}))
    resp = _client_for(mod.router).get("/admin/tables/preview")
    assert resp.status_code == 200
    body = resp.json()
    assert "pitches" in body
    assert body["pitches"]["rows"] == [{"id": 1}]
