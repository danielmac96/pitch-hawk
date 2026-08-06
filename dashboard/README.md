# ML Pipeline QA Dashboard

A single-page Streamlit dashboard for the Cloudflare R2 Parquet warehouse.
Internal QA only, read-only, and deliberately boring: it reads the bucket **in
place** with DuckDB and copies nothing into another database.

It is built to answer one question first — *is anything wrong right now?* — and
only then to let you look closer.

As of 2026-08-05 the warehouse it inspects holds 2,015 dataset-days per
dataset — 7.9 M pitches, 2.0 M plate appearances, 26.9 K games — spanning
2015-04-05 to 2026-08-03.

---

## Setup

From the repo root:

```bash
pip install -r dashboard/requirements.txt
cd dashboard
streamlit run app.py
```

Credentials come from the repo-root `.env` (the same four the pipeline uses).
To keep a separate set, copy `.env.example` to `dashboard/.env`; values already
exported into the environment win over both.

```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=pitch-hawk-warehouse
```

Read access is all it needs. It never writes to the bucket.

Tests for the judgement layer — the thresholds are the part that must not
silently break — run without credentials or network:

```bash
python -m pytest tests/dashboard -q
```

---

## Two things about this bucket that shape the whole design

**The scoped R2 token has no LIST permission.** `ListObjectsV2` returns
AccessDenied, so there is no bucket listing to build a file inventory from and
no way for DuckDB to resolve a `*.parquet` glob — `aws s3 ls` will tell you the
bucket is empty, and it is not. Every file is resolved through `_manifest.json`,
exactly as `warehouse/duck.py` does.

**The manifest already records rows, games, bytes and timestamps per file.** So
the entire overview — verdict, freshness, volume, lag, cross-dataset agreement,
inventory — costs one 1.5 MB GET and covers all 2,015 days. Only the deep dive
reads Parquet, and it is windowed.

| Section | Source | Cost |
|---|---|---|
| Verdict, freshness, recent ingestion, volume, lag, cross-dataset, inventory | `_manifest.json` | one GET, full history |
| Column health, value sanity, distributions, integrity | Parquet in R2 | scales with the sidebar window (3 days by default) |
| Latest records | one day's Parquet file | one file, 100 rows |

---

## How "normal" is defined

Every *is this day normal?* judgement uses a **robust z score against the
trailing 28 days the warehouse actually holds** — game days, not calendar days
— excluding the day being judged:

```
z = 0.6745 × (x − median) / MAD
```

Median and MAD rather than mean and σ because a single broken day inflates σ
enough to hide itself. A day flags when **both** `|z|` passes 2.5 (warn) or 3.5
(fail) **and** the move passes a relative floor. Both conditions are required,
and that pairing is the whole calibration story:

> Run naively against the live warehouse, a bare robust-z rule marked **293 of
> 2,014 pitch-days as failing** — essentially all of them healthy. Three guards
> bring that to one warn in the last 14 days per dataset.

| Guard | Why |
|---|---|
| 5% relative floor | A metric with a tiny MAD otherwise flags on rounding noise. |
| Volume judged as **rows per game**, not rows | Raw rows swing with the schedule. A 15-game day at 1,100 pitches is broken; a 4-game day at 1,150 is a Monday. The two are identical in a row-count chart. |
| ≥ 3 games to judge volume | 2026-07-16 held one game at 258 pitches — 12% under the median, and correct. |
| `bytes_per_row` only on files ≥ 3,000 rows, at a 15% floor | Parquet's per-file overhead is fixed, so a light schedule raises bytes-per-row on its own. A 500-row floor flagged 167 healthy `at_bats` days. |
| Lag judged against the clock, not a baseline, and only on nightly writes | The corpus was backfilled in one pass on 2026-07-31 — 2,011 days per dataset in minutes. Those files have lags of up to eleven years and are not late. A write batch covering more than 20 dataset-days is classified as a backfill. |

Thresholds live at the top of `utils/metrics.py` and `utils/checks.py`, one
constant per rule with the measurement that set it.

---

## The checks

The verdict strip shows every check as a chip — icon, label and colour, never
colour alone — and expands the failing ones with the rows behind them.

| Check | Asks | Warn / fail |
|---|---|---|
| **Freshness** | Time since anything was written at all. The primary "did last night run?" signal. | 30h / 48h. A future-dated write is flagged rather than read as fresh. |
| **Coverage** | How far the newest *game date* trails today. | 3d / 4d — the nightly covers through the previous day, so ~2d behind is the resting state. |
| **Volume** | Rows per game against each dataset's trailing baseline. | robust z, guarded as above |
| **Cross-dataset** | Do `pitches`, `at_bats` and `games` describe the same days the same way? Catches one dataset landing without its siblings — invisible from inside any single dataset. | any day missing a dataset fails; ratios outside 3.4–4.4 pitches/PA or 60–95 PA/game warn |
| **Ingest lag** | How long after the games each nightly file appeared. | 3d / 5d |
| **File size** | Bytes per row — a schema change or an all-null column, with no scan. | 15% floor, large files only |
| **Verification** | Have recent days been independently re-derived? Only `warehouse.verify` writes `verified_by`, and the hot-window prune gates its deletes on it. | any of the last 3 unverified warns |
| **Day gaps** | In-season calendar days with no file, over the last 14. | 1 day / 3 days. The lookback is short so the All-Star break ages out instead of flagging for six weeks. |
| **Duplicate keys** | Rows in excess of distinct natural keys — a day written twice. | any fails |
| **Referential** | Pitches whose `game_pk` has no row in that day's `games` file. | any fails |
| **Null rates** | Which columns *moved* against the baseline, in percentage points. The absolute rate is rarely the question: `on_third` is 91% null every day by design. | 1pp / 5pp; structural nulls exempt |
| **Value sanity** | Rules a valid feed cannot break, scored by movement. | a rule firing for the first time today fails; one firing at its usual rate is reported as *known* |
| **Category sets** | Values that appeared or vanished versus the baseline — how a feed or flattener change announces itself. | any appearance warns; a vanished value needs ≥ 20 baseline observations to count |

