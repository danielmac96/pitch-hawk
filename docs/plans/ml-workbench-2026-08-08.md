# ML Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repeatable `build → train → validate → record → promote` loop for the five MLB prediction markets, running entirely under local control, with every run recorded and every production version visible.

**Architecture:** A new `modeling/` package beside `warehouse/`. Each market is a declarative `MarketSpec` — feature SQL, model family, metric, serializer — driven by one shared engine. Features are built once from R2 Parquet into locally cached weighted cell tables; all fitting, folding and sweeping reads that local cache. Production scoring stays in the existing TypeScript edge function, pinned to a Python reference scorer by a golden-fixture parity test.

**Tech Stack:** Python 3.11+, DuckDB (over R2 via httpfs), PyArrow, scikit-learn, pandas, Supabase (Postgres), Streamlit, pytest. Production scorer is TypeScript/Deno (read-only for this plan).

**Two-day mapping:**

| | Phases | Deliverable at end of day |
|---|---|---|
| **Day 1** | 0 → 3 | The first honest out-of-sample number for `pitch_result`. `build → train → validate` works end to end on real data. |
| **Day 2** | 4 → 9 | Parity proof, run recording, gated promotion, all five markets, dashboard, cleanup. |

If Day 1 ends before Checkpoint 3, **do not skip ahead to Phase 7 to add markets.** A workbench covering one market is worth more than five markets with no validation loop.

---

## 0. Your role, Claude Code

You are implementing this plan in an existing, working production system. A live MLB prediction app serves real predictions from this repo every 30 seconds. **This project adds an offline capability. It must not change what production does until a human explicitly promotes a model.**

### The objective

Produce a workbench the owner can run locally, repeatedly, and trust:

```
build     → pull features from R2 once, cache them locally
train     → fit + sweep hyperparameters on cached cells
validate  → walk-forward out-of-sample, plus a frozen 2026 holdout
record    → write every run to model_runs, promoted or not
promote   → gate on out-of-sample metrics, then activate_model()
```

This is a **portfolio project**. The person reading this code later is a hiring manager. That means: honest metrics over flattering ones, a visible audit trail of what was tried and rejected, no silent failures, and code that explains *why* in its docstrings — matching the existing style in `warehouse/`.

### Rules — follow these without asking

1. **Never write to R2.** The training loop reads only. Caches go to `.cache/` on local disk. There is no code path in this plan that calls `store.put()`.
2. **Never list the R2 bucket.** File lists come from the manifest, via `warehouse.duck.uris()`. This is both a correctness rule (the scoped token may lose LIST) and a cost rule.
3. **Never modify `supabase/functions/_shared/model.ts`.** You read it to mirror its math in Python. If Python and TypeScript disagree, **TypeScript is correct** and your Python is wrong.
4. **Never modify the `predictions`, `pitches`, `at_bats`, or `games` tables.** This plan writes to exactly two tables: `model_runs` (new) and `model_params` (existing, promotion only).
5. **Never run a promotion with `--force`.** If a gate holds a version, that is the gate working. Record it and move on.
6. **Never delete a cache to "start clean" without saying so.** Rebuilding costs ~50,000 R2 read operations. Deleting `.cache/` is a decision with a bill attached.
7. **Commit after every task.** Each task in this plan ends with a commit. Do not batch them.
8. **Run the tests before claiming a task is done.** Paste the actual output. "Should pass" is not evidence.

### When to stop and ask

Stop at **phase checkpoints only**. Within a phase, resolve ambiguity using the decision rules below and keep going. Outside those rules, if you are genuinely blocked, state the blocker in one sentence, say what you tried, and propose the option you would pick.

### Decision rules — resolve these yourself, do not ask

| Situation | What you do |
|---|---|
| A DuckDB build exceeds 15 minutes | Narrow to seasons 2019+ (`--seasons 2019-2026`), note it in the phase checkpoint, continue. Do **not** cut markets. |
| A fitted model is worse than the active version | Insert it inactive with the reason in `notes`. This is correct behavior, not a failure. |
| Python scorer disagrees with `model.ts` | Fix the Python. TypeScript is the production truth. |
| A market's cell table is empty | Fail loudly with the market name and the SQL. Do not skip the market silently — that is the exact failure mode that froze the previous trainer. |
| `sklearn` warns about convergence | Raise `max_iter` to 5000. If it still warns, record the warning in the run's `notes` field. |
| A test you wrote fails for a reason you did not expect | Use `superpowers:systematic-debugging`. Do not delete or weaken the test to make it pass. |
| You are unsure whether a number is good | Record it. This workbench exists to answer that question empirically, not to prejudge it. |

---

## Global Constraints

- **Python interpreter:** must have `boto3`, `pyarrow`, `duckdb`, `numpy`, `scikit-learn`, `pandas`. Per `docs/plans/data-pipeline-2026-08-02.md`, warehouse work runs on **system Python, not `.venv`** — `.venv` has only pyarrow. Verify in Phase 0 before writing any code.
- **R2 bucket name:** must be `pitch-hawk-warehouse`. The local `.env` has historically contained the typo `pitch-hawk-wa3rehouse`. **The failure mode is silent** — `manifest.load()` returns an empty manifest rather than raising. Verify in Phase 0.
- **Seasons:** corpus spans 2015-04-05 → 2026-08-03, 2,015 days per dataset, 7.9 M pitches / 2.0 M plate appearances / 26.9 K games.
- **Walk-forward test seasons:** 2016–2025 inclusive (**ten** folds). 2015 has no prior season to train on.
- **Holdout season:** 2026. Never used for fitting or selection.
- **Aggregate exclusion:** 2020 (60-game COVID season) is reported per-fold but excluded from the aggregated OOS metric by default, behind a flag.
- **Recency half-lives swept:** `{1, 2, 3, None}` seasons, where `None` means no decay.
- **Form windows swept:** `{"career", "d30", "d90"}`.
- **Leakage rule:** every trailing form window has an **exclusive** upper bound — `interval 1 day preceding`. A window including the current game leaks outcomes into their own features.
- **Gate tolerance:** 2 %, matching the existing convention in `scripts/train_models.py:205`.
- **σ-coverage veto band:** `[0.63, 0.73]` for regression markets.
- **Feature names** must exist in `featureValue()` in `supabase/functions/_shared/model.ts`. A name that does not is scored as zero in production — silently.
- **`params.type` values** must be one of `multinomial_logistic`, `linear`, `remaining_table`, `log5`. `model.ts` branches on these and has no default case.
- **Cache location:** `.cache/` at repo root, gitignored.
- **Test command:** `python -m pytest tests/modeling -v` (pytest config at `pytest.ini`, `testpaths = tests`, `-m "not network"` by default).

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `modeling/__init__.py` | Package marker, version constant |
| `modeling/spec.py` | `MarketSpec` dataclass + `REGISTRY` + lookups |
| `modeling/specs/__init__.py` | Assembles `REGISTRY` from the five market modules |
| `modeling/specs/pitch_result.py` | Multinomial market spec + cell SQL |
| `modeling/specs/ab_result.py` | Multinomial market spec + cell SQL |
| `modeling/specs/pitch_speed_ou.py` | Linear market spec + cell SQL |
| `modeling/specs/ab_pitches_ou.py` | Remaining-table market spec + cell SQL |
| `modeling/specs/game_moneyline.py` | log5 market spec + cell SQL |
| `modeling/features.py` | Form spine + cell builds over DuckDB, local cache, scan stats |
| `modeling/metrics.py` | logloss, brier, ECE, rmse, sigma coverage, calibration bins |
| `modeling/fit.py` | The four model families → `FitResult` |
| `modeling/validate.py` | Walk-forward, holdout, sweeps, selection |
| `modeling/score.py` | Python reference scorer mirroring `model.ts` |
| `modeling/runs.py` | `model_runs` writes |
| `modeling/registry.py` | `model_params` reads/writes, gate, activate/rollback |
| `modeling/cli.py` | `python -m modeling <command>` |
| `modeling/__main__.py` | CLI entry point |
| `supabase/migrations/20260808000001_model_runs.sql` | `model_runs` table |
| `dashboard/pages/2_Models.py` | Models page |
| `tests/modeling/` | Test package for all of the above |
| `tests/fixtures/scorer_golden.json` | Golden parity fixtures, emitted by Deno |
| `supabase/functions/tests/scorer_golden_test.ts` | Emits the golden fixtures |
| `requirements-modeling.txt` | Modeling dependencies |

**Modify:**

| Path | Change |
|---|---|
| `.gitignore` | Add `.cache/` |
| `dashboard/app.py:44` | `CACHE_TTL_SECONDS` 30 → 300 |
| `docs/MODELS.md` | New CLI, OOS gate, `model_runs` |
| `.github/workflows/train-models.yml` | Point at `python -m modeling`, keep `workflow_dispatch`-only |

**Delete:**

| Path | Why |
|---|---|
| `scripts/train_models.py` | Disabled since 2026-08-02; this plan replaces it |
| `scripts/models.py` | Absorbed into `modeling/cli.py` |

**Do not touch:** `backend/models/predictor.py`, `supabase/functions/_shared/model.ts` (read-only), anything under `warehouse/`.

---

# PHASE 0 — Ground truth

**Objective:** Prove the environment works and measure the R2 cost baseline *before* writing code. Every later phase assumes these facts.

**No code is written in this phase.** It exists because two documented, silent failure modes — the wrong interpreter and the mistyped bucket — would otherwise surface as confusing empty results three phases later.

### Task 0.1: Verify interpreter and credentials

- [ ] **Step 1: Find the interpreter that has the dependencies**

```bash
py -c "import boto3, pyarrow, duckdb, numpy, sklearn, pandas; print('all deps ok')"
```

Expected: `all deps ok`

If it fails, try `.venv/Scripts/python.exe -c "..."`. Whichever works is **the interpreter for this entire project** — record it in the checkpoint. If neither works, install into system Python:

```bash
py -m pip install -r requirements-warehouse.txt numpy scikit-learn pandas
```

- [ ] **Step 2: Verify the bucket name is not the known typo**

```bash
py -c "from warehouse.config import r2_config; print('bucket =', r2_config().bucket)"
```

Expected: `bucket = pitch-hawk-warehouse`

If it prints `pitch-hawk-wa3rehouse`, fix `R2_BUCKET` in `.env` before continuing. This misconfiguration does not raise — it returns an empty manifest, and every downstream query silently returns zero rows.

- [ ] **Step 3: Verify the manifest loads and holds the expected corpus**

```bash
py -c "
from warehouse.config import r2_config
from warehouse.store import R2Store
from warehouse import manifest
m = manifest.load(R2Store(r2_config()))
for ds in ('pitches','at_bats','games'):
    print(ds, len(manifest.days(m, ds)), 'days', manifest.total_rows(m, ds), 'rows')
"
```

Expected, approximately: `pitches ~2015 days ~7900000 rows`, `at_bats ~2015 days ~2000000 rows`, `games ~2015 days ~26900 rows`.

**If any dataset reports 0 days, stop.** That is the empty-manifest failure. Do not proceed.

### Task 0.2: Measure the R2 cost baseline

- [ ] **Step 1: Record the pre-build R2 operation counts**

Open the Cloudflare dashboard → R2 → `pitch-hawk-warehouse` → Metrics. Record current month-to-date **Class A** and **Class B** operation counts. Write both numbers into the checkpoint below.

- [ ] **Step 2: Time a single-season scan**

```bash
py -c "
import time
from warehouse.config import r2_config
from warehouse.store import R2Store
from warehouse import duck
store = R2Store(r2_config())
con = duck.connect(store)
uris = duck.uris(store, 'pitches', seasons=[2024])
t = time.time()
n = con.execute('select count(*) from read_parquet(?)', [uris]).fetchone()[0]
print(f'{len(uris)} files, {n} rows, {time.time()-t:.1f}s')
"
```

Expected: roughly 180–190 files, ~700,000 rows, and a wall time you **must record**. Multiply by ~11 to estimate a full-corpus scan.

- [ ] **Step 3: Record the post-scan R2 counts and compute per-file cost**

Read the Cloudflare metrics again. `(Class B after − Class B before) ÷ files scanned` is the real per-file read cost. The design estimated ~10. Record the measured number.

## ✅ CHECKPOINT 0 — stop and report

Report these, with actual values:

| Item | Value |
|---|---|
| Interpreter command | |
| `pitches` / `at_bats` / `games` days + rows | |
| Bucket name verified correct | yes / no |
| One-season scan: files, rows, seconds | |
| Measured Class B per file | |
| Projected full-corpus build (files × measured cost) | |
| Projected build wall time (one season × 11) | |

**Success criteria — all must be true:**
- The interpreter imports all six libraries.
- Bucket is `pitch-hawk-warehouse`.
- All three datasets report >2,000 days and non-zero rows.
- Projected full build is under 10 % of the 10 M monthly Class B allowance.
- Projected build wall time is recorded.

**If projected wall time exceeds 15 minutes:** apply the decision rule — plan to build 2019+ only, and say so in your report.

---

# PHASE 1 — Skeleton and contract

**Objective:** The `MarketSpec` contract and package scaffolding exist and are tested. Nothing touches R2 yet.

### Task 1.1: Package scaffolding and dependencies

**Files:**
- Create: `modeling/__init__.py`, `modeling/__main__.py`, `requirements-modeling.txt`, `tests/modeling/__init__.py`
- Modify: `.gitignore`

**Interfaces:**
- Produces: importable `modeling` package; `.cache/` ignored by git.

- [ ] **Step 1: Create the dependency file**

```
# requirements-modeling.txt
# Offline modeling workbench (modeling/). Superset of requirements-warehouse.txt
# because the cell builds read R2 Parquet through the same DuckDB/manifest path.
-r requirements-warehouse.txt

numpy
scikit-learn
pandas>=2.2
```

- [ ] **Step 2: Create the package files**

```python
# modeling/__init__.py
"""Offline ML workbench: build -> train -> validate -> record -> promote.

Deliberately separate from `backend/`. Nothing here runs in production; the
live scorer is supabase/functions/_shared/model.ts, which reads the params
this package fits and writes to model_params. The one hard contract between
the two is params JSON shape, pinned by tests/modeling/test_parity.py.
"""

__all__ = ["__version__"]
__version__ = "0.1.0"
```

```python
# modeling/__main__.py
"""Entry point: python -m modeling <command>."""

import sys

from modeling.cli import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 3: Add the cache to .gitignore**

Append to `.gitignore`:

```
# Local feature cache for the modeling workbench. Rebuilding costs ~50k R2
# reads, so this is deliberately kept on disk between runs.
.cache/
```

- [ ] **Step 4: Verify the package imports**

```bash
py -c "import modeling; print(modeling.__version__)"
```

Expected: `0.1.0`

- [ ] **Step 5: Commit**

```bash
git add modeling/ requirements-modeling.txt tests/modeling/__init__.py .gitignore
git commit -m "feat(modeling): package skeleton for the offline ML workbench"
```

### Task 1.2: The MarketSpec contract

**Files:**
- Create: `modeling/spec.py`
- Test: `tests/modeling/test_spec.py`

**Interfaces:**
- Produces:
  - `MarketSpec` frozen dataclass with fields `market: str`, `family: str`, `cell_sql: str`, `feature_names: tuple[str, ...]`, `classes: tuple[str, ...] | None`, `primary_metric: str`, `metric_direction: str`, `form_windows: tuple[str, ...]`, `to_params: Callable[[Any, str], dict]`
  - `FAMILIES: frozenset[str]`
  - `get_spec(market: str) -> MarketSpec`
  - `all_markets() -> tuple[str, ...]`

- [ ] **Step 1: Write the failing test**

```python
# tests/modeling/test_spec.py
"""The MarketSpec contract.

These tests exist because a spec with a typo'd family or a feature name that
model.ts does not know about fails *silently in production* -- model.ts has no
default branch on params.type, and featureValue() returns 0 for unknown names.
Catching it here is the whole point.
"""

