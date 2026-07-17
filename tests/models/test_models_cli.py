"""Tests for scripts/models.py — the model registry CLI.

The command functions take the client as an argument, so they run against the
in-memory FakeSupabaseClient from conftest; no Supabase project needed.
"""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("models_cli", _ROOT / "scripts" / "models.py")
models_cli = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(models_cli)


def _seed_registry(client):
    client.seed("model_params", [
        {"market": "pitch_result", "version": "v1_20260707", "is_active": False,
         "trained_at": "2026-07-07T00:00:00+00:00", "activated_at": "2026-07-07T00:00:00+00:00",
         "params": {"type": "multinomial_logistic"}, "metrics": {"weighted_logloss": 1.01},
         "notes": "first fit"},
        {"market": "pitch_result", "version": "v1_20260714", "is_active": True,
         "trained_at": "2026-07-14T00:00:00+00:00", "activated_at": "2026-07-14T00:00:00+00:00",
         "params": {"type": "multinomial_logistic"}, "metrics": {"weighted_logloss": 0.99},
         "notes": "weekly refit"},
    ])


def test_list_marks_active_row(fake_client, capsys):
    _seed_registry(fake_client)
    assert models_cli.cmd_list(fake_client, None) == 0
    out = capsys.readouterr().out
    active_line = next(l for l in out.splitlines() if "v1_20260714" in l)
    assert "*" in active_line
    inactive_line = next(l for l in out.splitlines() if "v1_20260707" in l)
    assert "*" not in inactive_line


def test_show_defaults_to_active(fake_client, capsys):
    _seed_registry(fake_client)
    args = models_cli.build_parser().parse_args(["show", "pitch_result"])
    assert models_cli.cmd_show(fake_client, args) == 0
    row = json.loads(capsys.readouterr().out)
    assert row["version"] == "v1_20260714"
    assert row["params"]["type"] == "multinomial_logistic"


def test_show_missing_version_fails_cleanly(fake_client, capsys):
    _seed_registry(fake_client)
    args = models_cli.build_parser().parse_args(
        ["show", "pitch_result", "--version", "nope"])
    assert models_cli.cmd_show(fake_client, args) == 1


def test_status_aggregates_graded_predictions(fake_client, capsys):
    _seed_registry(fake_client)
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(hours=1)).isoformat()
    stale = (now - timedelta(days=30)).isoformat()
    fake_client.seed("predictions", [
        {"market": "pitch_result", "model_version": "v1_20260714",
         "result": "win", "profit_units": 0.91, "created_at": recent},
        {"market": "pitch_result", "model_version": "v1_20260714",
         "result": "loss", "profit_units": -1.0, "created_at": recent},
        {"market": "pitch_result", "model_version": "v1_20260714",
         "result": None, "profit_units": None, "created_at": recent},
        # outside the window: must not count
        {"market": "pitch_result", "model_version": "v1_20260707",
         "result": "win", "profit_units": 0.91, "created_at": stale},
    ])
    args = models_cli.build_parser().parse_args(["status", "--days", "7"])
    assert models_cli.cmd_status(fake_client, args) == 0
    out = capsys.readouterr().out
    line = next(l for l in out.splitlines() if "v1_20260714" in l)
    assert "3" in line          # preds in window (incl. ungraded)
    assert "0.500" in line      # win rate over the 2 graded
    assert "v1_20260707" not in out.replace("active", "")  # stale version not scored


def test_activate_and_rollback_call_rpcs(fake_client, capsys):
    calls = []

    def rpc(name, params):
        calls.append((name, params))
        class _R:
            data = "v1_20260707"
            def execute(self): return self
        return _R()

    fake_client.rpc = rpc
    args = models_cli.build_parser().parse_args(
        ["activate", "pitch_result", "v1_20260714"])
    assert models_cli.cmd_activate(fake_client, args) == 0
    args = models_cli.build_parser().parse_args(["rollback", "pitch_result"])
    assert models_cli.cmd_rollback(fake_client, args) == 0
    assert calls == [
        ("activate_model", {"p_market": "pitch_result", "p_version": "v1_20260714"}),
        ("rollback_model", {"p_market": "pitch_result"}),
    ]


def test_parser_rejects_unknown_market():
    with pytest.raises(SystemExit):
        models_cli.build_parser().parse_args(["show", "not_a_market"])
