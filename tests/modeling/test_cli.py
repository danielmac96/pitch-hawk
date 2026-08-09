"""CLI surface. Parser-level only -- no network."""

from __future__ import annotations

import pytest

from modeling.cli import build_parser


@pytest.mark.parametrize("cmd", ["build", "train", "sweep", "baseline",
                                 "list", "show", "status", "activate",
                                 "rollback"])
def test_command_exists(cmd):
    args = build_parser().parse_args(
        [cmd] + (["pitch_result"] if cmd in
                 ("train", "sweep", "show", "activate", "rollback") else [])
        + (["v2_20260808"] if cmd == "activate" else []))
    assert args.command == cmd


def test_train_promote_defaults_off():
    """Promotion must always be opt-in."""
    assert build_parser().parse_args(["train", "pitch_result"]).promote is False


def test_train_accepts_promote_flag():
    assert build_parser().parse_args(
        ["train", "pitch_result", "--promote"]).promote is True


def test_no_force_flag_exists():
    """--force bypassed the gate in the old trainer. It is not coming back."""
    with pytest.raises(SystemExit):
        build_parser().parse_args(["train", "pitch_result", "--force"])
