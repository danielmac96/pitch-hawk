"""The verdict layer: every question the dashboard answers with pass/warn/fail.

A check is a named question with one status, a one-line answer, and the rows
that justify it. The page leads with these so the reader is told what is wrong
rather than left to compare numbers against remembered norms.

Two families, separated by what they cost:

  * **Manifest checks** read `_manifest.json` only. They cover all 2,014 days
    and cost one GET, so they always run.
  * **Scan checks** read Parquet in R2 and are bounded by the sidebar window.

Every threshold below is a constant with the measurement that set it. They were
calibrated against the live warehouse on 2026-08-04: an uncalibrated robust-z
rule marked 293 of 2,014 pitch-days as failing, essentially all of them healthy,
because raw spread ignores schedule size and Parquet's fixed per-file overhead.
The guards in `metrics` bring that to 1 warn in the last 14 days per dataset.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import pandas as pd
from utils import metrics

# The verdict judges recent operations, not the whole corpus. Historical
# oddities belong in the charts; they are not something to act on tonight.
RECENT_DAYS = 7

# Time since the newest object was written. The nightly runs daily, so a gap
# beyond ~30h means a run was missed and beyond 48h means two were.
WRITE_WARN_HOURS = 30.0
WRITE_FAIL_HOURS = 48.0

# How far the newest game date may trail today (UTC). The nightly writes at
# ~16:15 UTC covering through the previous day, so being two days back is the
# normal resting state, not a fault.
BEHIND_WARN_DAYS = 3
BEHIND_FAIL_DAYS = 4

# Independent verification (`warehouse.verify` re-fetches the day and re-derives
# it) is what the Supabase prune gates its deletes on, so an unverified recent
# day is an operational signal even though the data may be fine.
VERIFY_LOOKBACK_DAYS = 3

# In-season calendar days with no file at all. The lookback is deliberately
# short: the All-Star break is a legitimate three-to-four-day run of missing
# days, and a 45-day window kept it flagged for six weeks after it ended. Two
# weeks keeps the question operational — "did we miss a day recently?" — and
# lets the break age out of it.
GAP_LOOKBACK_DAYS = 14
GAP_WARN_DAYS = 1
GAP_FAIL_DAYS = 3

# Cross-dataset ratios. Both are stable properties of baseball rather than of
# the pipeline: ~3.9 pitches per plate appearance, ~75 plate appearances per
# game. A move past these bounds means one dataset was written without another.
PITCHES_PER_PA_RANGE = (3.4, 4.4)
PA_PER_GAME_RANGE = (60.0, 95.0)

# Null-rate movement, in percentage points, of the latest day against the
# baseline window. Structural nulls are exempt (see metrics.STRUCTURAL_NULL_COLUMNS).
NULL_MOVE_WARN_PP = 1.0
NULL_MOVE_FAIL_PP = 5.0

# Impossible values are scored by movement, not by count: how far a rule's
# firing rate (percent of rows) moved between the baseline window and the latest
# day before it counts as new breakage rather than a known defect.
VIOLATION_RATE_MOVE_PP = 5.0

# How many baseline observations a category value needs before its absence on
# the latest day means anything.
CATEGORY_MIN_BASELINE = 20


@dataclass(frozen=True)
class Check:
    """One QA question, its verdict, and the rows that justify it."""

    id: str
    label: str
    status: str
    headline: str
    detail: str = ""
    evidence: pd.DataFrame | None = None


def overall(checks: list[Check]) -> str:
    """The page's verdict: the worst status among the checks."""
    return metrics.worst(c.status for c in checks)


def summarize(checks: list[Check]) -> str:
    """`3 checks failing, 1 to watch` — the line beside the verdict."""
    failing = sum(1 for c in checks if c.status == "fail")
    watching = sum(1 for c in checks if c.status == "warn")
    if not failing and not watching:
        return f"{len(checks)} checks pass"
    parts = []
    if failing:
        parts.append(f"{failing} failing")
    if watching:
        parts.append(f"{watching} to watch")
    return ", ".join(parts) + f" of {len(checks)} checks"


def _recent(scored: pd.DataFrame, dataset: str | None = None) -> pd.DataFrame:
    """The last `RECENT_DAYS` scored days, optionally for one dataset."""
    frame = scored if dataset is None else scored[scored["dataset"] == dataset]
    return frame.sort_values("day").groupby("dataset", sort=False).tail(RECENT_DAYS)


# ── manifest checks ─────────────────────────────────────────────────────────


