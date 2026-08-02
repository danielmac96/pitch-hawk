"""Tests for `python -m warehouse pending`, the nightly workflow's catch-up.

The subtlety worth testing is why this command does not reason from
max(manifest day): off-days write no manifest entry, so the high-water mark is
the last day that *had games*. From October to March that is months behind by
design, and a naive gap check would fail the nightly every night all winter.
"""

from __future__ import annotations

import json

import pytest

from warehouse import cli, manifest
from warehouse.config import MANIFEST_KEY
from warehouse.store import LocalStore

YESTERDAY = "2026-08-01"


@pytest.fixture
def root(tmp_path):
    """A store whose manifest holds the days named in `have`."""
    def build(have: list[str]) -> str:
        store = LocalStore(tmp_path)
        m = manifest.empty()
        for day in have:
            manifest.record(m, "pitches", day, rows=100, size_bytes=10,
                            checksum="abc", ingested_at="2026-08-01T00:00:00Z")
        store.put(MANIFEST_KEY,
                  json.dumps(m, indent=2, sort_keys=True).encode("utf-8"))
        return str(tmp_path)
    return build


@pytest.fixture
def stub(monkeypatch):
    """Pin 'yesterday' and stub the schedule. `with_games` is the set of days
    the MLB API reports final regular-season games for."""
    def apply(with_games: set[str]):
        monkeypatch.setattr(cli, "_yesterday", lambda: YESTERDAY)
        monkeypatch.setattr(
            cli, "schedule",
            lambda day, game_type="R": (
                [{"gamePk": 1, "officialDate": day}] if day in with_games
                else []))
    return apply


def _run(root_dir, max_gap=3):
    return cli.main(["--local", root_dir, "pending", "--max-gap", str(max_gap)])


def test_pending_lists_days_with_games_and_no_manifest_entry(
        root, stub, capsys):
    stub(with_games={"2026-07-30", "2026-07-31", "2026-08-01"})
    code = _run(root(["2026-07-30"]))

    assert code == cli.EXIT_OK
    assert capsys.readouterr().out.split() == ["2026-07-31", "2026-08-01"]


def test_pending_skips_days_already_in_the_manifest(root, stub, capsys):
    stub(with_games={"2026-07-30", "2026-07-31", "2026-08-01"})
    code = _run(root(["2026-07-30", "2026-07-31", "2026-08-01"]))

    assert code == cli.EXIT_OK
    assert capsys.readouterr().out.strip() == ""


def test_pending_is_quiet_when_no_day_in_the_window_had_games(
        root, stub, capsys):
    """The off-season, and the All-Star break in miniature. A day with no final
    games is not a gap, and must not fail the nightly — five months of red is
    how a signal stops being read."""
    stub(with_games=set())
    code = _run(root(["2026-07-30"]))

    assert code == cli.EXIT_OK
    assert capsys.readouterr().out.strip() == ""


def test_pending_ignores_gameless_days_between_real_ones(root, stub, capsys):
    stub(with_games={"2026-07-30", "2026-08-01"})   # 07-31 is an off-day
    code = _run(root(["2026-07-30"]))

    assert code == cli.EXIT_OK
    assert capsys.readouterr().out.split() == ["2026-08-01"]


def test_pending_exits_2_when_the_whole_window_is_missing(root, stub, capsys):
    """Behind by at least the window: the true extent is unknown, so refuse
    rather than start what could become a 2,000-day backfill. Opening day looks
    identical, and a seasonal backfill should be a human decision."""
    stub(with_games={"2026-07-30", "2026-07-31", "2026-08-01"})
    code = _run(root([]))

    assert code == cli.EXIT_ERROR
    out = capsys.readouterr()
    # The days are still printed, so an operator can see what it found.
    assert out.out.split() == ["2026-07-30", "2026-07-31", "2026-08-01"]
    assert "behind by at least" in out.err


def test_pending_on_an_empty_manifest_in_the_off_season_is_still_quiet(
        root, stub, capsys):
    """An empty manifest is only alarming if there was something to ingest."""
    stub(with_games=set())
    assert _run(root([])) == cli.EXIT_OK
    assert capsys.readouterr().out.strip() == ""
