"""Tests for the QA dashboard's judgement layer.

The dashboard's value is entirely in *what it flags*, so these tests exercise
the thresholds against synthetic manifests: a healthy warehouse must come back
all-green, and each specific breakage must light exactly the check that owns it.

Every helper builds a manifest in the real shape `warehouse.manifest` writes, so
the frames under test are the same ones the app renders. No credentials, no
network, no R2 — `dashboard.utils.metrics` and `.checks` are pure functions.

The calibration these thresholds came from is in `dashboard/README.md`: an
uncalibrated robust-z rule marked 293 of 2,014 live pitch-days as failing, all
of them healthy, which is why the guards below (small-schedule days, small
files, backfill writes) exist and are tested.
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

DASHBOARD = Path(__file__).resolve().parents[2] / "dashboard"
if str(DASHBOARD) not in sys.path:
    sys.path.insert(0, str(DASHBOARD))

metrics = pytest.importorskip("utils.metrics")
checks = pytest.importorskip("utils.checks")

DATASETS = ("pitches", "at_bats", "games")

# One healthy day, per dataset: rows, games and the bytes those rows weigh.
SHAPE = {
    "pitches": (4300, 15, 68.0),
    "at_bats": (1120, 15, 25.0),
    "games": (15, 15, 590.0),
}

START = date(2026, 5, 1)
DAYS = 60
NOW = pd.Timestamp("2026-07-01 12:00", tz="UTC")


def _jitter(day: date, span: float, period: int) -> float:
    """A small deterministic wobble, so a baseline has non-zero spread.

    Without it every synthetic day is identical, MAD is exactly zero, and the
    rules fall back to their no-spread branch — which is not the branch the live
    warehouse exercises.
    """
    return 1.0 + span * ((day.toordinal() % period) - (period - 1) / 2) / period


def _entry(
    dataset: str,
    day: date,
    *,
    rows_scale: float = 1.0,
    games: int | None = None,
    bytes_per_row: float | None = None,
    written: date | None = None,
    verified: bool = True,
) -> dict:
    base_rows, base_games, base_bpr = SHAPE[dataset]
    n_games = base_games if games is None else games
    rows = round(base_rows * rows_scale * _jitter(day, 0.03, 7) * n_games / base_games)
    if dataset == "games":
        rows = n_games
    bpr = (base_bpr * _jitter(day, 0.02, 5)) if bytes_per_row is None else bytes_per_row
    write_day = written or (day + timedelta(days=1))
    return {
        "rows": rows,
        "games": n_games,
        "bytes": int(rows * bpr),
        "checksum": "x" * 8,
        "ingested_at": f"{write_day.isoformat()}T16:15:00+00:00",
        "verified_at": f"{write_day.isoformat()}T16:20:00+00:00" if verified else None,
        "verified_by": "verify_day/v2" if verified else None,
    }


def healthy_manifest(days: int = DAYS) -> dict:
    """A warehouse where nothing is wrong: steady volume, nightly writes."""
    m: dict = {"version": 2, "datasets": {ds: {} for ds in DATASETS}}
    for i in range(days):
        day = START + timedelta(days=i)
        for ds in DATASETS:
            m["datasets"][ds][day.isoformat()] = _entry(ds, day)
    return m


def last_day(m: dict) -> date:
    return max(date.fromisoformat(d) for d in m["datasets"]["pitches"])


def run_checks(m: dict, now: pd.Timestamp | None = None) -> dict[str, checks.Check]:
    """Every manifest check, keyed by id — the app's own composition."""
    scored = metrics.scored_frame(m, DATASETS)
    cross = metrics.cross_dataset_frame(m)
    gaps = metrics.season_gaps(sorted(m["datasets"]["pitches"]))
    if now is None:
        now = pd.Timestamp(last_day(m) + timedelta(days=1), tz="UTC") + pd.Timedelta(
            hours=18
        )
    return {c.id: c for c in checks.manifest_checks(scored, cross, gaps, now)}


# ── the statistics ──────────────────────────────────────────────────────────