def check_write_freshness(scored: pd.DataFrame, now: pd.Timestamp) -> Check:
    """Time since anything was written at all — the primary "did it run?" signal."""
    newest = scored["ingested_at"].max()
    if pd.isna(newest):
        return Check(
            "freshness", "Freshness", "fail", "No write timestamps in the manifest"
        )

    hours = (now - newest).total_seconds() / 3600.0
    if hours < -1:
        # A future-dated write is a clock or timezone fault somewhere in the
        # writer, and it would otherwise read as "very fresh".
        return Check(
            "freshness",
            "Freshness",
            "warn",
            f"Newest write is {abs(hours):.1f}h in the future",
            "The writer's clock disagrees with this machine's.",
        )
    status = (
        "fail"
        if hours > WRITE_FAIL_HOURS
        else "warn" if hours > WRITE_WARN_HOURS else "pass"
    )
    return Check(
        "freshness",
        "Freshness",
        status,
        f"Last write {hours:.1f}h ago",
        f"Warn past {WRITE_WARN_HOURS:.0f}h, fail past {WRITE_FAIL_HOURS:.0f}h — "
        "the ingest runs nightly.",
    )


def check_currency(scored: pd.DataFrame, today: date) -> Check:
    """How far the newest *game date* trails today, which is what a user feels."""
    if scored.empty:
        return Check("currency", "Coverage", "fail", "The manifest holds no days")
    latest = max(scored["day"])
    behind = (today - latest).days
    status = (
        "fail"
        if behind >= BEHIND_FAIL_DAYS
        else "warn" if behind >= BEHIND_WARN_DAYS else "pass"
    )
    return Check(
        "currency",
        "Coverage",
        status,
        f"Newest game day {latest} ({behind}d behind {today})",
        f"The nightly covers through the previous day, so ~2d behind is the "
        f"resting state. Warn at {BEHIND_WARN_DAYS}d.",
    )


def check_volume(scored: pd.DataFrame) -> Check:
    """Rows per game against each dataset's own trailing baseline.

    Rows per game rather than rows: raw volume swings with the number of games
    played, so a light schedule and a half-ingested day look identical until the
    schedule is divided out.
    """
    recent = _recent(scored)
    flagged = recent[recent["rows_per_game_status"] != "pass"]
    status = metrics.worst(recent["rows_per_game_status"])
    if flagged.empty:
        headline = f"Rows per game normal across {len(recent)} recent day-files"
    else:
        worst_row = flagged.sort_values("rows_per_game_rel_pct").iloc[0]
        headline = (
            f"{len(flagged)} day-file(s) off baseline — worst "
            f"{worst_row['dataset']} {worst_row['day']} at "
            f"{worst_row['rows_per_game_rel_pct']:+.1f}%"
        )
    return Check(
        "volume",
        "Volume",
        status,
        headline,
        f"Robust z against the trailing {metrics.BASELINE_DAYS} present days, "
        f"with a {metrics.REL_FLOOR_PCT:g}% floor and a "
        f"{metrics.MIN_GAMES_TO_JUDGE}-game minimum.",
        evidence=(
            flagged[
                [
                    "dataset",
                    "day",
                    "rows",
                    "expected_rows",
                    "games",
                    "rows_per_game",
                    "rows_per_game_rel_pct",
                    "rows_per_game_z",
                ]
            ]
            if not flagged.empty
            else None
        ),
    )


def check_file_size(scored: pd.DataFrame) -> Check:
    """Bytes per row — a schema change or an all-null column with no scan."""
    recent = _recent(scored)
    flagged = recent[recent["bytes_per_row_status"] != "pass"]
    return Check(
        "size",
        "File size",
        metrics.worst(recent["bytes_per_row_status"]),
        (
            "Bytes per row steady"
            if flagged.empty
            else f"{len(flagged)} day-file(s) off baseline"
        ),
        f"Judged only on files of {metrics.MIN_ROWS_FOR_BYTES:,}+ rows, at a "
        f"{metrics.BYTES_FLOOR_PCT:g}% floor — Parquet's fixed overhead moves "
        "this on small files.",
        evidence=(
            flagged[
                [
                    "dataset",
                    "day",
                    "rows",
                    "bytes",
                    "bytes_per_row",
                    "bytes_per_row_rel_pct",
                ]
            ]
            if not flagged.empty
            else None
        ),
    )