import pytest

from modeling.spec import FAMILIES, MarketSpec, all_markets, get_spec


def _spec(**over) -> MarketSpec:
    base = dict(
        market="test_market",
        family="multinomial_logistic",
        cell_sql="select 1",
        feature_names=("balls", "strikes"),
        classes=("a", "b"),
        primary_metric="logloss",
        metric_direction="lower",
        form_windows=("career",),
        to_params=lambda fit, window: {},
    )
    base.update(over)
    return MarketSpec(**base)


def test_spec_is_frozen():
    spec = _spec()
    with pytest.raises(Exception):
        spec.market = "changed"


def test_unknown_family_rejected():
    with pytest.raises(ValueError, match="unknown family"):
        _spec(family="random_forest")


def test_known_families_accepted():
    for family in FAMILIES:
        assert _spec(family=family).family == family


def test_classes_required_for_multinomial():
    with pytest.raises(ValueError, match="classes"):
        _spec(family="multinomial_logistic", classes=None)


def test_metric_direction_validated():
    with pytest.raises(ValueError, match="metric_direction"):
        _spec(metric_direction="sideways")


def test_get_spec_unknown_market_lists_valid_ones():
    with pytest.raises(ValueError, match="unknown market"):
        get_spec("not_a_market")


def test_all_five_markets_registered():
    assert set(all_markets()) == {
        "pitch_result", "ab_result", "pitch_speed_ou",
        "ab_pitches_ou", "game_moneyline",
    }
```

- [ ] **Step 2: Run it to verify it fails**

```bash
py -m pytest tests/modeling/test_spec.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'modeling.spec'`

- [ ] **Step 3: Implement the contract**

```python
# modeling/spec.py
"""The MarketSpec contract -- the whole "config not code" surface.

Adding a sixth market is one file in modeling/specs/. The engine
(features/fit/validate) never branches on market name, only on `family`.

Validation here is not ceremony. `family` must match a branch in
supabase/functions/_shared/model.ts, which has no default case, and
`feature_names` must match featureValue() there, which returns 0.0 for names it
does not know. Both failures are silent in production: the app keeps serving,
just with a broken model. So they are caught at construction time instead.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

# Must match the params.type branches in model.ts. Nothing else scores.
FAMILIES = frozenset({
    "multinomial_logistic",
    "linear",
    "remaining_table",
    "log5",
})

_NEEDS_CLASSES = frozenset({"multinomial_logistic"})
_DIRECTIONS = frozenset({"lower", "higher"})


@dataclass(frozen=True)
class MarketSpec:
    """Everything the engine needs to train one market."""

    market: str
    family: str
    cell_sql: str
    feature_names: tuple[str, ...]
    classes: tuple[str, ...] | None
    primary_metric: str
    metric_direction: str
    form_windows: tuple[str, ...]
    to_params: Callable[[Any, str], dict]

    def __post_init__(self) -> None:
        if self.family not in FAMILIES:
            raise ValueError(
                f"unknown family {self.family!r} for market {self.market!r}; "
                f"model.ts scores only {sorted(FAMILIES)}")
        if self.family in _NEEDS_CLASSES and not self.classes:
            raise ValueError(
                f"{self.market!r}: family {self.family!r} requires classes")
        if self.metric_direction not in _DIRECTIONS:
            raise ValueError(
                f"{self.market!r}: metric_direction must be one of "
                f"{sorted(_DIRECTIONS)}, got {self.metric_direction!r}")
        if not self.form_windows:
            raise ValueError(f"{self.market!r}: form_windows must not be empty")


def get_spec(market: str) -> MarketSpec:
    from modeling.specs import REGISTRY
    if market not in REGISTRY:
        raise ValueError(
            f"unknown market {market!r}; expected one of {sorted(REGISTRY)}")
    return REGISTRY[market]


def all_markets() -> tuple[str, ...]:
    from modeling.specs import REGISTRY
    return tuple(sorted(REGISTRY))
```

- [ ] **Step 4: Create a placeholder registry so imports resolve**

```python
# modeling/specs/__init__.py
"""REGISTRY: every market the workbench knows how to train.

One module per market. Phase 2 lands pitch_result; Phase 7 lands the rest.
"""

from __future__ import annotations

from modeling.spec import MarketSpec

REGISTRY: dict[str, MarketSpec] = {}
```

- [ ] **Step 5: Run the tests**

```bash
py -m pytest tests/modeling/test_spec.py -v
```

Expected: all pass except `test_all_five_markets_registered`, which fails because `REGISTRY` is empty. **Mark that one `xfail` with a reason pointing at Phase 7:**

```python
@pytest.mark.xfail(reason="markets land in Phase 2 (pitch_result) and Phase 7 (rest)",
                   strict=False)
def test_all_five_markets_registered():
```

Re-run. Expected: all pass, one xfail.

- [ ] **Step 6: Commit**

```bash
git add modeling/spec.py modeling/specs/__init__.py tests/modeling/test_spec.py
git commit -m "feat(modeling): MarketSpec contract with family and feature validation"
```

## ✅ CHECKPOINT 1

**Success criteria:**
- `py -m pytest tests/modeling -v` passes with one xfail.
- `py -c "from modeling.spec import get_spec"` succeeds.
- `.cache/` is gitignored.
- Two commits exist on the branch.

---

# PHASE 2 — Data layer

**Objective:** One DuckDB pass over R2 produces a leakage-free form spine and a cached cell table for `pitch_result`. This is the phase where cost and correctness are decided.

### Task 2.1: Form spine with the leakage guarantee

**Files:**
- Create: `modeling/features.py`
- Test: `tests/modeling/test_features.py`

**Interfaces:**
- Produces:
  - `cache_root() -> Path` (default `.cache`, override with `PITCHHAWK_CACHE`)
  - `FORM_SPINE_SQL: str`
  - `ScanStats` frozen dataclass — fields `files: int`, `rows: int`, `seconds: float`; computed property `est_class_b: int`
  - `FORM_SPINE_SQL: str` (pitcher grain)
  - `build_form_spine(store, *, seasons=None, con=None) -> tuple[Path, ScanStats]`

- [ ] **Step 1: Write the failing leakage test**

This is the most important test in the plan. It runs against a tiny in-memory DuckDB table, no R2.

```python
# tests/modeling/test_features.py
"""Form-spine correctness, especially the leakage rule.

A trailing window that includes the current game leaks the outcome into its own
feature. The model then looks brilliant offline and is worthless live. The
window bound must be `interval 1 day preceding` -- exclusive of today.
"""

from __future__ import annotations

import duckdb
import pytest

from modeling.features import FORM_SPINE_SQL


@pytest.fixture()
def con():
    c = duckdb.connect()
    c.execute("set enable_progress_bar = false")
    # Three days for one pitcher. Day 3 is a total outlier: if any rolling
    # feature for day 3 reflects day 3, the leak is visible as a changed value.
    c.execute("""
        create table pitches as
        select * from (values
            (1, date '2024-04-01', 1, 100.0),
            (1, date '2024-04-01', 1, 100.0),
            (1, date '2024-04-02', 1, 100.0),
            (1, date '2024-04-02', 1, 100.0),
            (1, date '2024-04-03', 0,   1.0),
            (1, date '2024-04-03', 0,   1.0)
        ) as t(pitcher_id, game_date, in_zone, start_speed)
    """)
    return c


def _spine(con):
    con.execute(f"create table spine as {FORM_SPINE_SQL}")
    return {r[0]: r for r in con.execute(
        "select game_date, career_zone_rate, career_velo, career_n "
        "from spine order by game_date").fetchall()}


def test_first_day_has_no_prior_history(con):
    rows = _spine(con)
    first = rows[__import__("datetime").date(2024, 4, 1)]
    assert first[3] == 0 or first[1] is None, \
        "day 1 must have no prior rows -- there is no history before it"


def test_window_excludes_the_current_day(con):
    rows = _spine(con)
    import datetime
    day3 = rows[datetime.date(2024, 4, 3)]
    # Days 1-2 were all in-zone at 100 mph. Day 3 is 0% in-zone at 1 mph.
    # If day 3 leaked into its own feature these would be pulled toward 0.
    assert day3[1] == pytest.approx(1.0), \
        f"day 3 zone_rate {day3[1]} reflects day 3 -- LEAK"
    assert day3[2] == pytest.approx(100.0), \
        f"day 3 velo {day3[2]} reflects day 3 -- LEAK"
    assert day3[3] == 4, "day 3 should see exactly the 4 prior pitches"


def test_trailing_window_is_bounded(con):
    """d30 must not reach back further than 30 days."""
    con.execute("""
        insert into pitches values
            (1, date '2024-01-01', 0, 1.0),
            (1, date '2024-01-01', 0, 1.0)
    """)
    con.execute(f"create table spine as {FORM_SPINE_SQL}")
    import datetime
    row = con.execute(
        "select d30_n, career_n from spine where game_date = date '2024-04-03'"
    ).fetchone()
    assert row[0] == 4, "d30 must exclude the January rows"
    assert row[1] == 6, "career must include them"
```

- [ ] **Step 2: Run it to verify it fails**

```bash
py -m pytest tests/modeling/test_features.py -v
```

Expected: FAIL — `ImportError: cannot import name 'FORM_SPINE_SQL'`

- [ ] **Step 3: Implement the form spine**

```python
# modeling/features.py
"""Build features from R2 Parquet into locally cached weighted cells.

Two structural decisions, both load-bearing:

1. **Rolling form is computed at (player, day) grain, not per pitch.** Window
   functions over ~1-2M player-days are cheap; over 7.9M pitches they are not.
   The result is identical because form is constant within a day by
   construction.

2. **Cells are weighted aggregates, not rows.** `cell_sql` groups by feature
   buckets and carries count(*) as n; sklearn takes n as sample_weight. For
   bucketed-feature linear and logistic models this is exact, not an
   approximation, and it collapses millions of rows to a few thousand -- which
   is what makes a 600-fit sweep finish in seconds instead of costing 30M R2
   reads.

Nothing here writes to R2. Caches are local. See docs/plans/ml-workbench-2026-08-08.md §9.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

from warehouse import duck

# Class B operations per Parquet file, measured in Phase 0. Used only to report
# an estimate alongside each build -- never to make a decision.
EST_CLASS_B_PER_FILE = 10


def cache_root() -> Path:
    return Path(os.environ.get("PITCHHAWK_CACHE", ".cache"))


@dataclass(frozen=True)
class ScanStats:
    files: int
    rows: int
    seconds: float

    @property
    def est_class_b(self) -> int:
        return self.files * EST_CLASS_B_PER_FILE

    def __str__(self) -> str:
        return (f"{self.files} files, {self.rows:,} rows, {self.seconds:.1f}s, "
                f"~{self.est_class_b:,} Class B ops")


# The leakage rule lives here, in one place, in two window definitions.
#
#   range between ... and interval 1 day preceding
#
# The upper bound is EXCLUSIVE of the current day. A window ending at
# `current row` would include the game being predicted. Do not change these
# bounds without updating tests/modeling/test_features.py, which exists
# specifically to catch that edit.
FORM_SPINE_SQL = """
with daily as (
    select
        pitcher_id,
        game_date,
        count(*)                                              as n,
        avg(case when in_zone = 1 then 1.0 else 0.0 end)      as zone_rate,
        avg(start_speed)                                      as velo
    from pitches
    group by 1, 2
)
select
    pitcher_id,
    game_date,
    coalesce(sum(n) over w_career, 0)                                as career_n,
    sum(zone_rate * n) over w_career / nullif(sum(n) over w_career, 0) as career_zone_rate,
    sum(velo * n)      over w_career / nullif(sum(n) over w_career, 0) as career_velo,
    coalesce(sum(n) over w_d30, 0)                                   as d30_n,
    sum(zone_rate * n) over w_d30 / nullif(sum(n) over w_d30, 0)     as d30_zone_rate,
    sum(velo * n)      over w_d30 / nullif(sum(n) over w_d30, 0)     as d30_velo,
    coalesce(sum(n) over w_d90, 0)                                   as d90_n,
    sum(zone_rate * n) over w_d90 / nullif(sum(n) over w_d90, 0)     as d90_zone_rate,
    sum(velo * n)      over w_d90 / nullif(sum(n) over w_d90, 0)     as d90_velo
from daily
window
    w_career as (partition by pitcher_id order by game_date
                 range between unbounded preceding
                           and interval 1 day preceding),
    w_d30    as (partition by pitcher_id order by game_date
                 range between interval 30 days preceding
                           and interval 1 day preceding),
    w_d90    as (partition by pitcher_id order by game_date
                 range between interval 90 days preceding
                           and interval 1 day preceding)
"""


def build_form_spine(store, *, seasons=None, con=None) -> tuple[Path, ScanStats]:
    """Materialize the (pitcher, day) form spine to local Parquet."""
    own_con = con is None
    con = con or duck.connect(store)
    try:
        uris = duck.uris(store, "pitches", seasons)
        if not uris:
            raise RuntimeError(
                "manifest returned no pitches files -- check R2_BUCKET is "
                "'pitch-hawk-warehouse' (the typo'd value fails silently)")
        t0 = time.time()
        con.execute(
            "create or replace view pitches as "
            "select pitcher_id, game_date, start_speed, "
            "       case when zone between 1 and 9 then 1 else 0 end as in_zone "
            "from read_parquet(?)", [uris])
        con.execute(f"create or replace table form_spine as {FORM_SPINE_SQL}")
        rows = con.execute("select count(*) from form_spine").fetchone()[0]
        out = cache_root() / "form_spine.parquet"
        out.parent.mkdir(parents=True, exist_ok=True)
        con.execute("copy form_spine to ? (format parquet)", [str(out)])
        stats = ScanStats(files=len(uris), rows=rows, seconds=time.time() - t0)
        print(f"[modeling] form_spine: {stats}")
        return out, stats
    finally:
        if own_con:
            con.close()
```

- [ ] **Step 4: Run the tests**

```bash
py -m pytest tests/modeling/test_features.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add modeling/features.py tests/modeling/test_features.py
git commit -m "feat(modeling): leakage-safe (pitcher, day) form spine

Trailing windows are bounded `interval 1 day preceding` -- exclusive of the
game being predicted. tests/modeling/test_features.py exists to catch any
edit that relaxes that bound."
```

### Task 2.2: Cell builder and the pitch_result spec

**Files:**
- Create: `modeling/specs/pitch_result.py`
- Modify: `modeling/features.py` (add `build_cells`, `load_cells`), `modeling/specs/__init__.py`
- Test: `tests/modeling/test_cells.py`

**Interfaces:**
- Consumes: `MarketSpec` (Task 1.2), `build_form_spine` (Task 2.1)
- Produces:
  - `build_cells(store, spec, *, seasons=None, con=None) -> tuple[Path, ScanStats]`
  - `load_cells(spec, seasons=None) -> pandas.DataFrame` with columns `season`, `n`, feature bucket columns per form window, and `outcome`
  - `modeling.specs.pitch_result.SPEC`

- [ ] **Step 1: Write the failing test**

```python
# tests/modeling/test_cells.py
"""Cell tables: the weighted-aggregate contract the fitter depends on."""

