"""`--season` must not ask the archive for days that have not happened.

A season is expanded to YYYY-03-01 .. YYYY-11-15. For the CURRENT season that
end date is in the future, and Open-Meteo's archive endpoint answers a range
with a future tail by failing the WHOLE call:

    error: https://archive-api.open-meteo.com/v1/archive: HTTP Error 400

so `--season <this year>` wrote nothing at all, every year, until mid-November.
Found on the first real backfill: 2017-2025 landed 1,528 days and 2026 landed
zero.
"""

from __future__ import annotations

import pytest

from warehouse import cli
from warehouse.store import LocalStore

YESTERDAY = "2026-09-22"


@pytest.fixture
def captured(tmp_path, monkeypatch):
    """Run cmd_weather without touching R2 or the network; return the range
    that reached ingest_weather_range."""
    seen = {}

    def fake_range(store, start, end, *, archive=True):
        seen["start"], seen["end"], seen["archive"] = start, end, archive
        return {"days": 1, "games": 1, "rows": 1, "bytes": 10}

    monkeypatch.setattr(cli, "ingest_weather_range", fake_range)
    monkeypatch.setattr(cli, "_yesterday", lambda: YESTERDAY)
    monkeypatch.setattr(cli, "_store", lambda args: LocalStore(tmp_path))
    return seen


def _args(**kw):
    ns = type("A", (), {"catchup": None, "season": None, "start": None,
                        "end": None, "forecast": False, "local": None})()
    for k, v in kw.items():
        setattr(ns, k, v)
    return ns


def test_the_current_season_is_clamped_to_yesterday(captured):
    assert cli.cmd_weather(_args(season=2026)) == cli.EXIT_OK
    assert captured["start"] == "2026-03-01"
    assert captured["end"] == YESTERDAY


def test_a_past_season_keeps_its_full_window(captured):
    """The clamp must not shorten a season that has actually ended."""
    assert cli.cmd_weather(_args(season=2025)) == cli.EXIT_OK
    assert captured["start"] == "2025-03-01"
    assert captured["end"] == "2025-11-15"


def test_a_season_that_has_not_started_makes_no_call(captured):
    assert cli.cmd_weather(_args(season=2027)) == cli.EXIT_OK
    assert captured == {}
