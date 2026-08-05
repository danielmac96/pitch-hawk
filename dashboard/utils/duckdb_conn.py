"""The DuckDB connection the dashboard queries R2 through.

One in-memory connection is reused for the life of the Streamlit process.
`httpfs` install/load and the six S3 settings are per-connection state, so
building a fresh connection per query would re-do that work on every rerun;
`warehouse.store.R2Store.configure_duckdb` applies exactly the settings the
pipeline itself uses.

A DuckDB connection is not safe to use from several threads at once, and
Streamlit reruns scripts on their own threads, so every query goes through a
module-level lock. Queries here are aggregates over a bounded day window, so
serialising them costs ordering, not throughput.

Nothing is downloaded to disk: `read_parquet('s3://…')` streams column chunks
over HTTP and DuckDB pushes the projection and filters into the scan.
"""

from __future__ import annotations

import threading
from typing import Any

import duckdb
import pandas as pd
from utils.r2 import CONNECT_ERROR, R2Unavailable

_LOCK = threading.Lock()

# Guards a runaway section: without it a mis-typed window could scan all 2,014
# days (550 MB of Parquet) and leave the page spinning with no way to tell a
# slow query from a hung one.
QUERY_TIMEOUT_NOTE = (
    "Queries scan Parquet in R2 directly. Widen the window in the sidebar only "
    "as far as you need — cost scales with days scanned."
)


def connect(store: Any) -> duckdb.DuckDBPyConnection:
    """A connection wired to read this store's Parquet over the S3 API."""
    try:
        con = duckdb.connect()
        # The progress bar emits thousands of carriage returns into the
        # Streamlit server log.
        con.execute("set enable_progress_bar = false")
        store.configure_duckdb(con)
        return con
    except Exception as exc:
        raise R2Unavailable(CONNECT_ERROR) from exc


def query_df(
    con: duckdb.DuckDBPyConnection,
    sql: str,
    params: list[Any] | None = None,
) -> pd.DataFrame:
    """Run `sql` and return a DataFrame.

    Any failure — an unreachable bucket, an expired token, a missing object —
    becomes `R2Unavailable`, because each renders as the same UI state: the
    section cannot be shown, and the app keeps running.
    """
    try:
        with _LOCK:
            return con.execute(sql, params or []).df()
    except Exception as exc:
        raise R2Unavailable(CONNECT_ERROR) from exc


def read_parquet_expr(uris: list[str]) -> str:
    """A `read_parquet([...])` expression usable anywhere a table name is.

    URIs are built from our own manifest keys, but they are quoted defensively:
    a single stray apostrophe would otherwise be a syntax error at best.
    """
    if not uris:
        raise ValueError("no files to read; the manifest holds no days here")
    quoted = ", ".join("'" + u.replace("'", "''") + "'" for u in uris)
    return f"read_parquet([{quoted}])"
