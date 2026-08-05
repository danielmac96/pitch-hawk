"""R2 access for the QA dashboard.

The dashboard reads the same Cloudflare R2 warehouse the pipeline writes, over
the same code path: `warehouse.store.R2Store` for object access,
`warehouse.manifest` for the index. Nothing is re-implemented here, so a change
to credentials, endpoint or manifest layout cannot leave the dashboard
describing a warehouse that no longer exists.

Two things about this bucket drive the whole design:

  * **The scoped R2 token has no LIST permission.** `ListObjectsV2` returns
    AccessDenied, so there is no bucket listing to build a file inventory from
    and no way for DuckDB to resolve a `*.parquet` glob. Every file this
    dashboard reads is resolved through `_manifest.json`.

  * **The manifest already carries per-file rows, bytes and timestamps.** Row
    counts per day, total rows, total files and the file inventory are read
    from it directly and cost one 1.5 MB GET — no Parquet scan at all. Only the
    column-level sections (missingness, duplicates, distributions, drift) scan
    Parquet, and those are windowed.

`streamlit run app.py` is normally launched from this directory, so the repo
root is put on `sys.path` and the root `.env` is loaded explicitly before
`warehouse.config` is imported — that module calls `load_dotenv(".env")`
relative to the working directory and would otherwise find nothing.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

DASHBOARD_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = DASHBOARD_DIR.parent

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Dashboard-local .env wins over the repo root one; neither overrides a value
# already exported into the environment.
load_dotenv(DASHBOARD_DIR / ".env")
load_dotenv(REPO_ROOT / ".env")

# Imported here rather than at the top of the file, deliberately: the two
# statements above must run first. `warehouse` is only importable once the repo
# root is on sys.path, and `warehouse.config` reads the environment at import
# time — importing it before the .env files are loaded would leave the
# credentials unset.
from warehouse import manifest
from warehouse.config import (
    DATASETS,
    KEY_COLUMNS,
    SCHEMAS,
    SNAPSHOTS,
    object_key,
    r2_config,
    snapshot_key,
)
from warehouse.store import R2Store

__all__ = [
    "DATASETS",
    "KEY_COLUMNS",
    "SCHEMAS",
    "SNAPSHOTS",
    "R2Unavailable",
    "columns",
    "day_uris",
    "load_manifest",
    "manifest",
    "object_key",
    "open_store",
    "snapshot_key",
]

# Shown verbatim by the UI whenever the bucket cannot be reached. The
# underlying botocore/RuntimeError message is kept as the exception's cause so
# the app can offer it behind a "details" expander without leading with it.
CONNECT_ERROR = "Unable to connect to Cloudflare R2."


class R2Unavailable(RuntimeError):
    """R2 could not be reached, or is reachable but unusable.

    Raised for missing credentials, an unreachable bucket, and read failures
    alike: from the dashboard's point of view these are one condition — no
    data — and all of them must render as a message rather than a traceback.
    """


def open_store() -> R2Store:
    """Connect to the warehouse bucket, verifying it is reachable.

    `R2Store` head-buckets on construction, which is what turns a wrong
    `R2_BUCKET` into an error instead of an empty-looking warehouse: R2 answers
    403 rather than 404 on every object of a bucket you cannot see.
    """
    try:
        return R2Store(r2_config())
    except Exception as exc:
        raise R2Unavailable(CONNECT_ERROR) from exc


def load_manifest(store: R2Store) -> dict[str, Any]:
    """The warehouse index: every dataset-day with rows, bytes and timestamps."""
    try:
        return manifest.load(store)
    except Exception as exc:
        raise R2Unavailable(CONNECT_ERROR) from exc


def day_uris(store: R2Store, dataset: str, days: list[str]) -> list[str]:
    """`s3://` URIs for the given dataset-days, in the order supplied."""
    return [store.uri(object_key(dataset, day)) for day in days]


def columns(dataset: str) -> list[str]:
    """Column names of a dataset, from the frozen Parquet schema."""
    return list(SCHEMAS[dataset].names)