from __future__ import annotations

import pandas as pd
import pytest

from modeling.spec import get_spec


def test_pitch_result_spec_registered():
    spec = get_spec("pitch_result")
    assert spec.family == "multinomial_logistic"
    assert spec.classes == ("strike_foul", "ball", "in_play")
    assert set(spec.form_windows) == {"career", "d30", "d90"}


def test_pitch_result_features_match_model_ts():
    """Every feature name must exist in featureValue() in model.ts.

    A name model.ts does not know is scored as 0.0 -- silently. This test reads
    the actual TypeScript so the two cannot drift.
    """
    spec = get_spec("pitch_result")
    ts = open("supabase/functions/_shared/model.ts", encoding="utf-8").read()
    for name in spec.feature_names:
        assert f'"{name}"' in ts or f"'{name}'" in ts, \
            f"feature {name!r} is not handled by featureValue() in model.ts"


def test_cell_sql_emits_all_three_form_windows():
    """The sweep must be a column selection, not a rebuild.

    If cell_sql emitted only one window, changing form_window would cost a
    fresh ~50k-op R2 scan per sweep step.
    """
    spec = get_spec("pitch_result")
    for window in ("career", "d30", "d90"):
        assert f"{window}_zone_bucket" in spec.cell_sql, \
            f"cell_sql must emit {window}_zone_bucket in the single build pass"


def test_cell_sql_groups_and_counts():
    spec = get_spec("pitch_result")
    sql = spec.cell_sql.lower()
    assert "count(*)" in sql and " as n" in sql, \
        "cells must carry count(*) as n -- it becomes sklearn's sample_weight"
    assert "group by" in sql
    assert "season" in sql, "cells must carry season for fold splitting"
```

- [ ] **Step 2: Run it to verify it fails**

```bash
py -m pytest tests/modeling/test_cells.py -v
```

Expected: FAIL — `ValueError: unknown market 'pitch_result'`

- [ ] **Step 3: Write the pitch_result spec**

```python
# modeling/specs/pitch_result.py
"""pitch_result -- P(strike_foul | ball | in_play) for the next pitch.

The richest market: ~7.9M pitches. Multinomial logistic over count state plus
pitcher/batter form deltas, scored by the multinomial_logistic branch of
model.ts.

All three form windows are emitted as separate bucket columns in one build
pass, so the walk-forward sweep over form_window costs no additional R2 reads.

Bucket steps match the v1 trainer (ZONE_STEP=0.03, CHASE_STEP=0.04) so the
delta scale model.ts expects is preserved.
"""

from __future__ import annotations

from modeling.spec import MarketSpec

ZONE_STEP = 0.03
CHASE_STEP = 0.04

# League baselines, subtracted to form deltas. Recomputed per build from the
# same scan, so they cannot drift from the data they normalize.
CELL_SQL = """
with league as (
    select avg(case when in_zone = 1 then 1.0 else 0.0 end) as zone_rate
    from pitches
)
select
    cast(strftime(p.game_date, '%Y') as int)                     as season,
    p.balls,
    p.strikes,
    case when p.is_in_play then 'in_play'
         when p.is_ball    then 'ball'
         else 'strike_foul' end                                  as outcome,
    cast(floor((f.career_zone_rate - l.zone_rate) / {zone_step}) as int)
                                                                 as career_zone_bucket,
    cast(floor((f.d30_zone_rate    - l.zone_rate) / {zone_step}) as int)
                                                                 as d30_zone_bucket,
    cast(floor((f.d90_zone_rate    - l.zone_rate) / {zone_step}) as int)
                                                                 as d90_zone_bucket,
    count(*)                                                     as n
from pitches p
join form_spine f
  on f.pitcher_id = p.pitcher_id and f.game_date = p.game_date
cross join league l
where f.career_n > 0
group by all
""".format(zone_step=ZONE_STEP)


def to_params(fit, form_window: str) -> dict:
    """FitResult -> the params JSON shape model.ts scores."""
    return {
        "type": "multinomial_logistic",
        "classes": list(fit.classes),
        "features": list(fit.feature_names),
        "coef": [[round(v, 6) for v in row] for row in fit.coef],
        "intercept": [round(v, 6) for v in fit.intercept],
        "form_window": form_window,
    }


SPEC = MarketSpec(
    market="pitch_result",
    family="multinomial_logistic",
    cell_sql=CELL_SQL,
    feature_names=("balls", "strikes", "two_strikes", "three_balls",
                   "pitcher_zone_delta", "batter_chase_delta"),
    classes=("strike_foul", "ball", "in_play"),
    primary_metric="logloss",
    metric_direction="lower",
    form_windows=("career", "d30", "d90"),
    to_params=to_params,
)
```

- [ ] **Step 4: Register it**

```python
# modeling/specs/__init__.py
"""REGISTRY: every market the workbench knows how to train.

One module per market. The engine never branches on market name -- only on
MarketSpec.family -- so adding a market is adding a file here.
"""

from __future__ import annotations

from modeling.spec import MarketSpec
from modeling.specs import pitch_result

REGISTRY: dict[str, MarketSpec] = {
    pitch_result.SPEC.market: pitch_result.SPEC,
}
```

- [ ] **Step 5: Add the cell builder and loader to features.py**

Append to `modeling/features.py`:

```python
def cells_path(spec) -> Path:  # noqa: ANN001
    return cache_root() / "cells" / f"{spec.market}.parquet"


def build_cells(store, spec, *, seasons=None, con=None):  # noqa: ANN001
    """Build one market's weighted cell table. Requires form_spine in `con`."""
    own_con = con is None
    con = con or duck.connect(store)
    try:
        uris = duck.uris(store, "pitches", seasons)
        t0 = time.time()
        con.execute(
            "create or replace view pitches as "
            "select pitcher_id, batter_id, game_date, balls, strikes, "
            "       start_speed, is_ball, is_in_play, is_strike, pitch_number, "
            "       case when zone between 1 and 9 then 1 else 0 end as in_zone "
            "from read_parquet(?)", [uris])
        con.execute(f"create or replace table cells as {spec.cell_sql}")
        rows = con.execute("select count(*) from cells").fetchone()[0]
        if rows == 0:
            raise RuntimeError(
                f"{spec.market}: cell table is EMPTY. Refusing to continue -- a "
                f"silent partial train is exactly what froze the v1 trainer. "
                f"Check the SQL and the form_spine join.")
        out = cells_path(spec)
        out.parent.mkdir(parents=True, exist_ok=True)
        con.execute("copy cells to ? (format parquet)", [str(out)])
        stats = ScanStats(files=len(uris), rows=rows, seconds=time.time() - t0)
        print(f"[modeling] cells[{spec.market}]: {stats}")
        return out, stats
    finally:
        if own_con:
            con.close()


def load_cells(spec, seasons=None):  # noqa: ANN001
    """Read a cached cell table. Never touches R2."""
    import duckdb

    path = cells_path(spec)
    if not path.exists():
        raise FileNotFoundError(
            f"no cell cache for {spec.market} at {path}. "
            f"Run: python -m modeling build --market {spec.market}")
    con = duckdb.connect()
    q = "select * from read_parquet(?)"
    args = [str(path)]
    if seasons:
        q += " where season in (" + ",".join(str(int(s)) for s in seasons) + ")"
    return con.execute(q, args).df()
```

- [ ] **Step 6: Run the tests**

```bash
py -m pytest tests/modeling -v
```

Expected: all pass, including `test_all_five_markets_registered` still xfail.

- [ ] **Step 7: Commit**

```bash
git add modeling/ tests/modeling/test_cells.py
git commit -m "feat(modeling): pitch_result cell spec and weighted cell builder

All three form windows are emitted in one pass so the walk-forward sweep is a
column selection, not a fresh R2 scan."
```

### Task 2.3: Run the real build

- [ ] **Step 1: Build the spine and cells against R2**

```bash
py -c "
from warehouse.config import r2_config
from warehouse.store import R2Store
from warehouse import duck
from modeling import features
from modeling.spec import get_spec
store = R2Store(r2_config())
con = duck.connect(store)
features.build_form_spine(store, con=con)
features.build_cells(store, get_spec('pitch_result'), con=con)
"
```

Expected: two `[modeling]` lines with file counts, row counts, wall times.

- [ ] **Step 2: Sanity-check the cells against the manifest**

```bash
py -c "
from modeling import features
from modeling.spec import get_spec
df = features.load_cells(get_spec('pitch_result'))
print('cells:', len(df))
print('pitches represented:', int(df['n'].sum()))
print('seasons:', sorted(df['season'].unique()))
print(df.groupby('outcome')['n'].sum())
"
```

**Success criteria:** `n.sum()` is within ~5 % of the manifest's pitch total (some rows drop on the `career_n > 0` join — a pitcher's debut day has no prior form). Seasons span 2015–2026. All three outcome classes present.

- [ ] **Step 3: Record R2 metrics again and commit nothing** (the cache is gitignored)

## ✅ CHECKPOINT 2 — stop and report

| Item | Value |
|---|---|
| Form spine: files, rows, seconds | |
| Cells: rows, seconds | |
| Pitches represented vs manifest total | |
| Actual Class B consumed by the full build | |
| Cell count (should be thousands, not millions) | |

**Success criteria:**
- `n.sum()` within 5 % of manifest pitch total.
- Cell table has fewer than 100,000 rows (if it has millions, the bucketing is too fine — coarsen the bucket steps and rebuild).
- Leakage tests pass.
- Measured Class B for the full build is under 100,000.

---

# PHASE 3 — Fit and validate

**Objective:** Produce the first honest out-of-sample number for `pitch_result`.

### Task 3.1: Metrics

**Files:**
- Create: `modeling/metrics.py`
- Test: `tests/modeling/test_metrics.py`

**Interfaces:**
- Produces: `logloss(y, p, w) -> float`, `brier(y, p, w) -> float`, `ece(y, p, w, bins=10) -> float`, `rmse(y, yhat, w) -> float`, `sigma_coverage(y, yhat, sigma, w) -> float`, `calibration_bins(y, p, w, bins=10) -> list[dict]`

- [ ] **Step 1: Write the failing tests**

```python
# tests/modeling/test_metrics.py
"""Metrics, verified against hand-computable cases.

Every one of these has a known closed-form answer, so a wrong implementation
cannot hide behind a plausible-looking number.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from modeling.metrics import (brier, calibration_bins, ece, logloss, rmse,
                              sigma_coverage)


def test_logloss_perfect_prediction_is_zero():
    y = np.array([0, 1])
    p = np.array([[1.0, 0.0], [0.0, 1.0]])
    assert logloss(y, p, np.ones(2)) == pytest.approx(0.0, abs=1e-9)


def test_logloss_uniform_two_class_is_ln2():
    y = np.array([0, 1])
    p = np.array([[0.5, 0.5], [0.5, 0.5]])
    assert logloss(y, p, np.ones(2)) == pytest.approx(math.log(2), abs=1e-9)


def test_logloss_respects_weights():
    """A heavily weighted confident-correct row must pull the mean down."""
    y = np.array([0, 0])
    p = np.array([[0.5, 0.5], [1.0, 0.0]])
    unweighted = logloss(y, p, np.array([1.0, 1.0]))
    weighted = logloss(y, p, np.array([1.0, 99.0]))
    assert weighted < unweighted


def test_logloss_clips_zero_probability():
    """A confident wrong answer must be finite, not inf."""
    y = np.array([1])
    p = np.array([[1.0, 0.0]])
    assert math.isfinite(logloss(y, p, np.ones(1)))


def test_brier_perfect_is_zero():
    y = np.array([0, 1])
    p = np.array([[1.0, 0.0], [0.0, 1.0]])
    assert brier(y, p, np.ones(2)) == pytest.approx(0.0, abs=1e-9)


def test_rmse_known_value():
    y = np.array([1.0, 2.0, 3.0])
    yhat = np.array([2.0, 2.0, 2.0])
    # residuals 1, 0, 1 -> mean square 2/3 -> sqrt
    assert rmse(y, yhat, np.ones(3)) == pytest.approx(math.sqrt(2 / 3))


def test_sigma_coverage_normal_is_about_68_percent():
    rng = np.random.default_rng(0)
    y = rng.normal(0.0, 5.0, 20000)
    yhat = np.zeros(20000)
    cov = sigma_coverage(y, yhat, 5.0, np.ones(20000))
    assert 0.66 < cov < 0.70


def test_sigma_coverage_detects_understated_sigma():
    """The failure this metric exists to catch: good RMSE, wrong sigma."""
    rng = np.random.default_rng(0)
    y = rng.normal(0.0, 5.0, 20000)
    cov = sigma_coverage(y, np.zeros(20000), 1.0, np.ones(20000))
    assert cov < 0.30, "an understated sigma must show as low coverage"


def test_ece_perfectly_calibrated_is_near_zero():
    rng = np.random.default_rng(0)
    p1 = rng.uniform(0, 1, 50000)
    y = (rng.uniform(0, 1, 50000) < p1).astype(int)
    p = np.column_stack([1 - p1, p1])
    assert ece(y, p, np.ones(50000)) < 0.02


def test_calibration_bins_shape():
    rng = np.random.default_rng(0)
    p1 = rng.uniform(0, 1, 1000)
    y = (rng.uniform(0, 1, 1000) < p1).astype(int)
    p = np.column_stack([1 - p1, p1])
    bins = calibration_bins(y, p, np.ones(1000), bins=10)
    assert len(bins) == 10
    assert set(bins[0]) == {"bin_lo", "bin_hi", "n", "mean_pred", "observed"}
```

- [ ] **Step 2: Run to verify failure**

```bash
py -m pytest tests/modeling/test_metrics.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'modeling.metrics'`

- [ ] **Step 3: Implement**

```python
# modeling/metrics.py
"""Weighted metrics for cell-based training.

Every function takes `w`, the cell weights (count(*) from the cell table), so
metrics computed on aggregated cells equal metrics computed on the underlying
rows. Dropping the weights would silently make a cell representing 50,000
pitches count the same as one representing 3.