def check_lag(scored: pd.DataFrame) -> Check:
    """How long after the games a day's file appeared."""
    recent = _recent(scored)
    nightly = recent[~recent["from_backfill"]]
    flagged = recent[recent["lag_days_status"] != "pass"]
    # The median is taken over nightly writes for the same reason the rule is:
    # mixing in a backfill's lag describes history, not the job.
    median_lag = nightly["lag_days"].median() if not nightly.empty else float("nan")
    return Check(
        "lag",
        "Ingest lag",
        metrics.worst(recent["lag_days_status"]),
        (
            "No nightly writes in the recent window"
            if pd.isna(median_lag)
            else f"Median lag {median_lag:.1f}d over {len(nightly)} nightly files"
        )
        + ("" if flagged.empty else f" · {len(flagged)} past threshold"),
        f"Warn past {metrics.LAG_WARN_DAYS:g}d, fail past "
        f"{metrics.LAG_FAIL_DAYS:g}d, on recent nightly-written days only — a "
        "backfill covering years of history in one pass has an enormous lag "
        "and is not late.",
        evidence=(
            flagged[["dataset", "day", "ingested_at", "lag_days"]]
            if not flagged.empty
            else None
        ),
    )


def check_alignment(cross: pd.DataFrame) -> Check:
    """The three datasets describing the same days, the same way.

    Catches the failure no single dataset can show: `pitches` landing while
    `games` did not. The ratios are properties of baseball, so a move past them
    means rows are missing on one side rather than that the game changed.
    """
    recent = cross.sort_values("day").tail(RECENT_DAYS)
    problems = recent[
        (recent["missing"] != "")
        | (~recent["games_agree"])
        | (~recent["pitches_per_pa"].between(*PITCHES_PER_PA_RANGE))
        | (~recent["pa_per_game"].between(*PA_PER_GAME_RANGE))
    ]
    if problems.empty:
        status, headline = (
            "pass",
            "pitches, at_bats and games agree on every recent day",
        )
    else:
        missing = problems[problems["missing"] != ""]
        status = "fail" if not missing.empty else "warn"
        headline = f"{len(problems)} recent day(s) disagree" + (
            f" — missing: {', '.join(sorted(set(missing['missing'])))}"
            if not missing.empty
            else ""
        )
    return Check(
        "alignment",
        "Cross-dataset",
        status,
        headline,
        f"Expected {PITCHES_PER_PA_RANGE[0]}–{PITCHES_PER_PA_RANGE[1]} pitches "
        f"per plate appearance and {PA_PER_GAME_RANGE[0]:.0f}–"
        f"{PA_PER_GAME_RANGE[1]:.0f} plate appearances per game.",
        evidence=problems if not problems.empty else None,
    )


def check_verification(scored: pd.DataFrame) -> Check:
    """Whether recent days have been independently re-derived.

    `verified_by` is only written by `warehouse.verify` after re-fetching the
    day from the MLB API — the ingest cannot vouch for itself. The Supabase
    prune refuses to delete a day without it.
    """
    recent = (
        scored.sort_values("day")
        .groupby("dataset", sort=False)
        .tail(VERIFY_LOOKBACK_DAYS)
    )
    share = float(recent["verified"].mean()) if not recent.empty else 0.0
    status = "pass" if share == 1.0 else "warn" if share > 0 else "fail"
    unverified = recent[~recent["verified"]]
    return Check(
        "verification",
        "Verification",
        status,
        f"{share:.0%} of the last {VERIFY_LOOKBACK_DAYS} day-files per dataset "
        "independently verified",
        "Only `warehouse.verify` writes `verified_by`; the hot-window prune "
        "gates its deletes on it.",
        evidence=(
            unverified[["dataset", "day", "rows", "ingested_at"]]
            if not unverified.empty
            else None
        ),
    )


def check_gaps(gaps: pd.DataFrame, today: date) -> Check:
    """In-season calendar days with no file, over the recent past."""
    if gaps.empty:
        return Check("gaps", "Day gaps", "pass", "No missing days inside a season span")
    cutoff = today - timedelta(days=GAP_LOOKBACK_DAYS)
    recent = gaps[pd.to_datetime(gaps["to"]).dt.date >= cutoff]
    missing_days = int(recent["days"].sum()) if not recent.empty else 0
    status = (
        "fail"
        if missing_days >= GAP_FAIL_DAYS
        else "warn" if missing_days >= GAP_WARN_DAYS else "pass"
    )
    return Check(
        "gaps",
        "Day gaps",
        status,
        (
            f"No missing days in the last {GAP_LOOKBACK_DAYS}"
            if missing_days == 0
            else f"{missing_days} missing day(s) in the last {GAP_LOOKBACK_DAYS}"
        ),
        "The All-Star break is a legitimate run of missing days; the run length "
        "is reported rather than judged.",
        evidence=recent if not recent.empty else None,
    )