def test_mad_is_zero_for_a_constant_series():
    assert metrics.mad(pd.Series([5.0] * 10)) == 0.0


def test_mad_ignores_a_single_extreme_value():
    """The reason MAD is used instead of σ: one broken day must not hide itself."""
    clean = pd.Series([100.0, 101.0, 99.0, 100.0, 101.0, 99.0, 100.0])
    with_outlier = pd.concat([clean, pd.Series([10.0])], ignore_index=True)
    assert metrics.mad(with_outlier) == pytest.approx(metrics.mad(clean), abs=0.6)
    assert with_outlier.std() > 3 * clean.std()


def test_severity_needs_both_a_z_score_and_a_relative_move():
    # Large z, tiny relative move — the case that flagged 293 healthy days.
    assert metrics.severity_from(9.0, 0.4) == "pass"
    # Large relative move, unremarkable z.
    assert metrics.severity_from(0.5, 40.0) == "pass"
    # Both.
    assert metrics.severity_from(4.0, 20.0) == "fail"
    assert metrics.severity_from(3.0, 20.0) == "warn"


def test_severity_without_spread_falls_back_to_the_relative_move():
    assert metrics.severity_from(None, 8.0) == "warn"
    assert metrics.severity_from(None, 40.0) == "fail"


def test_baseline_excludes_the_day_being_judged():
    """A day may not drag the median toward itself, or it hides its own break."""
    frame = pd.DataFrame({"v": [100.0] * 30 + [50.0]})
    scored = metrics.with_baseline(frame, "v")
    assert scored["v_median"].iloc[-1] == pytest.approx(100.0)
    assert scored["v_rel_pct"].iloc[-1] == pytest.approx(-50.0)
    assert scored["v_status"].iloc[-1] == "fail"


# ── the healthy baseline ────────────────────────────────────────────────────


def test_a_healthy_warehouse_passes_every_check():
    results = run_checks(healthy_manifest())
    assert checks.overall(list(results.values())) == "pass"
    assert [c.id for c in results.values() if c.status != "pass"] == []


def test_scored_frame_derives_the_qa_metrics():
    scored = metrics.scored_frame(healthy_manifest(), DATASETS)
    pitches = scored[scored["dataset"] == "pitches"].sort_values("day")
    # Within the deterministic wobble `_jitter` adds to the synthetic days.
    assert pitches["rows_per_game"].iloc[-1] == pytest.approx(4300 / 15, rel=0.03)
    assert pitches["bytes_per_row"].iloc[-1] == pytest.approx(68.0, rel=0.03)
    assert pitches["lag_days"].iloc[-1] == pytest.approx(1.677, abs=0.01)
    assert not pitches["from_backfill"].any()


# ── volume ──────────────────────────────────────────────────────────────────


def test_a_half_ingested_day_fails_the_volume_check():
    """The failure the old row-count chart could not distinguish from a light slate."""
    m = healthy_manifest()
    day = last_day(m).isoformat()
    m["datasets"]["pitches"][day] = _entry(
        "pitches", date.fromisoformat(day), rows_scale=0.5
    )
    assert run_checks(m)["volume"].status == "fail"


def test_a_light_schedule_does_not_fail_the_volume_check():
    """Four games instead of fifteen is a Monday, not a defect."""
    m = healthy_manifest()
    day = last_day(m)
    for ds in DATASETS:
        m["datasets"][ds][day.isoformat()] = _entry(ds, day, games=4)
    results = run_checks(m)
    assert results["volume"].status == "pass"
    assert results["alignment"].status == "pass"


def test_a_single_game_day_is_never_judged_on_volume():
    """Below MIN_GAMES_TO_JUDGE the sample is too small to mean anything."""
    m = healthy_manifest()
    day = last_day(m)
    for ds in DATASETS:
        m["datasets"][ds][day.isoformat()] = _entry(ds, day, games=1, rows_scale=0.7)
    assert run_checks(m)["volume"].status == "pass"