sigma_coverage exists because pitch_speed_ou converts sigma to P(over) through
a normal CDF. A well-fit mean with a mis-scaled sigma has good RMSE and
produces confidently wrong probabilities -- RMSE alone cannot see it.
"""

from __future__ import annotations

import numpy as np

_EPS = 1e-12


def logloss(y: np.ndarray, p: np.ndarray, w: np.ndarray) -> float:
    picked = p[np.arange(len(y)), y]
    return float(-np.average(np.log(np.clip(picked, _EPS, 1.0)), weights=w))


def brier(y: np.ndarray, p: np.ndarray, w: np.ndarray) -> float:
    onehot = np.zeros_like(p)
    onehot[np.arange(len(y)), y] = 1.0
    return float(np.average(((p - onehot) ** 2).sum(axis=1), weights=w))


def rmse(y: np.ndarray, yhat: np.ndarray, w: np.ndarray) -> float:
    return float(np.sqrt(np.average((y - yhat) ** 2, weights=w)))


def sigma_coverage(y: np.ndarray, yhat: np.ndarray, sigma: float,
                   w: np.ndarray) -> float:
    """Fraction of actuals within +/-1 sigma. Should be ~0.68 if sigma is right."""
    inside = (np.abs(y - yhat) <= sigma).astype(float)
    return float(np.average(inside, weights=w))


def calibration_bins(y: np.ndarray, p: np.ndarray, w: np.ndarray,
                     bins: int = 10, positive_class: int = 1) -> list[dict]:
    """Reliability curve for one class: predicted vs observed, per bin."""
    pred = p[:, positive_class]
    hit = (y == positive_class).astype(float)
    edges = np.linspace(0.0, 1.0, bins + 1)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (pred >= lo) & (pred < hi if hi < 1.0 else pred <= hi)
        wm = w[m]
        total = float(wm.sum())
        out.append({
            "bin_lo": round(float(lo), 3),
            "bin_hi": round(float(hi), 3),
            "n": total,
            "mean_pred": round(float(np.average(pred[m], weights=wm)), 5)
                         if total > 0 else None,
            "observed": round(float(np.average(hit[m], weights=wm)), 5)
                        if total > 0 else None,
        })
    return out


def ece(y: np.ndarray, p: np.ndarray, w: np.ndarray, bins: int = 10) -> float:
    """Expected calibration error: weighted mean |predicted - observed|."""
    rows = calibration_bins(y, p, w, bins=bins)
    total = sum(r["n"] for r in rows) or 1.0
    return float(sum(
        r["n"] / total * abs(r["mean_pred"] - r["observed"])
        for r in rows if r["n"] > 0 and r["mean_pred"] is not None))
```

- [ ] **Step 4: Run the tests**

```bash
py -m pytest tests/modeling/test_metrics.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add modeling/metrics.py tests/modeling/test_metrics.py
git commit -m "feat(modeling): weighted metrics with sigma-coverage and calibration"
```

### Task 3.2: The fitter

**Files:**
- Create: `modeling/fit.py`
- Test: `tests/modeling/test_fit.py`

**Interfaces:**
- Consumes: `MarketSpec`, cell DataFrames from `load_cells`
- Produces:
  - `FitResult` frozen dataclass: `family: str`, `coef`, `intercept`, `sigma: float | None`, `table: dict | None`, `classes: tuple | None`, `feature_names: tuple`
  - `decay_weights(seasons, n, half_life) -> np.ndarray`
  - `fit(spec, cells, *, form_window: str, half_life: float | None) -> FitResult`
  - `HALF_LIVES: tuple = (1.0, 2.0, 3.0, None)`

- [ ] **Step 1: Write the failing tests**

```python
# tests/modeling/test_fit.py
"""Fitting, especially the recency-decay weighting."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from modeling.fit import HALF_LIVES, decay_weights, fit
from modeling.spec import get_spec


def test_half_lives_include_no_decay():
    assert None in HALF_LIVES, "the sweep must be able to choose no decay"


def test_decay_none_returns_raw_counts():
    seasons = np.array([2020, 2024])
    n = np.array([10.0, 10.0])
    assert np.allclose(decay_weights(seasons, n, None), n)


def test_decay_halves_at_one_half_life():
    """A season one half-life older gets exactly half the weight."""
    seasons = np.array([2025, 2024])
    n = np.array([100.0, 100.0])
    w = decay_weights(seasons, n, half_life=1.0)
    assert w[0] == pytest.approx(100.0)
    assert w[1] == pytest.approx(50.0)


def test_decay_is_monotonic_in_age():
    seasons = np.array([2026, 2024, 2020, 2015])
    n = np.ones(4) * 100
    w = decay_weights(seasons, n, half_life=2.0)
    assert list(w) == sorted(w, reverse=True)


def test_decay_never_zero():
    """An 11-season-old cell must still contribute something."""
    w = decay_weights(np.array([2015]), np.array([100.0]), half_life=1.0)
    assert w[0] > 0.0


def _cells() -> pd.DataFrame:
    """Synthetic cells where strikes strongly predict strike_foul."""
    rows = []
    for season in (2023, 2024):
        for strikes in (0, 1, 2):
            for outcome, base in (("strike_foul", 30), ("ball", 30),
                                  ("in_play", 20)):
                n = base + (25 * strikes if outcome == "strike_foul" else 0)
                rows.append({"season": season, "balls": 0, "strikes": strikes,
                             "outcome": outcome, "n": float(n),
                             "career_zone_bucket": 0, "d30_zone_bucket": 0,
                             "d90_zone_bucket": 0})
    return pd.DataFrame(rows)


def test_fit_returns_coef_per_class():
    spec = get_spec("pitch_result")
    result = fit(spec, _cells(), form_window="career", half_life=None)
    assert result.family == "multinomial_logistic"
    assert len(result.coef) == len(spec.classes)
    assert len(result.intercept) == len(spec.classes)
    assert len(result.coef[0]) == len(spec.feature_names)


def test_fit_learns_the_planted_signal():
    spec = get_spec("pitch_result")
    result = fit(spec, _cells(), form_window="career", half_life=None)
    strike_class = spec.classes.index("strike_foul")
    strikes_feat = spec.feature_names.index("strikes")
    assert result.coef[strike_class][strikes_feat] > 0, \
        "more strikes should raise P(strike_foul) in the planted data"


def test_fit_rejects_unknown_form_window():
    spec = get_spec("pitch_result")
    with pytest.raises(ValueError, match="form_window"):
        fit(spec, _cells(), form_window="d365", half_life=None)
```

- [ ] **Step 2: Run to verify failure**

```bash
py -m pytest tests/modeling/test_fit.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'modeling.fit'`

- [ ] **Step 3: Implement**

```python
# modeling/fit.py
"""Model families. One function per params.type that model.ts can score.

Recency decay multiplies each cell's weight by 0.5 ** (age_in_seasons /
half_life). It is a sweep dimension, not a constant, because the right value is
an empirical question: the pitch clock and shift ban both landed in 2023, so
how fast pre-2023 baseball should decay is exactly the kind of thing the
walk-forward should answer rather than the author guessing.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# Swept by validate.sweep(). None means no decay -- weight purely by count.
HALF_LIVES: tuple[float | None, ...] = (1.0, 2.0, 3.0, None)


@dataclass(frozen=True)
class FitResult:
    family: str
    feature_names: tuple[str, ...]
    classes: tuple[str, ...] | None = None
    coef: list | None = None
    intercept: list | float | None = None
    sigma: float | None = None
    table: dict | None = None


def decay_weights(seasons: np.ndarray, n: np.ndarray,
                  half_life: float | None) -> np.ndarray:
    """Cell counts scaled by exponential recency decay."""
    if half_life is None:
        return np.asarray(n, dtype=float)
    age = float(np.max(seasons)) - np.asarray(seasons, dtype=float)
    return np.asarray(n, dtype=float) * (0.5 ** (age / float(half_life)))


def _design(spec, cells: pd.DataFrame, form_window: str) -> np.ndarray:  # noqa: ANN001
    """Feature matrix in spec.feature_names order.

    The bucket column for the selected form window is chosen here -- this is
    the entire cost of a form-window sweep step, because build_cells emitted
    all three windows in the single R2 pass.
    """
    if form_window not in spec.form_windows:
        raise ValueError(
            f"unknown form_window {form_window!r}; "
            f"{spec.market} emits {spec.form_windows}")
    zone = cells[f"{form_window}_zone_bucket"].to_numpy(float) * 0.03
    balls = cells["balls"].to_numpy(float)
    strikes = cells["strikes"].to_numpy(float)
    columns = {
        "balls": balls,
        "strikes": strikes,
        "two_strikes": (strikes >= 2).astype(float),
        "three_balls": (balls >= 3).astype(float),
        "pitcher_zone_delta": zone,
        # Batter chase deltas are not in the v1 cell grain; folded into the
        # intercept as zero, exactly as the v1 trainer did for pitcher_bb_delta.
        # Adding them is a spec change, not an engine change.
        "batter_chase_delta": np.zeros(len(cells)),
    }
    missing = [f for f in spec.feature_names if f not in columns]
    if missing:
        raise ValueError(f"{spec.market}: no column built for {missing}")
    return np.column_stack([columns[f] for f in spec.feature_names])


def _fit_multinomial(spec, cells, form_window, half_life) -> FitResult:  # noqa: ANN001
    from sklearn.linear_model import LogisticRegression

    cells = cells[cells["outcome"].isin(spec.classes)]
    X = _design(spec, cells, form_window)
    y = np.array([spec.classes.index(o) for o in cells["outcome"]])
    w = decay_weights(cells["season"].to_numpy(), cells["n"].to_numpy(), half_life)

    clf = LogisticRegression(max_iter=5000, C=10.0)
    clf.fit(X, y, sample_weight=w)

    # sklearn collapses a two-class problem to a single coefficient row.
    # model.ts always expects one row per class, so expand it here.
    coef = np.zeros((len(spec.classes), X.shape[1]))
    intercept = np.zeros(len(spec.classes))
    for i, cls in enumerate(clf.classes_):
        k = int(cls)
        if clf.coef_.shape[0] > 1:
            coef[k], intercept[k] = clf.coef_[i], clf.intercept_[i]
        else:
            sign = 1.0 if k == 1 else -1.0
            coef[k], intercept[k] = sign * clf.coef_[0], sign * clf.intercept_[0]

    return FitResult(
        family="multinomial_logistic",
        feature_names=spec.feature_names,
        classes=spec.classes,
        coef=coef.tolist(),
        intercept=intercept.tolist(),
    )


_FITTERS = {"multinomial_logistic": _fit_multinomial}


def fit(spec, cells: pd.DataFrame, *, form_window: str,  # noqa: ANN001
        half_life: float | None) -> FitResult:
    if len(cells) == 0:
        raise ValueError(
            f"{spec.market}: no cells to fit. This means the season filter "
            f"excluded everything -- check the fold boundaries.")
    if spec.family not in _FITTERS:
        raise NotImplementedError(
            f"no fitter for family {spec.family!r} (market {spec.market!r})")
    return _FITTERS[spec.family](spec, cells, form_window, half_life)
```

- [ ] **Step 4: Run the tests**

```bash
py -m pytest tests/modeling/test_fit.py -v
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add modeling/fit.py tests/modeling/test_fit.py
git commit -m "feat(modeling): multinomial fitter with swept recency decay"
```

### Task 3.3: Walk-forward validation and the sweep

**Files:**
- Create: `modeling/validate.py`
- Test: `tests/modeling/test_validate.py`

**Interfaces:**
- Consumes: `fit`, `FitResult`, `metrics`
- Produces:
  - `WALK_FORWARD_SEASONS: tuple = tuple(range(2016, 2026))`, `HOLDOUT_SEASON = 2026`, `EXCLUDE_FROM_AGGREGATE = (2020,)`
  - `FoldResult`: `test_season: int`, `n_train: float`, `n_test: float`, `metrics: dict`
  - `SweepResult`: `form_window: str`, `half_life: float | None`, `folds: list[FoldResult]`, `oos: dict`
  - `predict(spec, fit_result, cells, form_window) -> np.ndarray`
  - `evaluate(spec, fit_result, cells, form_window) -> dict`
  - `walk_forward(spec, cells, *, form_window, half_life) -> list[FoldResult]`
  - `aggregate(folds, *, exclude=EXCLUDE_FROM_AGGREGATE) -> dict`
  - `sweep(spec, cells) -> list[SweepResult]`
  - `best(results, spec) -> SweepResult`

- [ ] **Step 1: Write the failing tests**

```python
# tests/modeling/test_validate.py
"""Walk-forward mechanics: fold boundaries, holdout isolation, selection."""

from __future__ import annotations

import pandas as pd
import pytest

from modeling.spec import get_spec
from modeling.validate import (EXCLUDE_FROM_AGGREGATE, HOLDOUT_SEASON,
                               WALK_FORWARD_SEASONS, SweepResult, aggregate,
                               best, sweep, walk_forward)


def _cells(seasons=range(2015, 2027)) -> pd.DataFrame:
    rows = []
    for season in seasons:
        for strikes in (0, 1, 2):
            for outcome, base in (("strike_foul", 30), ("ball", 30),
                                  ("in_play", 20)):
                n = base + (25 * strikes if outcome == "strike_foul" else 0)
                rows.append({"season": season, "balls": 0, "strikes": strikes,
                             "outcome": outcome, "n": float(n),
                             "career_zone_bucket": 0, "d30_zone_bucket": 0,
                             "d90_zone_bucket": 0})
    return pd.DataFrame(rows)


def test_ten_walk_forward_folds():
    assert WALK_FORWARD_SEASONS == tuple(range(2016, 2026))
    assert len(WALK_FORWARD_SEASONS) == 10


def test_2015_is_not_a_test_season():
    """2015 has no prior season to train on."""
    assert 2015 not in WALK_FORWARD_SEASONS


def test_holdout_is_never_a_fold():
    assert HOLDOUT_SEASON == 2026
    assert HOLDOUT_SEASON not in WALK_FORWARD_SEASONS


def test_folds_train_only_on_earlier_seasons():
    spec = get_spec("pitch_result")
    folds = walk_forward(spec, _cells(), form_window="career", half_life=None)
    assert [f.test_season for f in folds] == list(WALK_FORWARD_SEASONS)
    # Train weight must grow monotonically as the window expands.
    weights = [f.n_train for f in folds]
    assert weights == sorted(weights)


def test_holdout_rows_never_enter_training():
    """The strongest guarantee in the file: 2026 must not be trained on."""
    spec = get_spec("pitch_result")
    with_2026 = _cells()
    without_2026 = _cells(seasons=range(2015, 2026))
    a = walk_forward(spec, with_2026, form_window="career", half_life=None)
    b = walk_forward(spec, without_2026, form_window="career", half_life=None)
    assert [f.n_train for f in a] == [f.n_train for f in b], \
        "adding 2026 changed a training set -- the holdout is leaking"


def test_aggregate_excludes_2020_by_default():
    assert EXCLUDE_FROM_AGGREGATE == (2020,)
    spec = get_spec("pitch_result")
    folds = walk_forward(spec, _cells(), form_window="career", half_life=None)
    agg = aggregate(folds)
    assert agg["folds_used"] == len(WALK_FORWARD_SEASONS) - 1
    assert 2020 in agg["folds_excluded"]


def test_aggregate_can_include_2020():
    spec = get_spec("pitch_result")
    folds = walk_forward(spec, _cells(), form_window="career", half_life=None)
    assert aggregate(folds, exclude=())["folds_used"] == len(WALK_FORWARD_SEASONS)


def test_sweep_covers_windows_times_half_lives():
    spec = get_spec("pitch_result")
    results = sweep(spec, _cells())
    assert len(results) == len(spec.form_windows) * 4  # 4 half-lives
    assert all(isinstance(r, SweepResult) for r in results)


def test_best_picks_lowest_for_lower_is_better():
    spec = get_spec("pitch_result")
    made = [
        SweepResult("career", None, [], {"logloss": 0.90}),
        SweepResult("d30", 2.0, [], {"logloss": 0.50}),
        SweepResult("d90", 1.0, [], {"logloss": 0.70}),
    ]
    assert best(made, spec).oos["logloss"] == 0.50
```

- [ ] **Step 2: Run to verify failure**

```bash
py -m pytest tests/modeling/test_validate.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'modeling.validate'`

- [ ] **Step 3: Implement**

```python
# modeling/validate.py
"""Walk-forward validation, the frozen holdout, and hyperparameter sweeps.

Replaces the in-sample quality gate in the retired scripts/train_models.py,
which compared training-set log-loss and therefore could not see overfitting at
all.

Three rules, each with a test that fails if it is relaxed:

  * Fold N trains strictly on seasons < N.
  * 2026 is never trained on and never selected on.
  * 2020 (60-game COVID season) is reported but excluded from the aggregate,
    because a fold with ~37% of a normal season's rows distorts the mean by
    both sample size and schedule.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from modeling import metrics as M