def manifest_checks(
    scored: pd.DataFrame, cross: pd.DataFrame, gaps: pd.DataFrame, now: pd.Timestamp
) -> list[Check]:
    """Every check that needs nothing but the manifest."""
    today = now.date()
    return [
        check_write_freshness(scored, now),
        check_currency(scored, today),
        check_volume(scored),
        check_alignment(cross),
        check_lag(scored),
        check_file_size(scored),
        check_verification(scored),
        check_gaps(gaps, today),
    ]


# ── scan checks ─────────────────────────────────────────────────────────────


def check_duplicates(dataset: str, rows: int, distinct: int) -> Check:
    """Rows in excess of distinct natural keys — a day written twice."""
    dupes = rows - distinct
    return Check(
        "duplicates",
        "Duplicate keys",
        "fail" if dupes > 0 else "pass",
        (
            f"No duplicate keys in {rows:,} scanned `{dataset}` rows"
            if dupes == 0
            else f"{dupes:,} duplicate key(s) in `{dataset}`"
        ),
        "The natural key is the one the export checksum is built from.",
    )


def check_null_movement(movers: pd.DataFrame) -> Check:
    """Columns whose null rate moved against the baseline window.

    The absolute rate is not the question — `on_third` is 91% null every day by
    design. The question is whether today differs from the days before it.
    """
    # An empty frame means every column sits within NULL_MOVE_WARN_PP.
    if movers.empty:
        return Check(
            "nulls", "Null rates", "pass", "No column moved against its baseline"
        )
    worst_row = movers.iloc[0]
    status = metrics.worst(movers["status"])
    return Check(
        "nulls",
        "Null rates",
        status,
        f"{len(movers)} column(s) moved — worst `{worst_row['column']}` "
        f"{worst_row['delta_pp']:+.2f}pp",
        f"Latest day against the rest of the window. Warn past "
        f"{NULL_MOVE_WARN_PP:g}pp, fail past {NULL_MOVE_FAIL_PP:g}pp; "
        "structurally-null columns are exempt.",
        evidence=movers,
    )


def null_movers(split: pd.DataFrame, dataset: str) -> pd.DataFrame:
    """Per-column null-rate movement, worst first, exempting structural nulls.

    Takes the frame from `queries.missing_counts_split` and keeps only the
    columns that moved by more than `NULL_MOVE_WARN_PP` — the point is which
    columns changed, not the 51-row inventory of what is null all the time.
    """
    structural = metrics.STRUCTURAL_NULL_COLUMNS.get(dataset, frozenset())
    frame = split.copy()
    frame["delta_pp"] = frame["latest_pct"] - frame["baseline_pct"]
    frame = frame[frame["delta_pp"].abs() > NULL_MOVE_WARN_PP]
    if frame.empty:
        return pd.DataFrame(
            columns=[
                "column",
                "baseline_pct",
                "latest_pct",
                "delta_pp",
                "structural",
                "status",
            ]
        )
    frame["structural"] = frame["column"].isin(structural)
    frame["status"] = [
        (
            "pass"
            if is_structural
            else "fail" if abs(delta) > NULL_MOVE_FAIL_PP else "warn"
        )
        for delta, is_structural in zip(frame["delta_pp"], frame["structural"])
    ]
    frame = frame.reindex(
        frame["delta_pp"].abs().sort_values(ascending=False).index
    ).reset_index(drop=True)
    return frame[
        ["column", "baseline_pct", "latest_pct", "delta_pp", "structural", "status"]
    ]


def rule_movement(violations: pd.DataFrame) -> pd.DataFrame:
    """Add rates and a per-rule status to the raw violation counts.

    A rule that has always fired is a known defect in the ingest, not tonight's
    regression, and the two must not read the same. So the status is driven by
    *change*: a rule firing for the first time today fails, one whose rate moved
    sharply warns, and one firing at its usual rate is reported as `known`.

    This distinction is load-bearing here — `pitches.outs` breaks its range on
    ~22% of rows on every day in the corpus (see README), so without it the
    check would fail forever and be ignored within a week.
    """
    frame = violations.copy()
    if frame.empty:
        return frame
    frame["latest_rate"] = (
        100.0 * frame["latest"] / frame["latest_rows"].replace(0, pd.NA)
    )
    frame["baseline_rate"] = (
        100.0 * frame["baseline"] / frame["baseline_rows"].replace(0, pd.NA)
    )

    statuses = []
    for _, row in frame.iterrows():
        if row["latest"] == 0:
            statuses.append("pass")
        elif row["baseline"] == 0:
            statuses.append("fail")
        elif pd.isna(row["baseline_rate"]) or row["baseline_rate"] == 0:
            statuses.append("warn")
        else:
            moved = abs(row["latest_rate"] - row["baseline_rate"])
            statuses.append("warn" if moved > VIOLATION_RATE_MOVE_PP else "known")
    frame["status"] = statuses
    return frame.sort_values("status", key=lambda s: s.map(_RULE_RANK)).reset_index(
        drop=True
    )