def test_expected_rows_scale_with_the_schedule():
    m = healthy_manifest()
    day = last_day(m)
    for ds in DATASETS:
        m["datasets"][ds][day.isoformat()] = _entry(ds, day, games=6)
    scored = metrics.scored_frame(m, DATASETS)
    row = scored[(scored["dataset"] == "pitches") & (scored["day"] == day)].iloc[0]
    assert row["expected_rows"] == pytest.approx(6 * 4300 / 15, rel=0.02)


# ── file size ───────────────────────────────────────────────────────────────


def test_a_schema_change_shows_up_as_bytes_per_row():
    m = healthy_manifest()
    day = last_day(m)
    m["datasets"]["pitches"][day.isoformat()] = _entry(
        "pitches", day, bytes_per_row=40.0
    )
    assert run_checks(m)["size"].status == "fail"


def test_small_files_are_not_judged_on_bytes_per_row():
    """`games` files are ~15 rows; Parquet overhead alone moves them 20%."""
    m = healthy_manifest()
    day = last_day(m)
    m["datasets"]["games"][day.isoformat()] = _entry("games", day, bytes_per_row=1200.0)
    assert run_checks(m)["size"].status == "pass"


# ── freshness and lag ───────────────────────────────────────────────────────


def test_a_stalled_nightly_fails_freshness():
    m = healthy_manifest()
    # The newest file was written the morning after the last game day, so two
    # missed nights puts the clock past WRITE_FAIL_HOURS.
    now = pd.Timestamp(last_day(m), tz="UTC") + pd.Timedelta(days=4)
    assert run_checks(m, now)["freshness"].status == "fail"


def test_a_future_dated_write_is_flagged_rather_than_read_as_fresh():
    m = healthy_manifest()
    now = pd.Timestamp(last_day(m), tz="UTC") - pd.Timedelta(days=2)
    check = run_checks(m, now)["freshness"]
    assert check.status == "warn"
    assert "future" in check.headline


def test_a_late_file_fails_the_lag_check():
    m = healthy_manifest()
    day = last_day(m)
    m["datasets"]["pitches"][day.isoformat()] = _entry(
        "pitches", day, written=day + timedelta(days=7)
    )
    assert run_checks(m)["lag"].status == "fail"


def test_a_backfill_is_not_treated_as_a_late_nightly():
    """One batch covering the whole corpus is catching up, not running late."""
    m = healthy_manifest()
    written = last_day(m) + timedelta(days=1)
    for ds in DATASETS:
        for day_str in m["datasets"][ds]:
            m["datasets"][ds][day_str] = _entry(
                ds, date.fromisoformat(day_str), written=written
            )
    scored = metrics.scored_frame(m, DATASETS)
    assert scored["from_backfill"].all()
    assert run_checks(m)["lag"].status == "pass"


# ── cross-dataset and coverage ──────────────────────────────────────────────


def test_a_dataset_landing_without_its_siblings_fails_alignment():
    """The failure no single dataset can show."""
    m = healthy_manifest()
    del m["datasets"]["games"][last_day(m).isoformat()]
    check = run_checks(m)["alignment"]
    assert check.status == "fail"
    assert "games" in check.headline


def test_disagreeing_game_counts_are_caught():
    m = healthy_manifest()
    day = last_day(m)
    m["datasets"]["games"][day.isoformat()] = _entry("games", day, games=9)
    assert run_checks(m)["alignment"].status != "pass"


def test_a_missing_recent_day_is_reported_as_a_gap():
    m = healthy_manifest()
    missing = (last_day(m) - timedelta(days=2)).isoformat()
    for ds in DATASETS:
        del m["datasets"][ds][missing]
    assert run_checks(m)["gaps"].status != "pass"


def test_stale_coverage_fails_even_when_the_writes_are_fresh():
    """Files being written says nothing about them holding recent games."""
    m = healthy_manifest()
    now = pd.Timestamp(last_day(m), tz="UTC") + pd.Timedelta(days=5)
    assert run_checks(m, now)["currency"].status == "fail"


def test_unverified_recent_days_are_flagged():
    m = healthy_manifest()
    day = last_day(m)
    for ds in DATASETS:
        m["datasets"][ds][day.isoformat()] = _entry(ds, day, verified=False)
    assert run_checks(m)["verification"].status == "warn"