from modeling.fit import HALF_LIVES, FitResult, fit

WALK_FORWARD_SEASONS: tuple[int, ...] = tuple(range(2016, 2026))
HOLDOUT_SEASON = 2026
EXCLUDE_FROM_AGGREGATE: tuple[int, ...] = (2020,)


@dataclass(frozen=True)
class FoldResult:
    test_season: int
    n_train: float
    n_test: float
    metrics: dict


@dataclass(frozen=True)
class SweepResult:
    form_window: str
    half_life: float | None
    folds: list[FoldResult] = field(default_factory=list)
    oos: dict = field(default_factory=dict)


def predict(spec, result: FitResult, cells: pd.DataFrame,  # noqa: ANN001
            form_window: str) -> np.ndarray:
    from modeling.fit import _design

    X = _design(spec, cells, form_window)
    logits = X @ np.asarray(result.coef).T + np.asarray(result.intercept)
    logits -= logits.max(axis=1, keepdims=True)
    exp = np.exp(logits)
    return exp / exp.sum(axis=1, keepdims=True)


def evaluate(spec, result: FitResult, cells: pd.DataFrame,  # noqa: ANN001
             form_window: str) -> dict:
    cells = cells[cells["outcome"].isin(spec.classes)]
    p = predict(spec, result, cells, form_window)
    y = np.array([spec.classes.index(o) for o in cells["outcome"]])
    w = cells["n"].to_numpy(float)
    return {
        "logloss": round(M.logloss(y, p, w), 6),
        "brier": round(M.brier(y, p, w), 6),
        "ece": round(M.ece(y, p, w), 6),
        "n": float(w.sum()),
    }


def walk_forward(spec, cells: pd.DataFrame, *, form_window: str,  # noqa: ANN001
                 half_life: float | None) -> list[FoldResult]:
    out: list[FoldResult] = []
    for season in WALK_FORWARD_SEASONS:
        train = cells[cells["season"] < season]
        test = cells[cells["season"] == season]
        if len(train) == 0 or len(test) == 0:
            continue
        result = fit(spec, train, form_window=form_window, half_life=half_life)
        out.append(FoldResult(
            test_season=season,
            n_train=float(train["n"].sum()),
            n_test=float(test["n"].sum()),
            metrics=evaluate(spec, result, test, form_window),
        ))
    return out


def aggregate(folds: list[FoldResult], *,
              exclude: tuple[int, ...] = EXCLUDE_FROM_AGGREGATE) -> dict:
    used = [f for f in folds if f.test_season not in exclude]
    if not used:
        return {"folds_used": 0, "folds_excluded": list(exclude)}
    keys = [k for k in used[0].metrics if k != "n"]
    weights = np.array([f.metrics["n"] for f in used], dtype=float)
    out = {k: round(float(np.average(
        [f.metrics[k] for f in used], weights=weights)), 6) for k in keys}
    out["folds_used"] = len(used)
    out["folds_excluded"] = [f.test_season for f in folds
                             if f.test_season in exclude]
    out["n"] = float(weights.sum())
    return out


def sweep(spec, cells: pd.DataFrame) -> list[SweepResult]:  # noqa: ANN001
    """Every (form_window, half_life) pair. Pure compute on cached cells."""
    results: list[SweepResult] = []
    for window in spec.form_windows:
        for half_life in HALF_LIVES:
            folds = walk_forward(spec, cells, form_window=window,
                                 half_life=half_life)
            results.append(SweepResult(window, half_life, folds,
                                       aggregate(folds)))
            print(f"[modeling] {spec.market} window={window} "
                  f"half_life={half_life} -> {aggregate(folds)}")
    return results


def best(results: list[SweepResult], spec) -> SweepResult:  # noqa: ANN001
    key = spec.primary_metric
    reverse = spec.metric_direction == "higher"
    ranked = sorted((r for r in results if key in r.oos),
                    key=lambda r: r.oos[key], reverse=reverse)
    if not ranked:
        raise ValueError(
            f"{spec.market}: no sweep result carried metric {key!r}")
    return ranked[0]
```

- [ ] **Step 4: Run the tests**

```bash
py -m pytest tests/modeling/test_validate.py -v
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add modeling/validate.py tests/modeling/test_validate.py
git commit -m "feat(modeling): walk-forward validation, frozen holdout, sweep

Replaces the in-sample gate: fold N trains strictly on seasons < N, 2026 is
never trained or selected on, 2020 is reported but excluded from aggregates."
```

### Task 3.4: The first real out-of-sample number

- [ ] **Step 1: Run the full sweep on real cells**

```bash
py -c "
from modeling import features, validate
from modeling.spec import get_spec
spec = get_spec('pitch_result')
cells = features.load_cells(spec)
results = validate.sweep(spec, cells)
winner = validate.best(results, spec)
print()
print('BEST:', winner.form_window, 'half_life=', winner.half_life)
print('OOS :', winner.oos)
for f in winner.folds:
    print(f'  {f.test_season}: logloss={f.metrics[\"logloss\"]:.5f} n={f.metrics[\"n\"]:,.0f}')
"
```

- [ ] **Step 2: Sanity-check the numbers**

A three-class model predicting uniformly scores `ln(3) ≈ 1.0986`. Your OOS log-loss **must be below that** — if it is not, the model is worse than guessing and something is wrong with the design matrix.

## ✅ CHECKPOINT 3 — stop and report

| Item | Value |
|---|---|
| Best form window | |
| Best half-life | |
| Aggregated OOS log-loss | |
| OOS log-loss vs `ln(3)` = 1.0986 baseline | |
| Per-fold log-loss, all ten seasons | |
| Sweep wall time | |

**Success criteria:**
- All 12 sweep combinations completed.
- OOS log-loss < 1.0986.
- Per-fold numbers show no wild outlier outside 2020.
- `py -m pytest tests/modeling -v` fully passes.

**This is the Day 1 deliverable.** The loop `build → train → validate` works end to end on real data.

---

# PHASE 4 — Parity

**Objective:** Prove the Python scorer and `model.ts` compute the same thing, so offline numbers describe production behavior.

### Task 4.1: Golden fixtures from TypeScript

**Files:**
- Create: `supabase/functions/tests/scorer_golden_test.ts`, `tests/fixtures/scorer_golden.json`

- [ ] **Step 1: Read the scorer before mirroring it**

```bash
py -c "print(open('supabase/functions/_shared/model.ts', encoding='utf-8').read())"
```

Note exactly: how `featureValue()` maps names to numbers, the softmax formulation, and the normal-CDF approximation used for `linear`. **Your Python must match the CDF approximation, not use `scipy.stats.norm`** — a different approximation is a different number.

- [ ] **Step 2: Write the fixture emitter**

```typescript
// supabase/functions/tests/scorer_golden_test.ts
// Emits tests/fixtures/scorer_golden.json -- the contract between model.ts and
// modeling/score.py. Regenerate whenever model.ts scoring changes:
//   deno test --allow-write supabase/functions/tests/scorer_golden_test.ts
//
// tests/modeling/test_parity.py asserts the Python reference scorer matches
// these outputs to 1e-9. Editing model.ts without regenerating turns CI red,
// which is the point.

import { predictPitchResult } from "../_shared/model.ts";

const params = {
  type: "multinomial_logistic",
  classes: ["strike_foul", "ball", "in_play"],
  features: ["balls", "strikes", "two_strikes", "three_balls",
             "pitcher_zone_delta", "batter_chase_delta"],
  coef: [
    [0.10, 0.35, 0.20, -0.05, 0.80, -0.10],
    [-0.20, -0.30, -0.15, 0.40, -0.60, 0.05],
    [0.05, -0.02, -0.03, -0.01, 0.10, 0.15],
  ],
  intercept: [0.15, -0.10, -0.05],
};

const cases = [];
for (const balls of [0, 1, 2, 3]) {
  for (const strikes of [0, 1, 2]) {
    for (const zone of [-0.06, 0.0, 0.06]) {
      const ctx = { balls, strikes, pitcher_zone_delta: zone,
                    batter_chase_delta: 0.0 };
      cases.push({ params, context: ctx, expected: predictPitchResult(ctx, params) });
    }
  }
}

Deno.test("emit golden fixtures", () => {
  Deno.writeTextFileSync("tests/fixtures/scorer_golden.json",
    JSON.stringify({ generated_by: "scorer_golden_test.ts", cases }, null, 2));
});
```

- [ ] **Step 3: Generate the fixtures**

```bash
deno test --allow-write --allow-read supabase/functions/tests/scorer_golden_test.ts
```

Expected: `tests/fixtures/scorer_golden.json` exists with 36 cases.

**If `predictPitchResult` is not exported from `model.ts`:** add only an `export` keyword to the existing declaration. That is the sole permitted edit to that file — do not change any logic.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/tests/scorer_golden_test.ts tests/fixtures/scorer_golden.json
git commit -m "test(modeling): golden scorer fixtures emitted from model.ts"
```

### Task 4.2: Python reference scorer

**Files:**
- Create: `modeling/score.py`
- Test: `tests/modeling/test_parity.py`

**Interfaces:**
- Produces: `score(params: dict, context: dict[str, float]) -> dict | float`, `feature_value(name: str, context: dict) -> float`

- [ ] **Step 1: Write the failing parity test**

```python
# tests/modeling/test_parity.py
"""Python scorer == model.ts scorer.

Without this, "validated offline" and "computed in production" are two
unverified claims. If this fails, THE PYTHON IS WRONG -- model.ts is what
actually serves users.

Regenerate fixtures after any model.ts scoring change:
    deno test --allow-write supabase/functions/tests/scorer_golden_test.ts
"""

from __future__ import annotations

import json
import pathlib

import pytest

from modeling.score import score

GOLDEN = pathlib.Path("tests/fixtures/scorer_golden.json")


def _cases():
    if not GOLDEN.exists():
        pytest.skip(f"{GOLDEN} missing -- run the Deno emitter (Task 4.1)")
    return json.loads(GOLDEN.read_text())["cases"]


def test_fixtures_exist_and_are_populated():
    assert len(_cases()) >= 36


@pytest.mark.parametrize("i", range(36))
def test_python_matches_typescript(i):
    case = _cases()[i]
    got = score(case["params"], case["context"])
    for key, expected in case["expected"].items():
        assert got[key] == pytest.approx(expected, abs=1e-9), (
            f"case {i} key {key}: python={got[key]} typescript={expected}. "
            f"model.ts is correct -- fix modeling/score.py.")


def test_probabilities_sum_to_one():
    for case in _cases():
        got = score(case["params"], case["context"])
        assert sum(got.values()) == pytest.approx(1.0, abs=1e-9)
```

- [ ] **Step 2: Run to verify failure**

```bash
py -m pytest tests/modeling/test_parity.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'modeling.score'`

- [ ] **Step 3: Implement, mirroring model.ts exactly**

```python
# modeling/score.py
"""Python mirror of supabase/functions/_shared/model.ts.

This file exists so offline validation measures what production computes. It is
a MIRROR, not an improvement: where this and model.ts disagree, model.ts is
right and this is a bug. Do not "fix" a difference by changing the TypeScript.

Pinned by tests/modeling/test_parity.py against golden fixtures the TypeScript
itself emits.
"""

from __future__ import annotations

import math


def feature_value(name: str, ctx: dict) -> float:
    """Mirror of featureValue() in model.ts.

    Unknown names return 0.0 -- matching the TypeScript, which is why
    MarketSpec validates feature names at construction time instead.
    """
    balls = float(ctx.get("balls", 0))
    strikes = float(ctx.get("strikes", 0))
    table = {
        "balls": balls,
        "strikes": strikes,
        "two_strikes": 1.0 if strikes >= 2 else 0.0,
        "three_balls": 1.0 if balls >= 3 else 0.0,
        "pitcher_zone_delta": float(ctx.get("pitcher_zone_delta", 0.0)),
        "batter_chase_delta": float(ctx.get("batter_chase_delta", 0.0)),
        "pitcher_velo": float(ctx.get("pitcher_velo", 0.0)),
        "pitch_of_pa": float(ctx.get("pitch_of_pa", 0.0)),
        "pitcher_k_delta": float(ctx.get("pitcher_k_delta", 0.0)),
        "pitcher_bb_delta": float(ctx.get("pitcher_bb_delta", 0.0)),
        "batter_k_delta": float(ctx.get("batter_k_delta", 0.0)),
        "platoon_same": float(ctx.get("platoon_same", 0.0)),
    }
    return table.get(name, 0.0)


def _softmax(logits: list[float]) -> list[float]:
    top = max(logits)
    exps = [math.exp(v - top) for v in logits]
    total = sum(exps)
    return [v / total for v in exps]


def _multinomial(params: dict, ctx: dict) -> dict:
    features = params["features"]
    values = [feature_value(f, ctx) for f in features]
    logits = [
        params["intercept"][k] + sum(c * v for c, v in zip(row, values))
        for k, row in enumerate(params["coef"])
    ]
    return dict(zip(params["classes"], _softmax(logits)))


def score(params: dict, ctx: dict):
    kind = params.get("type")
    if kind == "multinomial_logistic":
        return _multinomial(params, ctx)
    raise NotImplementedError(
        f"no reference scorer for params.type={kind!r}. model.ts has no "
        f"default branch either -- an unknown type is a silent production bug.")
```

- [ ] **Step 4: Run the parity tests**

```bash
py -m pytest tests/modeling/test_parity.py -v
```

Expected: 38 passed.

**If any case fails:** the difference is in your Python. Compare the softmax normalization and the feature ordering against `model.ts` line by line.

- [ ] **Step 5: Commit**

```bash
git add modeling/score.py tests/modeling/test_parity.py
git commit -m "test(modeling): pin the Python reference scorer to model.ts at 1e-9"
```

## ✅ CHECKPOINT 4

**Success criteria:**
- `tests/fixtures/scorer_golden.json` has ≥36 cases.
- All parity tests pass at 1e-9.
- `model.ts` diff is empty or a single added `export` keyword — verify with `git diff supabase/functions/_shared/model.ts`.

---

# PHASE 5 — Record

**Objective:** Every run is durably recorded, promoted or not.

### Task 5.1: The model_runs table

**Files:**
- Create: `supabase/migrations/20260808000001_model_runs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- model_runs: every training run, promoted or not.
--
-- Deliberately separate from model_params. model_params answers "what is live";
-- this answers "what was tried, and why was this the one". The rejected runs
-- are half the record -- a registry that only holds winners cannot show that a
-- version was chosen rather than merely produced.
--
-- Sized in kilobytes per row: metrics and fold summaries only, never per-row
-- predictions. The database is on a 500 MB ceiling.

create table if not exists model_runs (
    id               bigserial primary key,
    run_id           text not null unique,
    market           text not null,
    spec_hash        text not null,
    git_sha          text,
    data_through     date,
    train_seasons    int[],
    config           jsonb not null default '{}'::jsonb,
    folds            jsonb not null default '[]'::jsonb,
    oos_metrics      jsonb not null default '{}'::jsonb,
    holdout_metrics  jsonb,
    calibration      jsonb,
    params           jsonb,
    version          text,
    status           text not null default 'completed',
    notes            text,
    created_at       timestamptz not null default now(),
    constraint model_runs_status_check
        check (status in ('completed', 'failed', 'promoted'))
);

create index if not exists model_runs_market_created_idx
    on model_runs (market, created_at desc);
create index if not exists model_runs_version_idx
    on model_runs (market, version) where version is not null;

alter table model_runs enable row level security;

-- Read-only to the dashboard's anon key; writes require the service role.
drop policy if exists model_runs_read on model_runs;
create policy model_runs_read on model_runs for select using (true);
```