### One known defect this surfaced

`pitches.outs` breaks its own range on **~22% of rows on every day in the
corpus**. The value comes straight from `play.count.outs` in the MLB feed, which
is the count *after* the plate appearance, so pitches mid-at-bat carry the
inning's final out count — 514 of 2,351 rows on 2026-08-03 show `outs = 3`,
which cannot happen before a pitch.

This is the same leak class `warehouse/mlb.py` deliberately avoids for
`men_on_base` (and the reason its comment says the API's post-play state "leaks
the at-bat's own outcome"), but `balls` and `strikes` are lagged there while
`outs` is not. It is an ingest bug, not a dashboard one — fixing it means
changing the flattener and re-ingesting. Until then the check reports it as
*known*, which is why "firing at its usual rate" is a distinct state from "broke
today": a check that fails forever is ignored within a week.

---

## Reading the page

**Overview** (no Parquet read):

1. **Verdict** — one line, then a chip per check, failures expanded with evidence.
2. **Freshness tiles** — time since last write, newest game day, median nightly
   lag, verification share, with a 30-file sparkline.
3. **Recent ingestion** — the last 14 day-files × 3 datasets with rows,
   expected, games, rows/game, deviation, bytes/row, lag and verification.
   Cells are tinted where the day is off its baseline. This is the table to read
   when something is flagged.
4. **Volume** — bars of actual rows against a stepped *expected* line (games ×
   baseline rows per game); bars turn amber or red where rows-per-game leaves
   the baseline.
5. **Ingest lag** — nightly writes as a line, backfilled days greyed out and
   never judged, with the warn threshold drawn in.
6. **Cross-dataset agreement** — pitches per plate appearance and plate
   appearances per game against their expected bands.

**Deep dive** (scans, sidebar dataset and window): column health · value sanity ·
distributions (latest day against baseline, both normalised to share) ·
integrity · latest 100 records · file inventory.

### Column names

The warehouse uses the MLB feed's own names:

| Colloquial | Warehouse column |
|---|---|
| pitch speed | `start_speed` |
| exit velocity | `launch_speed` |
| game id | `game_pk` |
| pitch id | *(none — keyed by `game_pk`, `at_bat_index`, `pitch_number`)* |

Column lists come from the frozen `pyarrow` schemas in `warehouse/config.py`, so
a schema change reaches this dashboard without an edit here.

---

## Refresh behaviour

Nothing is served from cache for longer than **30 seconds**. **Refresh Data**
clears every cached result and reruns immediately. The R2 client and the DuckDB
connection are process-scoped and are not rebuilt by a refresh — only data is.

## When R2 is unreachable

The page renders `Unable to connect to Cloudflare R2.` with the underlying error
behind a *Details* expander, and keeps running. A failure inside one section
takes down that section only, and the overview and the deep dive fail
independently.

The most common cause is a wrong `R2_BUCKET`: R2 answers HTTP 403 rather than
404 on every object of a bucket you cannot see, which historically made the
warehouse read as *empty* rather than *unreachable*. The store head-buckets at
startup so this reports as a connection failure instead.

---

## Layout

```
dashboard/
├── app.py                 # page layout, caching, all Streamlit rendering
├── data/queries.py        # every SQL statement, one place
├── utils/r2.py            # store, manifest and credentials (wraps warehouse/)
├── utils/duckdb_conn.py   # the DuckDB connection and query execution
├── utils/metrics.py       # derived metrics, baselines, the anomaly rule
├── utils/checks.py        # the checks and their thresholds
├── utils/palette.py       # validated colour tokens and chart chrome
├── .streamlit/config.toml # chrome colour (Streamlit's default red is reserved here)
├── requirements.txt · .env.example · assets/
```

`utils/r2.py` imports the repo's `warehouse` package rather than
re-implementing credentials, the store or the manifest, so the dashboard cannot
drift from the pipeline that writes the data. It puts the repo root on
`sys.path` and loads the root `.env` before that import, because
`warehouse.config` calls `load_dotenv(".env")` relative to the working directory
and this app is launched from `dashboard/`.

Colour follows `utils/palette.py`: three categorical slots (validated for
colour-vision separation in both light and dark modes) for identity, and a
reserved status palette for state that is always paired with an icon and a
label. Every chart has a table twin, so no value is reachable by colour alone.