# ── scan checks ─────────────────────────────────────────────────────────────


def test_duplicate_keys_fail():
    assert checks.check_duplicates("pitches", 100, 100).status == "pass"
    assert checks.check_duplicates("pitches", 101, 100).status == "fail"


def test_referential_orphans_fail():
    assert checks.check_referential(0, "2026-08-03").status == "pass"
    assert checks.check_referential(12, "2026-08-03").status == "fail"


def test_null_movers_ignore_structural_columns_and_small_moves():
    split = pd.DataFrame(
        {
            "column": ["pitch_type", "launch_speed", "spin_rate"],
            "latest_pct": [9.0, 90.0, 0.4],
            "baseline_pct": [0.5, 82.0, 0.1],
            "latest_rows": [4300] * 3,
            "baseline_rows": [4300] * 3,
        }
    )
    movers = checks.null_movers(split, "pitches")
    assert list(movers["column"]) == ["pitch_type", "launch_speed"]
    assert movers.set_index("column").loc["pitch_type", "status"] == "fail"
    # Structural: reported for context, never a failure.
    assert movers.set_index("column").loc["launch_speed", "status"] == "pass"
    assert checks.check_null_movement(movers).status == "fail"


def test_a_rule_that_always_fires_is_known_but_a_new_one_fails():
    """`pitches.outs` breaks its range on every day in the live corpus."""
    violations = pd.DataFrame(
        {
            "rule": ["outs outside 0-2", "balls outside 0-3"],
            "latest": [514, 30],
            "baseline": [1970, 0],
            "latest_rows": [2351, 2351],
            "baseline_rows": [8721, 8721],
        }
    )
    moved = checks.rule_movement(violations).set_index("rule")
    assert moved.loc["outs outside 0-2", "status"] == "known"
    assert moved.loc["balls outside 0-3", "status"] == "fail"
    check = checks.check_violations(violations)
    assert check.status == "fail"
    assert "balls outside 0-3" in check.headline


def test_a_known_rule_alone_only_warns():
    violations = pd.DataFrame(
        {
            "rule": ["outs outside 0-2"],
            "latest": [514],
            "baseline": [1970],
            "latest_rows": [2351],
            "baseline_rows": [8721],
        }
    )
    assert checks.check_violations(violations).status == "warn"


def test_category_diff_needs_baseline_support_to_call_a_value_vanished():
    counts = pd.DataFrame(
        {
            "field": ["pitch_type", "pitch_type", "pitch_type"],
            "value": ["FF", "CS", "SI"],
            "latest_n": [900, 0, 0],
            "baseline_n": [3600, 7, 400],
        }
    )
    diff = checks.category_diff(counts)
    assert list(diff["value"]) == ["SI"]
    assert diff.iloc[0]["change"] == "vanished"


def test_a_new_category_value_is_reported():
    counts = pd.DataFrame(
        {
            "field": ["pitch_type", "pitch_type"],
            "value": ["FF", "XX"],
            "latest_n": [900, 4],
            "baseline_n": [3600, 0],
        }
    )
    diff = checks.category_diff(counts)
    assert list(diff["change"]) == ["appeared"]
    assert checks.check_categories(diff).status == "warn"


# ── composition ─────────────────────────────────────────────────────────────


def test_overall_takes_the_worst_status():
    made = [
        checks.Check("a", "A", "pass", ""),
        checks.Check("b", "B", "warn", ""),
        checks.Check("c", "C", "fail", ""),
    ]
    assert checks.overall(made) == "fail"
    assert checks.overall(made[:2]) == "warn"
    assert checks.overall([]) == "pass"


def test_summarize_counts_what_is_wrong():
    made = [
        checks.Check("a", "A", "pass", ""),
        checks.Check("b", "B", "warn", ""),
        checks.Check("c", "C", "fail", ""),
    ]
    assert checks.summarize(made) == "1 failing, 1 to watch of 3 checks"
    assert checks.summarize(made[:1]) == "1 checks pass"