_RULE_RANK = {"fail": 0, "warn": 1, "known": 2, "pass": 3}


def check_violations(violations: pd.DataFrame) -> Check:
    """Values that cannot occur in a valid feed — four balls, negative innings."""
    frame = rule_movement(violations)
    if frame.empty:
        return Check("violations", "Value sanity", "pass", "No rules for this dataset")

    firing = frame[frame["status"] != "pass"]
    new = firing[firing["status"] == "fail"]
    moved = firing[firing["status"] == "warn"]
    known = firing[firing["status"] == "known"]

    if not new.empty:
        status = "fail"
        headline = f"{len(new)} rule(s) broke for the first time today: " + ", ".join(
            new["rule"]
        )
    elif not moved.empty:
        status = "warn"
        headline = f"{len(moved)} rule(s) firing at an unusual rate"
    elif not known.empty:
        status = "warn"
        headline = (
            f"{len(known)} known rule(s) firing at their usual rate: "
            + ", ".join(known["rule"])
        )
    else:
        status = "pass"
        headline = "No impossible values on the latest day"

    return Check(
        "violations",
        "Value sanity",
        status,
        headline,
        "Range and consistency rules a valid feed cannot break, scored by how "
        f"much their rate moved: a shift past {VIOLATION_RATE_MOVE_PP:g}pp is "
        "new breakage, a steady rate is a known defect.",
        evidence=firing if not firing.empty else None,
    )


def category_diff(counts: pd.DataFrame) -> pd.DataFrame:
    """Values present on the latest day but not the baseline, and vice versa.

    Takes the frame from `queries.category_counts`. A value seen only today has
    `appeared`; one the baseline holds and today does not has `vanished`.
    """
    if counts.empty:
        return pd.DataFrame(
            columns=["field", "value", "change", "latest_n", "baseline_n"]
        )
    appeared = counts[(counts["latest_n"] > 0) & (counts["baseline_n"] == 0)].copy()
    appeared["change"] = "appeared"
    # A value the baseline barely holds can be absent for a day by chance — the
    # rare `CS` pitch type appears ~7 times a week — so only a value with real
    # baseline support counts as having vanished.
    vanished = counts[
        (counts["latest_n"] == 0) & (counts["baseline_n"] >= CATEGORY_MIN_BASELINE)
    ].copy()
    vanished["change"] = "vanished"
    out = pd.concat([appeared, vanished], ignore_index=True)
    return out[["field", "value", "change", "latest_n", "baseline_n"]]


def check_categories(diff: pd.DataFrame) -> Check:
    """Category values that appeared or vanished versus the baseline window.

    A new `pitch_type` is how a feed change or a flattener change announces
    itself; a vanished one is how a mapping silently breaks.
    """
    # An empty diff means every value seen on the latest day also appears in the
    # baseline window, and nothing the baseline holds has disappeared.
    if diff.empty:
        return Check(
            "categories", "Category sets", "pass", "No new or vanished category values"
        )
    appeared = diff[diff["change"] == "appeared"]
    vanished = diff[diff["change"] == "vanished"]
    parts = []
    if not appeared.empty:
        parts.append(f"{len(appeared)} new")
    if not vanished.empty:
        parts.append(f"{len(vanished)} vanished")
    return Check(
        "categories",
        "Category sets",
        "warn",
        " · ".join(parts) + " category value(s)",
        "A rare value can vanish for a day by chance; a new one is a feed or "
        "flattener change.",
        evidence=diff,
    )


def check_referential(missing_games: int, day: str) -> Check:
    """Pitches whose `game_pk` has no row in that day's `games` file."""
    return Check(
        "referential",
        "Referential",
        "fail" if missing_games > 0 else "pass",
        (
            f"Every pitch on {day} resolves to a game"
            if missing_games == 0
            else f"{missing_games:,} pitch(es) on {day} reference a missing game"
        ),
        "An anti-join of the day's `pitches` against its own `games` file.",
    )