- [ ] **Step 2: Apply it**

Apply via the Supabase SQL editor or MCP `apply_migration`.

- [ ] **Step 3: Verify the table exists**

```bash
py -c "
from backend.db.client import get_client
rows = get_client().table('model_runs').select('run_id').limit(1).execute().data
print('model_runs reachable, rows:', len(rows))
"
```

Expected: `model_runs reachable, rows: 0`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260808000001_model_runs.sql
git commit -m "feat(db): model_runs -- durable record of every training run"
```

### Task 5.2: Run recording

**Files:**
- Create: `modeling/runs.py`
- Test: `tests/modeling/test_runs.py`

**Interfaces:**
- Produces: `new_run_id() -> str`, `spec_hash(spec) -> str`, `git_sha() -> str | None`, `build_run(spec, sweep_result, *, holdout, calibration, params, status, notes="", version=None) -> dict`, `record(run: dict) -> str`

- [ ] **Step 1: Write the failing test**

```python
# tests/modeling/test_runs.py
"""Run records. build_run is pure -- record() is the only DB call."""

from __future__ import annotations

from modeling.runs import build_run, new_run_id, spec_hash
from modeling.spec import get_spec
from modeling.validate import FoldResult, SweepResult


def test_run_ids_are_unique():
    assert len({new_run_id() for _ in range(100)}) == 100


def test_spec_hash_is_stable():
    spec = get_spec("pitch_result")
    assert spec_hash(spec) == spec_hash(spec)


def test_spec_hash_changes_with_sql():
    """Silent spec drift must be detectable across runs."""
    import dataclasses
    spec = get_spec("pitch_result")
    other = dataclasses.replace(spec, cell_sql=spec.cell_sql + " -- edited")
    assert spec_hash(spec) != spec_hash(other)


def _sweep() -> SweepResult:
    folds = [FoldResult(2024, 100.0, 10.0, {"logloss": 0.9, "n": 10.0})]
    return SweepResult("d30", 2.0, folds, {"logloss": 0.9, "folds_used": 1})


def test_build_run_captures_the_sweep_config():
    spec = get_spec("pitch_result")
    run = build_run(spec, _sweep(), holdout={"logloss": 0.95},
                    calibration=[], params={"type": "multinomial_logistic"},
                    status="completed", notes="unit test")
    assert run["market"] == "pitch_result"
    assert run["config"]["form_window"] == "d30"
    assert run["config"]["half_life"] == 2.0
    assert run["oos_metrics"]["logloss"] == 0.9
    assert run["holdout_metrics"]["logloss"] == 0.95
    assert run["status"] == "completed"
    assert len(run["folds"]) == 1


def test_build_run_records_failures_too():
    spec = get_spec("pitch_result")
    run = build_run(spec, _sweep(), holdout=None, calibration=None,
                    params=None, status="failed", notes="held by gate")
    assert run["status"] == "failed"
    assert run["notes"] == "held by gate"
```

- [ ] **Step 2: Run to verify failure**

```bash
py -m pytest tests/modeling/test_runs.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'modeling.runs'`

- [ ] **Step 3: Implement**

```python
# modeling/runs.py
"""Write training runs to model_runs.

build_run() is pure so it can be unit-tested without a database; record() is
the only function here that touches Supabase.

spec_hash exists to catch silent spec drift: two runs with the same market and
different hashes were not measuring the same thing, and comparing their metrics
is meaningless.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import subprocess
import uuid
from datetime import datetime, timezone

from modeling.validate import HOLDOUT_SEASON, WALK_FORWARD_SEASONS


def new_run_id() -> str:
    return f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S}-{uuid.uuid4().hex[:8]}"


def spec_hash(spec) -> str:  # noqa: ANN001
    payload = json.dumps({
        "market": spec.market,
        "family": spec.family,
        "cell_sql": spec.cell_sql,
        "features": list(spec.feature_names),
        "classes": list(spec.classes or ()),
        "form_windows": list(spec.form_windows),
    }, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def git_sha() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return None


def build_run(spec, sweep_result, *, holdout, calibration,  # noqa: ANN001
              params, status: str, notes: str = "",
              version: str | None = None) -> dict:
    return {
        "run_id": new_run_id(),
        "market": spec.market,
        "spec_hash": spec_hash(spec),
        "git_sha": git_sha(),
        "data_through": f"{HOLDOUT_SEASON}-12-31",
        "train_seasons": list(WALK_FORWARD_SEASONS),
        "config": {
            "form_window": sweep_result.form_window,
            "half_life": sweep_result.half_life,
            "family": spec.family,
            "primary_metric": spec.primary_metric,
        },
        "folds": [dataclasses.asdict(f) for f in sweep_result.folds],
        "oos_metrics": sweep_result.oos,
        "holdout_metrics": holdout,
        "calibration": calibration,
        "params": params,
        "version": version,
        "status": status,
        "notes": notes,
    }


def record(run: dict) -> str:
    """Insert one run. Returns its run_id."""
    from backend.db.client import get_client

    get_client().table("model_runs").insert(run).execute()
    print(f"[modeling] recorded run {run['run_id']} "
          f"({run['market']}, {run['status']})")
    return run["run_id"]
```

- [ ] **Step 4: Run the tests**

```bash
py -m pytest tests/modeling/test_runs.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add modeling/runs.py tests/modeling/test_runs.py
git commit -m "feat(modeling): record every run to model_runs, promoted or not"
```

## ✅ CHECKPOINT 5

**Success criteria:**
- `model_runs` exists and is queryable.
- `py -m pytest tests/modeling -v` fully passes.
- `build_run` is unit-tested with no database.

---

# PHASE 6 — Promote

**Objective:** A gated path from a validated run to a live model version, with the existing atomic RPCs.

### Task 6.1: Registry and the out-of-sample gate

**Files:**
- Create: `modeling/registry.py`
- Test: `tests/modeling/test_registry.py`

**Interfaces:**
- Produces: `GATE_TOLERANCE = 0.02`, `SIGMA_BAND = (0.63, 0.73)`, `gate(spec, new_oos, active_oos) -> tuple[bool, str]`, `active(market) -> dict | None`, `insert_version(...) -> None`, `activate(market, version) -> None`, `rollback(market) -> None`, `make_version() -> str`

- [ ] **Step 1: Write the failing tests**

```python
# tests/modeling/test_registry.py
"""The promotion gate. Pure logic -- no database in these tests."""

from __future__ import annotations

import dataclasses

import pytest

from modeling.registry import GATE_TOLERANCE, SIGMA_BAND, gate, make_version
from modeling.spec import get_spec


def test_gate_tolerance_matches_prior_convention():
    assert GATE_TOLERANCE == 0.02


def test_no_baseline_promotes():
    spec = get_spec("pitch_result")
    ok, reason = gate(spec, {"logloss": 0.9}, None)
    assert ok and "no active baseline" in reason


def test_clear_improvement_promotes():
    spec = get_spec("pitch_result")
    ok, _ = gate(spec, {"logloss": 0.80}, {"logloss": 0.90})
    assert ok


def test_within_tolerance_promotes():
    """1% worse is inside the 2% band."""
    spec = get_spec("pitch_result")
    ok, _ = gate(spec, {"logloss": 0.909}, {"logloss": 0.90})
    assert ok


def test_beyond_tolerance_is_held():
    spec = get_spec("pitch_result")
    ok, reason = gate(spec, {"logloss": 0.95}, {"logloss": 0.90})
    assert not ok and "HELD" in reason


def test_missing_new_metric_is_held():
    """Never promote something you could not measure."""
    spec = get_spec("pitch_result")
    ok, reason = gate(spec, {}, {"logloss": 0.90})
    assert not ok and "HELD" in reason


def test_sigma_veto_blocks_despite_good_rmse():
    """The regression failure mode: good RMSE, mis-scaled sigma."""
    spec = dataclasses.replace(get_spec("pitch_result"),
                               market="pitch_speed_ou", family="linear",
                               classes=None, primary_metric="rmse")
    ok, reason = gate(spec, {"rmse": 4.0, "sigma_coverage": 0.30},
                      {"rmse": 5.0, "sigma_coverage": 0.68})
    assert not ok and "sigma" in reason.lower()


def test_sigma_inside_band_allows_promotion():
    spec = dataclasses.replace(get_spec("pitch_result"),
                               market="pitch_speed_ou", family="linear",
                               classes=None, primary_metric="rmse")
    ok, _ = gate(spec, {"rmse": 4.0, "sigma_coverage": 0.68},
                 {"rmse": 5.0, "sigma_coverage": 0.68})
    assert ok


def test_sigma_band_is_centred_on_normal():
    assert SIGMA_BAND[0] < 0.6827 < SIGMA_BAND[1]


def test_version_format():
    v = make_version()
    assert v.startswith("v2_") and len(v) == len("v2_20260808")
```

- [ ] **Step 2: Run to verify failure**

```bash
py -m pytest tests/modeling/test_registry.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'modeling.registry'`

- [ ] **Step 3: Implement**

```python
# modeling/registry.py
"""model_params reads/writes and the promotion gate.

The gate compares OUT-OF-SAMPLE walk-forward metrics. The retired trainer
compared in-sample training loss, which cannot detect overfitting -- a version
that memorized its training cells looked strictly better and would promote.

Activation goes through the existing activate_model()/rollback_model() RPCs,
which are SECURITY DEFINER and atomic. Never flip is_active with an UPDATE:
the partial unique index permits exactly one active row per market, and a
two-statement swap can transiently violate it.
"""

from __future__ import annotations

from datetime import datetime, timezone

GATE_TOLERANCE = 0.02
SIGMA_BAND = (0.63, 0.73)


def make_version() -> str:
    return "v2_" + datetime.now(timezone.utc).strftime("%Y%m%d")


def gate(spec, new_oos: dict, active_oos: dict | None) -> tuple[bool, str]:  # noqa: ANN001
    """Decide promotion from out-of-sample metrics. Returns (promote, reason)."""
    key = spec.primary_metric
    new = new_oos.get(key)
    if new is None:
        return False, f"HELD: new run has no {key} -- cannot compare"

    # Regression veto: a mis-scaled sigma produces confidently wrong
    # probabilities while RMSE looks fine.
    if spec.family == "linear":
        cov = new_oos.get("sigma_coverage")
        if cov is None:
            return False, "HELD: linear model has no sigma_coverage"
        if not (SIGMA_BAND[0] <= cov <= SIGMA_BAND[1]):
            return False, (f"HELD: sigma_coverage {cov} outside "
                           f"{SIGMA_BAND} -- sigma is mis-scaled")

    if not active_oos or active_oos.get(key) is None:
        return True, f"no active baseline ({key}={new})"

    old = active_oos[key]
    worse = (new > old * (1 + GATE_TOLERANCE)
             if spec.metric_direction == "lower"
             else new < old * (1 - GATE_TOLERANCE))
    if worse:
        return False, (f"HELD: {key} {new} worse than active {old} "
                       f"by more than {GATE_TOLERANCE:.0%}")
    return True, f"{key} {new} vs active {old}"


def active(market: str) -> dict | None:
    from backend.db.client import get_client

    rows = (get_client().table("model_params")
            .select("version, params, metrics, activated_at")
            .eq("market", market).eq("is_active", True).limit(1)
            .execute().data)
    return rows[0] if rows else None


def active_oos(market: str) -> dict | None:
    """Out-of-sample metrics for the live version, from its baseline run."""
    from backend.db.client import get_client

    row = active(market)
    if not row:
        return None
    runs = (get_client().table("model_runs")
            .select("oos_metrics")
            .eq("market", market).eq("version", row["version"])
            .order("created_at", desc=True).limit(1)
            .execute().data)
    return runs[0]["oos_metrics"] if runs else None


def insert_version(market: str, version: str, params: dict, metrics: dict,
                   *, notes: str) -> None:
    """Insert inactive. Activation is always a separate, explicit step."""
    from backend.db.client import get_client

    get_client().table("model_params").upsert({
        "market": market, "version": version, "params": params,
        "metrics": metrics, "training_rows": int(metrics.get("n") or 0),
        "is_active": False, "notes": notes,
    }, on_conflict="market,version").execute()
    print(f"[modeling] inserted {market} {version} (inactive): {notes}")


def activate(market: str, version: str) -> None:
    from backend.db.client import get_client

    get_client().rpc("activate_model",
                     {"p_market": market, "p_version": version}).execute()
    print(f"[modeling] ACTIVATED {market} {version}")


def rollback(market: str) -> None:
    from backend.db.client import get_client

    get_client().rpc("rollback_model", {"p_market": market}).execute()
    print(f"[modeling] rolled back {market}")
```

- [ ] **Step 4: Run the tests**

```bash
py -m pytest tests/modeling/test_registry.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add modeling/registry.py tests/modeling/test_registry.py
git commit -m "feat(modeling): out-of-sample promotion gate with sigma veto"
```

### Task 6.2: The CLI

**Files:**
- Create: `modeling/cli.py`
- Test: `tests/modeling/test_cli.py`

**Interfaces:**
- Produces: `build_parser() -> argparse.ArgumentParser`, `main(argv) -> int`
- Commands: `build`, `train`, `sweep`, `baseline`, `list`, `show`, `status`, `activate`, `rollback`

- [ ] **Step 1: Write the failing test**

```python
# tests/modeling/test_cli.py
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
```

- [ ] **Step 2: Run to verify failure**

```bash
py -m pytest tests/modeling/test_cli.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'modeling.cli'`

- [ ] **Step 3: Implement**

```python
# modeling/cli.py
"""python -m modeling <command> -- the whole workbench loop.

    build     pull features from R2 into the local cell cache (the only
              command that touches R2)
    sweep     walk-forward over every (form_window, half_life), print results
    train     sweep, pick the best, evaluate on the 2026 holdout, record the
              run; --promote also gates and activates
    baseline  score the currently-active params through the same walk-forward
              harness so the gate has a comparable number
    list/show/status/activate/rollback   registry operations

There is deliberately no --force. The gate holding a version is the gate
working; overriding it is a decision that belongs in a human's hands via an
explicit `activate`.
"""

from __future__ import annotations

import argparse
import json

from modeling import features, registry, runs, validate
from modeling.spec import all_markets, get_spec


def _store():
    from warehouse.config import r2_config
    from warehouse.store import R2Store
    return R2Store(r2_config())


def _seasons(arg: str | None):
    if not arg:
        return None
    lo, _, hi = arg.partition("-")
    return list(range(int(lo), int(hi or lo) + 1))


def cmd_build(args) -> int:
    from warehouse import duck

    store = _store()
    con = duck.connect(store)
    seasons = _seasons(args.seasons)
    # Both spines: pitch-grain markets join form_spine, plate-appearance-grain
    # markets join form_spine_ab. Building both here keeps `build` a single
    # R2 pass -- the cost rule in the plan header.
    features.build_form_spine(store, seasons=seasons, con=con)
    features.build_form_spine_ab(store, seasons=seasons, con=con)
    markets = [args.market] if args.market else list(all_markets())
    for market in markets:
        features.build_cells(store, get_spec(market), seasons=seasons, con=con)
    return 0


def cmd_sweep(args) -> int:
    spec = get_spec(args.market)
    validate.sweep(spec, features.load_cells(spec))
    return 0


def cmd_train(args) -> int:
    spec = get_spec(args.market)
    cells = features.load_cells(spec)

    results = validate.sweep(spec, cells)
    winner = validate.best(results, spec)
    print(f"[modeling] best: window={winner.form_window} "
          f"half_life={winner.half_life} oos={winner.oos}")

    # Holdout: fit on everything before 2026, evaluate on 2026 only.
    from modeling.fit import fit
    pre = cells[cells["season"] < validate.HOLDOUT_SEASON]
    held = cells[cells["season"] == validate.HOLDOUT_SEASON]
    holdout_fit = fit(spec, pre, form_window=winner.form_window,
                      half_life=winner.half_life)
    holdout = (validate.evaluate(spec, holdout_fit, held, winner.form_window)
               if len(held) else None)
    print(f"[modeling] holdout({validate.HOLDOUT_SEASON}): {holdout}")

    # Production fit uses EVERY season including the holdout. The holdout
    # verified the recipe; the shipped coefficients should see all the data.
    final = fit(spec, cells, form_window=winner.form_window,
                half_life=winner.half_life)
    params = spec.to_params(final, winner.form_window)

    promote, reason = (False, "not requested")
    if args.promote:
        promote, reason = registry.gate(spec, winner.oos,
                                        registry.active_oos(spec.market))
    print(f"[modeling] gate: {reason}")

    version = registry.make_version() if args.promote else None
    run = runs.build_run(spec, winner, holdout=holdout, calibration=None,
                         params=params,
                         status="promoted" if promote else "completed",
                         notes=reason, version=version)
    runs.record(run)

    if args.promote:
        registry.insert_version(spec.market, version, params, winner.oos,
                                notes=reason)
        if promote:
            registry.activate(spec.market, version)
    return 0


def cmd_baseline(args) -> int:
    """Give the live versions comparable out-of-sample numbers.

    Their params are known, so they are SCORED through the walk-forward harness
    without refitting. Without this the first gate has nothing to compare to.
    """
    for market in ([args.market] if args.market else all_markets()):
        spec = get_spec(market)
        row = registry.active(market)
        if not row:
            print(f"[modeling] {market}: no active version, skipping")
            continue
        cells = features.load_cells(spec)
        from modeling.fit import FitResult
        params = row["params"]
        stand_in = FitResult(family=params["type"],
                             feature_names=tuple(params.get("features", ())),
                             classes=tuple(params.get("classes", ())) or None,
                             coef=params.get("coef"),
                             intercept=params.get("intercept"),
                             sigma=params.get("sigma"))
        window = params.get("form_window", spec.form_windows[0])
        folds = [validate.FoldResult(
            season, 0.0, float(cells[cells["season"] == season]["n"].sum()),
            validate.evaluate(spec, stand_in,
                              cells[cells["season"] == season], window))
            for season in validate.WALK_FORWARD_SEASONS
            if len(cells[cells["season"] == season])]
        sweep_like = validate.SweepResult(window, None, folds,
                                          validate.aggregate(folds))
        runs.record(runs.build_run(
            spec, sweep_like, holdout=None, calibration=None, params=params,
            status="completed", version=row["version"],
            notes="baseline backfill: active params scored, not refitted"))
        print(f"[modeling] {market} {row['version']} baseline: {sweep_like.oos}")
    return 0


def cmd_list(args) -> int:
    from backend.db.client import get_client
    rows = (get_client().table("model_params")
            .select("market, version, is_active, activated_at, metrics")
            .order("market").execute().data)
    for r in rows:
        flag = "ACTIVE" if r["is_active"] else "      "
        print(f"{flag} {r['market']:<16} {r['version']:<14} {r['metrics']}")
    return 0


def cmd_show(args) -> int:
    print(json.dumps(registry.active(args.market), indent=2))
    return 0


def cmd_status(args) -> int:
    from backend.db.client import get_client
    client = get_client()
    for market in all_markets():
        row = registry.active(market)
        live = (client.table("predictions").select("model_version")
                .eq("market", market).order("created_at", desc=True)
                .limit(1).execute().data)
        stamped = live[0]["model_version"] if live else None
        registered = row["version"] if row else None
        flag = "OK " if stamped == registered else "!! "
        print(f"{flag}{market:<16} registry={registered} live={stamped}")
        if stamped != registered:
            print("     ^ mismatch: live-poll may need a redeploy")
    return 0


def cmd_activate(args) -> int:
    registry.activate(args.market, args.version)
    return 0


def cmd_rollback(args) -> int:
    registry.rollback(args.market)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m modeling",
                                 description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="build feature cells from R2 (touches R2)")
    b.add_argument("--market")
    b.add_argument("--seasons", help="e.g. 2019-2026")

    for name, helptext in (("train", "sweep, validate, record, optionally promote"),
                           ("sweep", "walk-forward over every hyperparameter pair")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("market")
        if name == "train":
            p.add_argument("--promote", action="store_true",
                           help="gate on OOS metrics and activate if it passes")

    bl = sub.add_parser("baseline", help="score active params for a comparable OOS number")
    bl.add_argument("--market")

    sub.add_parser("list", help="every version, per market")
    sub.add_parser("status", help="registry version vs what live scoring stamps")

    for name, helptext in (("show", "active params for one market"),
                           ("rollback", "reactivate the prior version")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("market")

    a = sub.add_parser("activate", help="make a version live")
    a.add_argument("market")
    a.add_argument("version")
    return ap


_COMMANDS = {
    "build": cmd_build, "sweep": cmd_sweep, "train": cmd_train,
    "baseline": cmd_baseline, "list": cmd_list, "show": cmd_show,
    "status": cmd_status, "activate": cmd_activate, "rollback": cmd_rollback,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return _COMMANDS[args.command](args)
```

- [ ] **Step 4: Run the tests**

```bash
py -m pytest tests/modeling/test_cli.py -v
```

Expected: 12 passed.

- [ ] **Step 5: Establish the baseline, then train**

```bash
py -m modeling baseline --market pitch_result
py -m modeling train pitch_result
```

Expected: the baseline prints OOS metrics for `v1_20260707`; `train` prints the sweep, the winner, the holdout, and records a run **without promoting** (no `--promote`).

- [ ] **Step 6: Commit**

```bash
git add modeling/cli.py tests/modeling/test_cli.py
git commit -m "feat(modeling): CLI for the build/train/validate/record/promote loop"
```

## ✅ CHECKPOINT 6 — stop and report

| Item | Value |
|---|---|
| Baseline OOS for `v1_20260707` | |
| New model OOS | |
| New model 2026 holdout | |
| Gate verdict if `--promote` were passed | |
| `model_runs` row count | |

**Success criteria:**
- `python -m modeling baseline` recorded a run tied to `v1_20260707`.
- `python -m modeling train pitch_result` recorded a run.
- No `model_params` row changed (no `--promote` yet).
- All tests pass.

**Do not promote yet.** Promotion happens after Phase 7, once all five markets are trained.

---

# PHASE 7 — The remaining four markets

**Objective:** Four spec files, no engine changes. If the engine needs changing, the abstraction was wrong — say so at the checkpoint rather than special-casing.

Each task follows the identical shape: write the spec module, register it, extend `fit.py` with the family's fitter if it does not exist yet, build cells, verify.

### Task 7.1: `ab_result` (multinomial, reuses the existing fitter)

**Files:**
- Create: `modeling/specs/ab_result.py`
- Modify: `modeling/specs/__init__.py`

- [ ] **Step 1: Write the spec**

```python
# modeling/specs/ab_result.py
"""ab_result -- P(strikeout | walk | hit | out) for the plate appearance.

Four classes over ~2.0M plate appearances. Same multinomial family as
pitch_result, so this lands with no engine change -- which is the whole point
of the MarketSpec contract.

pitcher_bb_delta is folded into the intercept as zero, matching the v1 trainer:
the cell grain does not carry it. Adding it is a spec change (new bucket column
in cell_sql), not an engine change.
"""

from __future__ import annotations

from modeling.spec import MarketSpec

K_STEP = 0.035

CELL_SQL = """
with league as (
    select avg(case when result = 'strikeout' then 1.0 else 0.0 end) as k_rate
    from at_bats
)
select
    cast(strftime(a.game_date, '%Y') as int)                      as season,
    0                                                              as balls,
    0                                                              as strikes,
    case when a.result in ('strikeout','walk','hit','out')
         then a.result else 'out' end                              as outcome,
    cast(floor((f.career_k_rate - l.k_rate) / {k_step}) as int)    as career_zone_bucket,
    cast(floor((f.d30_k_rate    - l.k_rate) / {k_step}) as int)    as d30_zone_bucket,
    cast(floor((f.d90_k_rate    - l.k_rate) / {k_step}) as int)    as d90_zone_bucket,
    count(*)                                                       as n
from at_bats a
join form_spine_ab f
  on f.pitcher_id = a.pitcher_id and f.game_date = a.game_date
cross join league l
where f.career_n > 0
group by all
""".format(k_step=K_STEP)


def to_params(fit, form_window: str) -> dict:
    return {
        "type": "multinomial_logistic",
        "classes": list(fit.classes),
        "features": list(fit.feature_names),
        "coef": [[round(v, 6) for v in row] for row in fit.coef],
        "intercept": [round(v, 6) for v in fit.intercept],
        "form_window": form_window,
    }


SPEC = MarketSpec(
    market="ab_result",
    family="multinomial_logistic",
    cell_sql=CELL_SQL,
    feature_names=("balls", "strikes", "pitcher_k_delta", "pitcher_bb_delta",
                   "batter_k_delta", "platoon_same"),
    classes=("strikeout", "walk", "hit", "out"),
    primary_metric="logloss",
    metric_direction="lower",
    form_windows=("career", "d30", "d90"),
    to_params=to_params,
)
```

- [ ] **Step 2: Add the at-bat form spine**

Append `FORM_SPINE_AB_SQL` to `modeling/features.py`, identical in structure to `FORM_SPINE_SQL` (same exclusive `interval 1 day preceding` bounds) but aggregating `at_bats` into `k_rate` instead of `zone_rate`, and add `build_form_spine_ab(store, *, seasons=None, con=None)` mirroring `build_form_spine`. **Copy the window clauses verbatim** — the leakage bound must be identical.

- [ ] **Step 3: Extend `_design` in `fit.py` for the ab features**

Add to the `columns` dict in `modeling/fit.py::_design`:

```python
        "pitcher_k_delta": zone,          # the k-rate delta bucket for this market
        "pitcher_bb_delta": np.zeros(len(cells)),
        "batter_k_delta": np.zeros(len(cells)),
        "platoon_same": np.zeros(len(cells)),
```

- [ ] **Step 4: Register, build, verify**

```bash
py -m modeling build --market ab_result
py -m modeling sweep ab_result
```

Expected: four-class OOS log-loss below `ln(4) ≈ 1.3863`.

- [ ] **Step 5: Commit**

```bash
git add modeling/ && git commit -m "feat(modeling): ab_result market spec"
```

### Task 7.2: `pitch_speed_ou` (linear — new family)

**Files:**
- Create: `modeling/specs/pitch_speed_ou.py`
- Modify: `modeling/fit.py` (add `_fit_linear`), `modeling/validate.py` (regression evaluate branch), `modeling/score.py` (linear branch), `modeling/specs/__init__.py`
- Test: `tests/modeling/test_fit_linear.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/modeling/test_fit_linear.py
"""The linear family, and the sigma that turns it into a probability."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from modeling.fit import fit
from modeling.spec import get_spec


def _cells() -> pd.DataFrame:
    rows = []
    for season in (2023, 2024):
        for strikes in (0, 1, 2):
            rows.append({"season": season, "balls": 0, "strikes": strikes,
                         "mean_speed": 92.0 + strikes, "var_speed": 4.0,
                         "n": 1000.0, "career_velo_bucket": 0,
                         "d30_velo_bucket": 0, "d90_velo_bucket": 0,
                         "pitch_of_pa": 1})
    return pd.DataFrame(rows)


def test_linear_fit_produces_sigma():
    spec = get_spec("pitch_speed_ou")
    result = fit(spec, _cells(), form_window="career", half_life=None)
    assert result.family == "linear"
    assert result.sigma is not None and result.sigma > 0


def test_sigma_includes_within_cell_variance():
    """Cells are aggregates: sigma must combine between- and within-cell spread.

    Using only the residuals of the cell means would understate sigma badly,
    and an understated sigma produces confidently wrong P(over).
    """
    spec = get_spec("pitch_speed_ou")
    result = fit(spec, _cells(), form_window="career", half_life=None)
    assert result.sigma >= 2.0, \
        "sigma must be at least sqrt(within-cell var)=2.0 from var_speed=4.0"
```

- [ ] **Step 2: Run to verify failure, then implement**

Add to `modeling/fit.py`:

```python
def _fit_linear(spec, cells, form_window, half_life) -> FitResult:  # noqa: ANN001
    """Weighted least squares, with sigma combining both variance components.

    Cells are aggregates, so total variance = between-cell (residuals of the
    cell means) + within-cell (the var_speed each cell carries). Using only the
    first understates sigma, and pitch_speed_ou converts sigma to P(over)
    through a normal CDF -- an understated sigma is confidently wrong output.
    """
    from sklearn.linear_model import LinearRegression

    X = _design_linear(spec, cells, form_window)
    y = cells["mean_speed"].to_numpy(float)
    w = decay_weights(cells["season"].to_numpy(), cells["n"].to_numpy(), half_life)

    reg = LinearRegression()
    reg.fit(X, y, sample_weight=w)

    resid = y - reg.predict(X)
    between = float(np.average(resid ** 2, weights=w))
    within = float(np.average(cells["var_speed"].fillna(0.0).to_numpy(float),
                              weights=w))
    return FitResult(
        family="linear",
        feature_names=spec.feature_names,
        coef=[float(v) for v in reg.coef_],
        intercept=float(reg.intercept_),
        sigma=float(np.sqrt(between + within)),
    )


_FITTERS["linear"] = _fit_linear
```

Add `_design_linear` mapping `pitcher_velo` to the selected `{window}_velo_bucket`, plus `balls`, `strikes`, `pitch_of_pa`.

Add the matching `linear` branch to `modeling/score.py`, using **the same normal-CDF approximation as `model.ts`** — read it and copy the constants.

- [ ] **Step 3: Add `predict_linear` and the regression branch to `validate.py`**

`evaluate()` as written in Task 3.3 assumes multinomial. Add both of these to `modeling/validate.py`, and make `evaluate()` dispatch on `spec.family` at its top:

```python
def predict_linear(spec, result: FitResult, cells: pd.DataFrame,  # noqa: ANN001
                   form_window: str) -> np.ndarray:
    from modeling.fit import _design_linear

    X = _design_linear(spec, cells, form_window)
    return X @ np.asarray(result.coef) + float(result.intercept)


def _evaluate_linear(spec, result, cells, form_window) -> dict:  # noqa: ANN001
    yhat = predict_linear(spec, result, cells, form_window)
    y = cells["mean_speed"].to_numpy(float)
    w = cells["n"].to_numpy(float)
    return {
        "rmse": round(M.rmse(y, yhat, w), 6),
        "sigma": round(result.sigma, 4),
        "sigma_coverage": round(M.sigma_coverage(y, yhat, result.sigma, w), 5),
        "n": float(w.sum()),
    }
```

Then restructure `evaluate()` so every family has an explicit branch and an unknown family raises rather than silently returning multinomial metrics:

```python
def evaluate(spec, result: FitResult, cells: pd.DataFrame,  # noqa: ANN001
             form_window: str) -> dict:
    if spec.family == "multinomial_logistic":
        return _evaluate_multinomial(spec, result, cells, form_window)
    if spec.family == "linear":
        return _evaluate_linear(spec, result, cells, form_window)
    raise NotImplementedError(
        f"no evaluator for family {spec.family!r} (market {spec.market!r})")
```

Move the existing multinomial body from Task 3.3 into `_evaluate_multinomial` unchanged.

- [ ] **Step 4: Run, build, verify, commit**

```bash
py -m pytest tests/modeling -v
py -m modeling build --market pitch_speed_ou
py -m modeling sweep pitch_speed_ou
git add modeling/ tests/modeling/ && git commit -m "feat(modeling): pitch_speed_ou linear family with two-component sigma"
```

Expected: `sigma_coverage` between 0.63 and 0.73. **If it is outside, the sigma is wrong** — check that within-cell variance is included.

### Task 7.3: `ab_pitches_ou` (remaining_table)

**Files:**
- Create: `modeling/specs/ab_pitches_ou.py`
- Modify: `modeling/fit.py` (`_fit_remaining_table`), `modeling/score.py`, `modeling/specs/__init__.py`

- [ ] **Step 1: Implement the fitter**

```python
def _fit_remaining_table(spec, cells, form_window, half_life) -> FitResult:  # noqa: ANN001
    """Empirical distribution of REMAINING pitches, keyed 'balls-strikes'.

    No coefficients -- this family is a weighted histogram. Recency decay still
    applies, so recent seasons shape the distribution more.
    """
    w = decay_weights(cells["season"].to_numpy(), cells["n"].to_numpy(), half_life)
    grouped: dict[str, dict[int, float]] = {}
    for (balls, strikes, remaining), weight in zip(
            zip(cells["balls"], cells["strikes"], cells["remaining"]), w):
        grouped.setdefault(f"{balls}-{strikes}", {})
        key = int(remaining)
        grouped[f"{balls}-{strikes}"][key] = \
            grouped[f"{balls}-{strikes}"].get(key, 0.0) + float(weight)

    table = {}
    for state, dist in grouped.items():
        total = sum(dist.values())
        table[state] = {
            "mean": round(sum(k * v for k, v in dist.items()) / total, 3),
            "dist": {str(k): round(v / total, 5) for k, v in sorted(dist.items())},
        }
    return FitResult(family="remaining_table",
                     feature_names=spec.feature_names, table=table)


_FITTERS["remaining_table"] = _fit_remaining_table
```

- [ ] **Step 2: Add the evaluator — `evaluate()` will raise without it**

```python
def _evaluate_remaining_table(spec, result, cells, form_window) -> dict:  # noqa: ANN001
    """Log-loss of the fitted discrete distribution against held-out cells."""
    probs, weights = [], []
    for balls, strikes, remaining, n in zip(
            cells["balls"], cells["strikes"], cells["remaining"], cells["n"]):
        entry = (result.table or {}).get(f"{balls}-{strikes}")
        dist = (entry or {}).get("dist", {})
        probs.append(float(dist.get(str(int(remaining)), 0.0)))
        weights.append(float(n))
    p = np.clip(np.array(probs), 1e-12, 1.0)
    w = np.array(weights)
    return {
        "logloss": round(float(-np.average(np.log(p), weights=w)), 6),
        "states": len(result.table or {}),
        "n": float(w.sum()),
    }
```

Register it in `evaluate()`'s dispatch alongside the other two families.

- [ ] **Step 3: Spec, register, build, verify, commit**

`cell_sql` groups `at_bats` by `balls`, `strikes`, `remaining` (pitches left in the PA) with `count(*) as n` and `season`. `to_params` returns `{"type": "remaining_table", "table": fit.table}`. `primary_metric` is `logloss`, `metric_direction` `lower`, `form_windows=("career",)` — this family uses no form features, and `MarketSpec` rejects an empty tuple.

```bash
py -m modeling build --market ab_pitches_ou
py -m modeling sweep ab_pitches_ou
git add modeling/ && git commit -m "feat(modeling): ab_pitches_ou remaining-table family"
```

### Task 7.4: `game_moneyline` (log5)

**Files:**
- Create: `modeling/specs/game_moneyline.py`
- Modify: `modeling/fit.py` (`_fit_log5`), `modeling/score.py`, `modeling/specs/__init__.py`

- [ ] **Step 1: Implement the fitter**

```python
def _fit_log5(spec, cells, form_window, half_life) -> FitResult:  # noqa: ANN001
    """Home-field advantage as a single weighted rate.

    One parameter. It is in the workbench anyway so every market goes through
    the same validation, recording and promotion path -- a market that skips
    the loop is a market whose regressions nobody notices.
    """
    w = decay_weights(cells["season"].to_numpy(), cells["n"].to_numpy(), half_life)
    home_adv = float(np.average(cells["home_win"].to_numpy(float), weights=w))
    return FitResult(family="log5", feature_names=(), intercept=home_adv)


_FITTERS["log5"] = _fit_log5
```

- [ ] **Step 2: Add the evaluator — `evaluate()` will raise without it**

```python
def _evaluate_log5(spec, result, cells, form_window) -> dict:  # noqa: ANN001
    """Brier score of the constant home-advantage rate against held-out games."""
    p = float(result.intercept)
    y = cells["home_win"].to_numpy(float)
    w = cells["n"].to_numpy(float)
    return {
        "brier": round(float(np.average((p - y) ** 2, weights=w)), 6),
        "home_adv": round(p, 4),
        "n": float(w.sum()),
    }
```

Register it in `evaluate()`'s dispatch. Set `primary_metric="brier"`, `metric_direction="lower"`.

- [ ] **Step 3: Spec, register, build, verify, commit**

`cell_sql` selects from `games`: `season`, `case when home_score > away_score then 1 else 0 end as home_win`, `count(*) as n`, grouped by season and `home_win`. `to_params` returns `{"type": "log5", "home_adv": round(fit.intercept, 4)}`. `form_windows=("career",)` — no form features, and `MarketSpec` rejects an empty tuple.

```bash
py -m modeling build --market game_moneyline
py -m modeling sweep game_moneyline
git add modeling/ && git commit -m "feat(modeling): game_moneyline log5 family"
```

### Task 7.5: Remove the xfail

- [ ] **Step 1: Delete the `@pytest.mark.xfail` decorator** from `test_all_five_markets_registered` in `tests/modeling/test_spec.py`.

- [ ] **Step 2: Run the full suite**

```bash
py -m pytest tests/modeling -v
```

Expected: all pass, **no xfail**.

- [ ] **Step 3: Commit**

```bash
git add tests/modeling/test_spec.py
git commit -m "test(modeling): all five markets registered"
```

## ✅ CHECKPOINT 7 — stop and report

| Market | Best window | Best half-life | OOS metric | 2026 holdout | Baseline (v1) |
|---|---|---|---|---|---|
| pitch_result | | | | | |
| ab_result | | | | | |
| pitch_speed_ou | | | | | |
| ab_pitches_ou | | | | | |
| game_moneyline | | | | | |

**Success criteria:**
- All five markets build, sweep, and produce OOS metrics.
- `pitch_speed_ou` σ-coverage is inside [0.63, 0.73].
- Multinomial markets beat their uniform baselines (`ln(3)`, `ln(4)`).
- No engine file needed a market-name special case. **If one did, report it** — that is a design failure worth naming, not hiding.
- Full test suite green.

---

# PHASE 8 — Visibility

### Task 8.1: Dashboard Models page

**Files:**
- Create: `dashboard/pages/2_Models.py`
- Modify: `dashboard/app.py:44`

- [ ] **Step 1: Raise the cache TTL**

In `dashboard/app.py`, change:

```python
CACHE_TTL_SECONDS = 30
```

to:

```python
# 300s, not 30s. Streamlit re-runs the script on every widget interaction, so a
# 30-second TTL made active browsing re-query R2 roughly twice a minute --
# a larger Class B consumer than the entire training pipeline. Warehouse data
# is written once nightly; sub-minute freshness bought nothing.
CACHE_TTL_SECONDS = 300
```

- [ ] **Step 2: Write the Models page**

```python
# dashboard/pages/2_Models.py
"""Models: what is live, what was tried, and how it was chosen.

Reads model_params (production truth) and model_runs (the experiment record).
Read-only -- promotion goes through `python -m modeling train --promote`, never
through a dashboard button. A UI that can change what production serves is a UI
that will, by accident.
"""

from __future__ import annotations

import pandas as pd
import plotly.express as px
import streamlit as st

from backend.db.client import get_client

CACHE_TTL = 300

st.set_page_config(page_title="Models", page_icon="🧪", layout="wide")
st.title("Models")


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_params() -> pd.DataFrame:
    return pd.DataFrame(get_client().table("model_params")
                        .select("market, version, is_active, activated_at, metrics, notes")
                        .order("market").execute().data or [])


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_runs() -> pd.DataFrame:
    return pd.DataFrame(get_client().table("model_runs")
                        .select("*").order("created_at", desc=True)
                        .limit(200).execute().data or [])


@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_live_versions() -> dict:
    rows = (get_client().table("predictions")
            .select("market, model_version")
            .order("created_at", desc=True).limit(500).execute().data or [])
    out = {}
    for r in rows:
        out.setdefault(r["market"], r["model_version"])
    return out


params, runs_df, live = load_params(), load_runs(), load_live_versions()

st.header("Production")
if params.empty:
    st.warning("No rows in model_params.")
else:
    active = params[params["is_active"]].copy()
    active["live_stamp"] = active["market"].map(live)
    active["match"] = active.apply(
        lambda r: "✅" if r["live_stamp"] == r["version"] else "⚠️", axis=1)
    st.dataframe(active[["match", "market", "version", "live_stamp",
                         "activated_at", "metrics"]], width="stretch")
    drift = active[active["match"] == "⚠️"]
    if not drift.empty:
        st.error(
            f"{len(drift)} market(s) where the registry's active version does "
            f"not match what live scoring is stamping. The live-poll edge "
            f"function likely needs a redeploy.")

st.header("Runs")
if runs_df.empty:
    st.info("No runs recorded yet. Run: python -m modeling train <market>")
else:
    market = st.selectbox("Market", sorted(runs_df["market"].unique()))
    subset = runs_df[runs_df["market"] == market]
    st.dataframe(
        subset[["created_at", "run_id", "status", "version", "config",
                "oos_metrics", "holdout_metrics", "notes"]],
        width="stretch")

    st.subheader("Fold detail")
    run_id = st.selectbox("Run", subset["run_id"].tolist())
    row = subset[subset["run_id"] == run_id].iloc[0]
    folds = pd.DataFrame(row["folds"] or [])
    if folds.empty:
        st.info("This run recorded no folds.")
    else:
        folds["metric"] = folds["metrics"].apply(
            lambda m: m.get("logloss", m.get("rmse")))
        st.plotly_chart(
            px.line(folds, x="test_season", y="metric", markers=True,
                    title=f"{market} — out-of-sample by test season"),
            width="stretch")
        st.caption("2020 is a 60-game COVID season; it is reported here but "
                   "excluded from the aggregate.")
```

- [ ] **Step 3: Run the dashboard and verify both sections render**

```bash
streamlit run dashboard/app.py
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/pages/2_Models.py dashboard/app.py
git commit -m "feat(dashboard): Models page and a 300s cache TTL

The 30s TTL made active browsing re-query R2 twice a minute -- a larger Class B
consumer than the whole training pipeline."
```

## ✅ CHECKPOINT 8

**Success criteria:**
- Models page shows five active versions with match indicators.
- Runs table shows every run from Phases 6–7.
- Fold chart renders for at least one run.
- `CACHE_TTL_SECONDS` is 300.

---

# PHASE 9 — Promote, clean up, document

### Task 9.1: Promote

- [ ] **Step 1: Establish baselines for all five**

```bash
py -m modeling baseline
```

- [ ] **Step 2: Train with promotion, one market at a time**

```bash
py -m modeling train pitch_result --promote
py -m modeling train ab_result --promote
py -m modeling train pitch_speed_ou --promote
py -m modeling train ab_pitches_ou --promote
py -m modeling train game_moneyline --promote
```

**Held versions are a correct outcome.** Record which promoted and which did not.

- [ ] **Step 3: Verify what is live**

```bash
py -m modeling list
py -m modeling status
```

`status` mismatches are expected until `live-poll` is redeployed — that is the alarm working, not a bug.

### Task 9.2: Retire the old trainer

- [ ] **Step 1: Delete the replaced scripts**

```bash
git rm scripts/train_models.py scripts/models.py
```

- [ ] **Step 2: Repoint the workflow**

In `.github/workflows/train-models.yml`, replace the `Install deps` and `Train` steps:

```yaml
      - name: Install deps
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements-modeling.txt
      - name: Build features
        env:
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
        run: python -m modeling build
      - name: Train (records runs, does not promote)
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
        run: |
          for m in pitch_result ab_result pitch_speed_ou ab_pitches_ou game_moneyline; do
            python -m modeling train "$m"
          done
```

Keep `on: workflow_dispatch` only, and **do not add `--promote`** — CI records, humans promote.

Update the header comment: the DISABLED block is no longer true.

- [ ] **Step 3: Update the docs**

Rewrite `docs/MODELS.md` for: `python -m modeling` commands, the out-of-sample gate replacing the in-sample one, `model_runs`, the walk-forward/holdout/refit-on-all method, and the parity test. Keep the existing `params` shape reference — it is still correct and `model.ts` still branches on it.

- [ ] **Step 4: Full suite and commit**

```bash
py -m pytest tests -v
git add -A
git commit -m "chore(modeling): retire scripts/train_models.py and scripts/models.py

Replaced by python -m modeling. The workflow now builds from R2 and records
runs; promotion stays a deliberate human step."
```

## ✅ CHECKPOINT 9 — final report

| Item | Value |
|---|---|
| Markets promoted | |
| Markets held by the gate (and why) | |
| Total `model_runs` rows | |
| Measured R2 Class B for the whole project | |
| Full test suite result | |
| Files deleted | |

**Success criteria:**
- `python -m pytest tests -v` fully green.
- Every market has at least one baseline run and one new run.
- Every promotion passed the OOS gate; nothing was forced.
- `git diff master --stat` shows no changes to `backend/models/predictor.py`, and `model.ts` changed by at most one `export` keyword.
- Total R2 Class B consumption is under 500,000 — 5 % of the monthly allowance.

---

## Appendix: quick reference

```bash
# The loop
py -m modeling build                      # R2 -> local cells (only R2 command)
py -m modeling sweep pitch_result         # walk-forward over all hyperparameters
py -m modeling train pitch_result         # sweep + holdout + record, no promote
py -m modeling train pitch_result --promote   # + gate + activate

# Production
py -m modeling list                       # every version
py -m modeling status                     # registry vs what live scoring stamps
py -m modeling show pitch_result          # active params
py -m modeling activate pitch_result v2_20260808
py -m modeling rollback pitch_result

# Verification
py -m pytest tests/modeling -v
deno test --allow-write supabase/functions/tests/scorer_golden_test.ts
```

**Uniform baselines to beat:** 3-class `ln(3) = 1.0986`, 4-class `ln(4) = 1.3863`.
**σ-coverage target:** 0.68, band [0.63, 0.73].
**Never:** write to R2, list the bucket, `--force` a promotion, change `model.ts` logic, weaken a failing test.