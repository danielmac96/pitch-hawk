"""ML Pipeline QA Dashboard — health of the Cloudflare R2 Parquet warehouse.

Single page, read-only, internal. It queries R2 in place with DuckDB: nothing is
copied into another database and no Parquet file is written to disk.

The page is built to answer one question first — *is anything wrong right now?*
— and only then to let you look closer:

  * **Overview** reads `_manifest.json` alone (one GET, ~1.5 MB) and therefore
    covers all 2,014 days for free. It reaches a verdict: freshness, volume
    against what the schedule implies, ingest lag, and whether the three
    datasets agree. Row counts alone cannot do this — a light schedule and a
    half-ingested day produce the same low number, which is why volume is judged
    as rows *per game* against each dataset's own trailing baseline.

  * **Deep dive** reads Parquet column chunks over HTTP, bounded by the sidebar
    window (3 days by default). Every section aggregates in SQL; the only raw
    rows that reach pandas are the 100 in the latest-records table.

Colour follows `utils.palette`: series hues for identity, a reserved status
palette for state, always paired with an icon and a label so nothing is carried
by colour alone.

Run it with `streamlit run app.py` from this directory.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from data import queries
from utils import checks, metrics, palette, r2
from utils.duckdb_conn import connect, query_df
from utils.r2 import CONNECT_ERROR, R2Unavailable

PAGE_TITLE = "ML Pipeline QA Dashboard"

# 300s, not 30s. Streamlit re-runs the script on every widget interaction, so a
# 30-second TTL made active browsing re-query R2 roughly twice a minute --
# a larger Class B consumer than the entire training pipeline. Warehouse data
# is written once nightly; sub-minute freshness bought nothing.
CACHE_TTL_SECONDS = 300

# Days shown in the recent-ingestion table — long enough to see a pattern, short
# enough to read at a glance.
RECENT_TABLE_DAYS = 14

# Scan windows for the deep dive. The default is small on purpose: the overview
# already answers the common question without reading any Parquet.
WINDOW_CHOICES: dict[str, int] = {
    "Last 3 days": 3,
    "Last 7 days": 7,
    "Last 14 days": 14,
    "Last 30 days": 30,
}
DEFAULT_WINDOW = "Last 3 days"

# Trailing days plotted in the overview charts.
TREND_CHOICES: dict[str, int] = {"30 days": 30, "90 days": 90, "365 days": 365}
# 30 by default: at 90 the volume chart packs ~90 bars against a stepped
# expected line and the comparison stops being readable, which is the one thing
# that chart exists to make easy.
DEFAULT_TREND = "30 days"

# The lag chart keeps its own short window — see `render_lag`.
LAG_CHART_DAYS = 30

st.set_page_config(page_title=PAGE_TITLE, page_icon="🦅", layout="wide")


# ── cached access ───────────────────────────────────────────────────────────
# Store and connection are process-scoped resources; query results are data with
# a 30-second life. Cached data functions take only hashable arguments and
# re-acquire the resources internally, so a cache entry never holds a live
# connection.


@st.cache_resource(show_spinner=False)
def get_store() -> Any:
    """The R2 store, built once per process. Raises if the bucket is unreachable."""
    return r2.open_store()


@st.cache_resource(show_spinner=False)
def get_connection() -> Any:
    """A DuckDB connection configured for this bucket, built once per process."""
    return connect(get_store())


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def overview_state() -> tuple[dict, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Everything the overview needs, from one manifest GET.

    Returns `(manifest, scored, cross, gaps)`. The scoring — trailing medians,
    robust z scores, per-day statuses — is pure pandas over data already in
    memory, so it rides along with the fetch rather than costing a round trip.
    """
    m = r2.load_manifest(get_store())
    scored = metrics.scored_frame(m, r2.DATASETS)
    cross = metrics.cross_dataset_frame(m)
    gaps = metrics.season_gaps(r2.manifest.days(m, "pitches"))
    return m, scored, cross, gaps


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def scan_null_split(dataset: str, days: tuple[str, ...]) -> pd.DataFrame:
    """Per-column null rate, latest day against the rest of the window."""
    uris = r2.day_uris(get_store(), dataset, list(days))
    return queries.missing_counts_split(get_connection(), uris, dataset, days[-1])


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def scan_violations(dataset: str, days: tuple[str, ...]) -> pd.DataFrame:
    """Counts for every rule a valid feed cannot break."""
    uris = r2.day_uris(get_store(), dataset, list(days))
    return queries.value_violations(get_connection(), uris, dataset, days[-1])


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def scan_categories(dataset: str, days: tuple[str, ...]) -> pd.DataFrame:
    """Value counts for the low-cardinality columns, split latest vs baseline."""
    uris = r2.day_uris(get_store(), dataset, list(days))
    return queries.category_counts(get_connection(), uris, dataset, days[-1])


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def scan_duplicates(dataset: str, days: tuple[str, ...]) -> tuple[int, int]:
    """`(rows, distinct natural keys)` over the window."""
    uris = r2.day_uris(get_store(), dataset, list(days))
    return queries.duplicate_keys(get_connection(), uris, dataset)


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def scan_referential(day: str) -> tuple[int, int]:
    """Pitches on `day` whose game has no row in that day's `games` file."""
    store = get_store()
    return queries.referential_gap(
        get_connection(),
        r2.day_uris(store, "pitches", [day]),
        r2.day_uris(store, "games", [day]),
    )


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def scan_distributions(days: tuple[str, ...]) -> pd.DataFrame:
    """Binned counts for the physics columns, latest day and baseline."""
    uris = r2.day_uris(get_store(), "pitches", list(days))
    return queries.distributions(get_connection(), uris, days[-1])


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def scan_distribution_stats(days: tuple[str, ...]) -> pd.DataFrame:
    """Robust distribution statistics, latest day and baseline."""
    uris = r2.day_uris(get_store(), "pitches", list(days))
    return queries.distribution_stats(get_connection(), uris, days[-1])


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def scan_latest_records(dataset: str, day: str) -> pd.DataFrame:
    """The newest 100 rows of a single day's file."""
    uris = r2.day_uris(get_store(), dataset, [day])
    return queries.latest_records(get_connection(), uris, dataset)


@st.cache_data(ttl=CACHE_TTL_SECONDS, show_spinner=False)
def snapshot_rows() -> int | None:
    """Row count of the players snapshot, or None if it is absent."""
    store = get_store()
    key = r2.snapshot_key("players")
    if not store.exists(key):
        return None
    df = query_df(
        get_connection(),
        f"select count(*) as n from read_parquet('{store.uri(key)}')",
    )
    return int(df.iloc[0]["n"])


# ── helpers ─────────────────────────────────────────────────────────────────


def utc_now() -> pd.Timestamp:
    return pd.Timestamp(datetime.now(timezone.utc))


def fmt_ts(ts: Any) -> str:
    """A timestamp as `YYYY-MM-DD HH:MM UTC`, or an em dash."""
    if ts is None or (not isinstance(ts, (str, pd.Timestamp)) and pd.isna(ts)):
        return "—"
    stamp = pd.Timestamp(ts)
    if pd.isna(stamp):
        return "—"
    stamp = (
        stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")
    )
    return stamp.strftime("%Y-%m-%d %H:%M UTC")


def section_error(exc: Exception) -> None:
    """Render one failed section without taking the rest of the page down."""
    st.error(CONNECT_ERROR)
    with st.expander("Details"):
        st.code(f"{type(exc).__name__}: {exc}\ncause: {exc.__cause__!r}")


def render_check_detail(check: checks.Check) -> None:
    """A failing check's headline, reasoning and the rows behind it."""
    icon = palette.STATUS_ICONS.get(check.status, "?")
    st.markdown(f"**{icon} {check.label}** — {check.headline}")
    if check.detail:
        st.caption(check.detail)
    if check.evidence is not None and not check.evidence.empty:
        st.dataframe(check.evidence, width="stretch", hide_index=True)


def style_status(frame: pd.DataFrame, columns: dict[str, str]) -> Any:
    """Tint cells by the status held in a companion column.

    `columns` maps a displayed column to the column holding its status. The
    status columns themselves are dropped, so the table shows values and the
    colour is the annotation — never the only carrier of meaning, since the
    verdict strip above states the same thing in words.
    """

    def paint(data: pd.DataFrame) -> pd.DataFrame:
        styles = pd.DataFrame("", index=data.index, columns=data.columns)
        for shown, status_col in columns.items():
            if shown in data.columns and status_col in frame.columns:
                styles[shown] = [
                    palette.severity_background(s) for s in frame[status_col]
                ]
        return styles

    return frame.drop(columns=list(columns.values()), errors="ignore").style.apply(
        paint, axis=None
    )


# ── sidebar ─────────────────────────────────────────────────────────────────


def sidebar() -> tuple[str, str, str]:
    """Controls. Returns `(dataset, scan window choice, trend range choice)`."""
    st.sidebar.title("Controls")

    if st.sidebar.button("Refresh Data", type="primary", width="stretch"):
        st.cache_data.clear()
        st.session_state["last_refresh"] = utc_now()
        st.rerun()

    st.sidebar.caption(
        f"Cached for {CACHE_TTL_SECONDS}s · last refresh "
        f"{fmt_ts(st.session_state.get('last_refresh'))}"
    )

    st.sidebar.divider()
    st.sidebar.subheader("Deep dive")
    dataset = st.sidebar.selectbox(
        "Dataset",
        list(r2.DATASETS),
        index=list(r2.DATASETS).index("pitches"),
        help="Scopes the deep-dive sections only. The overview always covers "
        "all three datasets.",
    )
    window = st.sidebar.selectbox(
        "Scan window",
        list(WINDOW_CHOICES),
        index=list(WINDOW_CHOICES).index(DEFAULT_WINDOW),
        help="Days of Parquet the deep dive reads. The newest day is compared "
        "against the rest of the window, so at least 2 days are needed.",
    )

    st.sidebar.divider()
    trend = st.sidebar.selectbox(
        "Overview chart range",
        list(TREND_CHOICES),
        index=list(TREND_CHOICES).index(DEFAULT_TREND),
    )
    st.sidebar.caption(
        "The overview reads the manifest only — full history, one request. "
        "Deep-dive sections read Parquet in place; nothing is downloaded."
    )
    return dataset, window, trend


# ── overview ────────────────────────────────────────────────────────────────


def render_verdict(all_checks: list[checks.Check]) -> None:
    """The hero: one verdict, a chip per check, failures expanded in place."""
    status = checks.overall(all_checks)
    color = palette.STATUS_COLORS[status]
    headline = {
        "pass": "Warehouse healthy",
        "warn": "Warehouse needs a look",
        "fail": "Warehouse failing",
    }[status]

    st.markdown(
        f"<div style='display:flex;align-items:baseline;gap:12px;flex-wrap:wrap'>"
        f"<span style='font-size:30px;font-weight:600;color:{color}'>"
        f"{palette.STATUS_ICONS[status]} {headline}</span>"
        f"<span style='font-size:14px;color:{palette.active().ink_muted}'>"
        f"{checks.summarize(all_checks)}</span></div>",
        unsafe_allow_html=True,
    )
    st.markdown(
        "".join(
            palette.status_chip(c.status, f"{c.label}: {c.headline}")
            for c in sorted(
                all_checks, key=lambda c: metrics.STATUS_RANK.get(c.status, 2)
            )
        ),
        unsafe_allow_html=True,
    )

    flagged = [c for c in all_checks if c.status != "pass"]
    if flagged:
        with st.expander(f"What is flagged ({len(flagged)})", expanded=True):
            for check in flagged:
                render_check_detail(check)
                st.divider()


def render_freshness(scored: pd.DataFrame, now: pd.Timestamp) -> None:
    """Stat tiles for the four numbers that describe the last run."""
    p = palette.active()
    pitches = scored[scored["dataset"] == "pitches"].sort_values("day")

    newest_write = scored["ingested_at"].max()
    hours = (
        None if pd.isna(newest_write) else (now - newest_write).total_seconds() / 3600
    )
    latest_day = max(scored["day"]) if not scored.empty else None
    behind = None if latest_day is None else (now.date() - latest_day).days
    nightly = pitches[~pitches["from_backfill"]].tail(checks.RECENT_DAYS)
    median_lag = nightly["lag_days"].median() if not nightly.empty else float("nan")
    # Matches the verification check's own window, so the tile and the chip
    # cannot disagree — over 30 days this reads 13% purely because the backfill
    # was never verified, which says nothing about last night.
    verified_share = (
        pitches["verified"].tail(checks.VERIFY_LOOKBACK_DAYS).mean()
        if not pitches.empty
        else 0.0
    )

    # Values are kept short — a stat tile clips rather than wraps, and "2026-08-03"
    # at tile size does not survive a quarter-width column.
    c1, c2, c3, c4 = st.columns(4)
    c1.metric(
        "Last write",
        "—" if hours is None else f"{hours:.1f}h",
        help=f"Time since the newest `ingested_at` in the manifest "
        f"({fmt_ts(newest_write)}). Warn past {checks.WRITE_WARN_HOURS:.0f}h.",
    )
    c2.metric(
        "Newest game day",
        # `%-d` is glibc-only and this runs on Windows too.
        "—" if latest_day is None else f"{latest_day:%b} {latest_day.day}",
        delta=None if behind is None else f"{behind}d behind",
        delta_color="off",
        help=f"{latest_day}. The nightly covers through the previous day, so "
        "~2d behind is the resting state.",
    )
    c3.metric(
        "Ingest lag",
        "—" if pd.isna(median_lag) else f"{median_lag:.1f}d",
        help=f"Median over the last {checks.RECENT_DAYS} nightly-written "
        "pitch-days: how long after the games the file appeared. Backfilled "
        "days are excluded — their lag is the age of the history, not a delay.",
    )
    c4.metric(
        f"Verified (last {checks.VERIFY_LOOKBACK_DAYS})",
        f"{verified_share:.0%}",
        help="Share of the most recent pitch-day files independently re-derived "
        "by `warehouse.verify`. The hot-window prune gates its deletes on this.",
    )

    trend = pitches.tail(30)["rows"].tolist()
    if len(trend) > 2:
        with c1:
            st.plotly_chart(
                palette.sparkline(trend, p),
                width="stretch",
                config=palette.plotly_config(),
                key="spark_rows",
            )
            st.caption("pitch rows, last 30 files")


def render_recent_table(scored: pd.DataFrame) -> None:
    """The core artifact: recent days, all three datasets, judged."""
    st.subheader("Recent ingestion")
    st.caption(
        f"The last {RECENT_TABLE_DAYS} day-files per dataset. `rows/game` is "
        "the volume metric — raw rows swing with the schedule, so a light slate "
        "and a half-ingested day look identical until the games are divided "
        "out. `expected` is that dataset's trailing median rows-per-game times "
        "the games played. Cells are tinted where the day is off its baseline."
    )

    recent = (
        scored.sort_values("day")
        .groupby("dataset", sort=False)
        .tail(RECENT_TABLE_DAYS)
        .sort_values(["day", "dataset"], ascending=[False, True])
    )
    shown = pd.DataFrame(
        {
            "day": recent["day"],
            "dataset": recent["dataset"],
            "rows": recent["rows"],
            "expected": recent["expected_rows"].round(0),
            "games": recent["games"],
            "rows/game": recent["rows_per_game"].round(1),
            "vs base %": recent["rows_per_game_rel_pct"].astype(float).round(1),
            "bytes/row": recent["bytes_per_row"].round(1),
            "lag (d)": recent["lag_days"].round(2),
            "verified": recent["verified"],
            "_rows_status": recent["rows_per_game_status"],
            "_bytes_status": recent["bytes_per_row_status"],
            "_lag_status": recent["lag_days_status"],
        }
    )
    styler = style_status(
        shown,
        {
            "rows/game": "_rows_status",
            "vs base %": "_rows_status",
            "rows": "_rows_status",
            "bytes/row": "_bytes_status",
            "lag (d)": "_lag_status",
        },
    ).format(
        {
            "rows": "{:,.0f}",
            "expected": "{:,.0f}",
            "rows/game": "{:,.1f}",
            "vs base %": "{:+.1f}%",
            "bytes/row": "{:,.1f}",
            "lag (d)": "{:.2f}",
        },
        na_rep="—",
    )
    st.dataframe(styler, width="stretch", height=430, hide_index=True)


def render_volume(scored: pd.DataFrame, dataset: str, trend_days: int) -> None:
    """Actual rows against the volume the schedule implies."""
    p = palette.active()
    frame = scored[scored["dataset"] == dataset].sort_values("day").tail(trend_days)
    if frame.empty:
        st.info(f"No days for `{dataset}`.")
        return

    # Fill the calendar so a day with no file is a break in the expected line
    # rather than a level drawn straight across it — otherwise the All-Star
    # break reads as "expected 4,400, delivered nothing".
    calendar = pd.date_range(frame["day"].min(), frame["day"].max(), freq="D").date
    frame = (
        frame.set_index("day")
        .reindex(calendar)
        .rename_axis("day")
        .reset_index()
        .assign(rows_per_game_status=lambda d: d["rows_per_game_status"].fillna("pass"))
    )

    colors = [
        p.status[s] if s in ("warn", "fail") else p.series[0]
        for s in frame["rows_per_game_status"]
    ]
    fig = go.Figure()
    fig.add_trace(
        go.Bar(
            x=frame["day"],
            y=frame["rows"],
            marker_color=colors,
            name="rows",
            hovertemplate="%{x}<br>%{y:,.0f} rows<extra></extra>",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=frame["day"],
            y=frame["expected_rows"],
            mode="lines",
            # Stepped, not connected: expected is a level per day, and drawing
            # it as a slope between days invents a trend the schedule does not
            # have.
            line={"width": 2, "color": p.expected, "shape": "hv"},
            name="expected (games × baseline rows/game)",
            hovertemplate="%{x}<br>%{y:,.0f} expected<extra></extra>",
        )
    )
    last = frame[frame["rows"].notna()].iloc[-1]
    fig.add_annotation(
        x=last["day"],
        y=last["rows"],
        text=f"{int(last['rows']):,}",
        showarrow=False,
        yshift=12,
        xanchor="right",
        font={"size": 11, "color": p.ink_secondary},
    )
    palette.style(fig, p, height=300, legend=True)
    st.plotly_chart(fig, width="stretch", config=palette.plotly_config())
    st.caption(
        f"`{dataset}` · bars turn amber or red where rows-per-game leaves the "
        f"trailing {metrics.BASELINE_DAYS}-day baseline by more than "
        f"{metrics.REL_FLOOR_PCT:g}% and {metrics.Z_WARN} robust z."
    )
    with st.expander("Table view"):
        st.dataframe(
            frame[frame["rows"].notna()][
                [
                    "day",
                    "rows",
                    "expected_rows",
                    "games",
                    "rows_per_game",
                    "rows_per_game_rel_pct",
                    "rows_per_game_status",
                ]
            ].sort_values("day", ascending=False),
            width="stretch",
            hide_index=True,
        )


def render_lag(scored: pd.DataFrame, dataset: str, trend_days: int) -> None:
    """How long after the games each file appeared, by write regime.

    Backfilled days are plotted separately and greyed: a 2026 pass covering 2015
    has a lag of eleven years, which is correct and says nothing about whether
    the nightly is keeping up. Drawn as one series it swamps the axis and buries
    the only part anyone acts on.
    """
    p = palette.active()
    # Lag is an operational metric about the last few runs, so it gets a short
    # window regardless of the trend range: over 90 days the nightly's handful
    # of points would be squeezed into the last tenth of the axis.
    frame = (
        scored[scored["dataset"] == dataset]
        .sort_values("day")
        .tail(min(trend_days, LAG_CHART_DAYS))
    )
    if frame.empty:
        return

    nightly = frame[~frame["from_backfill"]]
    backfilled = frame[frame["from_backfill"]]

    fig = go.Figure()
    if not backfilled.empty:
        fig.add_trace(
            go.Scatter(
                x=backfilled["day"],
                y=backfilled["lag_days"],
                mode="markers",
                marker={"size": 4, "color": p.expected},
                name=f"backfilled ({len(backfilled)} days)",
                hovertemplate="%{x}<br>%{y:.1f} days (backfill)<extra></extra>",
            )
        )
    fig.add_trace(
        go.Scatter(
            x=nightly["day"],
            y=nightly["lag_days"],
            mode="lines+markers",
            line={"width": 2, "color": p.series[0]},
            marker={"size": 6},
            name=f"nightly ({len(nightly)} days)",
            hovertemplate="%{x}<br>%{y:.2f} days<extra></extra>",
        )
    )
    fig.add_hline(
        y=metrics.LAG_WARN_DAYS,
        line={"width": 1, "color": p.status["warn"]},
        annotation_text=f"warn {metrics.LAG_WARN_DAYS:g}d",
        annotation_position="top left",
        annotation_font={"size": 10, "color": p.ink_muted},
    )
    palette.style(fig, p, height=260, legend=True)
    fig.update_yaxes(title="days")
    # The nightly's range is the readable one; backfilled points sit far above
    # it and are allowed to run off the top rather than flattening the series
    # anyone acts on.
    if not nightly.empty:
        fig.update_yaxes(
            range=[0, max(metrics.LAG_FAIL_DAYS + 1, nightly["lag_days"].max() * 1.3)]
        )
    st.plotly_chart(fig, width="stretch", config=palette.plotly_config())
    st.caption(
        f"A write batch covering more than {metrics.BACKFILL_BATCH_FILES} "
        "dataset-days is a backfill, not a nightly — the 2026-07-31 pass wrote "
        "2,011 days per dataset in minutes. Those days are shown but never "
        f"judged; the rule applies to the last {metrics.LAG_JUDGE_DAYS} "
        "nightly-written days."
    )


def render_cross(cross: pd.DataFrame, trend_days: int) -> None:
    """The three datasets, checked against each other."""
    st.subheader("Cross-dataset agreement")
    st.caption(
        "Ratios between the three datasets are properties of baseball, not of "
        "the pipeline: ~3.9 pitches per plate appearance, ~75 plate appearances "
        "per game. A move outside the shaded band means rows are missing on one "
        "side — the failure no single dataset can show."
    )
    p = palette.active()
    frame = cross.sort_values("day").tail(trend_days)

    specs = (
        ("pitches_per_pa", "pitches per plate appearance", checks.PITCHES_PER_PA_RANGE),
        ("pa_per_game", "plate appearances per game", checks.PA_PER_GAME_RANGE),
    )
    cols = st.columns(2)
    for col, (metric, label, band) in zip(cols, specs):
        fig = go.Figure()
        fig.add_hrect(
            y0=band[0], y1=band[1], fillcolor=p.band, line_width=0, layer="below"
        )
        fig.add_trace(
            go.Scatter(
                x=frame["day"],
                y=frame[metric],
                mode="lines",
                line={"width": 2, "color": p.series[0]},
                name=label,
                hovertemplate="%{x}<br>%{y:.2f}<extra></extra>",
            )
        )
        palette.style(fig, p, height=230, title=label)
        # Give the band air on both sides, or it fills the plot and reads as the
        # background rather than as the range the series should stay inside.
        margin = 0.25 * (band[1] - band[0])
        fig.update_yaxes(range=[band[0] - margin, band[1] + margin])
        with col:
            st.plotly_chart(
                fig, width="stretch", config=palette.plotly_config(), key=f"x_{metric}"
            )

    problems = frame[(frame["missing"] != "") | (~frame["games_agree"])]
    if problems.empty:
        st.caption(
            f"✓ All three datasets present and agreeing on game counts across "
            f"the last {len(frame)} days."
        )
    else:
        st.warning(
            f"{len(problems)} day(s) where a dataset is missing or the game "
            "counts disagree."
        )
        st.dataframe(problems, width="stretch", hide_index=True)


# ── deep dive ───────────────────────────────────────────────────────────────


def render_column_health(dataset: str, days: list[str]) -> None:
    """Null rates that moved against the baseline window."""
    st.subheader("Column health")
    split = scan_null_split(dataset, tuple(days))
    movers = checks.null_movers(split, dataset)
    st.caption(
        f"Null rate on {days[-1]} against {days[0]} … {days[-2]}. The absolute "
        "rate is rarely the question — `on_third` is 91% null every day by "
        "design — so only columns that *moved* by more than "
        f"{checks.NULL_MOVE_WARN_PP:g}pp are shown. Structural nulls are "
        "listed but never flagged."
    )

    if movers.empty:
        st.success("No column moved against its baseline.")
    else:
        p = palette.active()
        fig = go.Figure(
            go.Bar(
                x=movers["delta_pp"],
                y=movers["column"],
                orientation="h",
                marker_color=[
                    p.status[s] if s in ("warn", "fail") else p.series[2]
                    for s in movers["status"]
                ],
                hovertemplate="%{y}<br>%{x:+.2f}pp<extra></extra>",
            )
        )
        palette.style(fig, p, height=max(180, 28 * len(movers) + 60))
        fig.update_xaxes(title="change in null rate (pp)")
        st.plotly_chart(fig, width="stretch", config=palette.plotly_config())
        st.dataframe(
            movers.style.format(
                {
                    "baseline_pct": "{:.2f}%",
                    "latest_pct": "{:.2f}%",
                    "delta_pp": "{:+.2f}",
                }
            ),
            width="stretch",
            hide_index=True,
        )

    with st.expander("All columns, absolute null rate"):
        st.dataframe(
            split.style.format(
                {
                    "latest_pct": "{:.2f}%",
                    "baseline_pct": "{:.2f}%",
                    "latest_rows": "{:,.0f}",
                    "baseline_rows": "{:,.0f}",
                }
            ),
            width="stretch",
            height=400,
            hide_index=True,
        )


def render_value_sanity(dataset: str, days: list[str]) -> None:
    """Impossible values and category-set changes."""
    st.subheader("Value sanity")
    violations = scan_violations(dataset, tuple(days))
    frame = checks.rule_movement(violations)
    st.caption(
        "Rules a valid feed cannot break, scored by movement: a rule firing for "
        "the first time today is new breakage, one firing at its usual rate is "
        "a known defect. Both are shown; only the first is a failure."
    )
    if frame.empty:
        st.info(f"No rules defined for `{dataset}`.")
    else:
        firing = frame[frame["status"] != "pass"]
        if firing.empty:
            st.success(f"All {len(frame)} rules clean on {days[-1]}.")
        else:
            st.dataframe(
                firing.style.format(
                    {
                        "latest": "{:,.0f}",
                        "baseline": "{:,.0f}",
                        "latest_rate": "{:.2f}%",
                        "baseline_rate": "{:.2f}%",
                    }
                ),
                width="stretch",
                hide_index=True,
            )
        with st.expander("All rules"):
            st.dataframe(
                frame[
                    [
                        "rule",
                        "latest",
                        "baseline",
                        "latest_rate",
                        "baseline_rate",
                        "status",
                    ]
                ],
                width="stretch",
                hide_index=True,
            )

    counts = scan_categories(dataset, tuple(days))
    diff = checks.category_diff(counts)
    st.markdown("**Category sets**")
    if diff.empty:
        st.success(
            "Every value seen on the latest day also appears in the baseline, "
            "and nothing with real baseline support has disappeared."
        )
    else:
        st.warning(f"{len(diff)} category value(s) appeared or vanished.")
        st.dataframe(diff, width="stretch", hide_index=True)
    with st.expander("All category values"):
        st.dataframe(counts, width="stretch", height=360, hide_index=True)


def render_distributions(days: list[str]) -> None:
    """Latest day's shape against the baseline's, plus robust statistics."""
    st.subheader("Distributions")
    st.caption(
        "The latest day (filled) against the rest of the window (outline), each "
        "normalised to its own share so different sample sizes compare. Binned "
        "in DuckDB — only bin counts cross the wire. Axes are fixed, so a shift "
        "is visible rather than rescaled away. Warehouse names: `start_speed` "
        "is pitch speed, `launch_speed` is exit velocity."
    )
    df = scan_distributions(tuple(days))
    if df.empty:
        st.info("No values in the scanned window.")
        return

    p = palette.active()
    cols = st.columns(2)
    for i, metric_name in enumerate(queries.HISTOGRAMS):
        part = df[df["metric"] == metric_name]
        with cols[i % 2]:
            if part.empty or part["count"].sum() == 0:
                st.info(f"`{metric_name}` — no values in the window.")
                continue
            lo, hi, _ = queries.HISTOGRAMS[metric_name]
            fig = go.Figure()
            for series, color, fill in (
                ("baseline", p.expected, None),
                ("latest", p.series[0], "tozeroy"),
            ):
                s = part[part["series"] == series]
                if s.empty:
                    continue
                total = s["count"].sum()
                fig.add_trace(
                    go.Scatter(
                        x=s["bin_start"],
                        y=100.0 * s["count"] / total,
                        mode="lines",
                        line={"width": 2, "color": color, "shape": "hv"},
                        fill=fill,
                        fillcolor=(
                            "rgba(42,120,214,0.18)" if series == "latest" else None
                        ),
                        name=f"{series} (n={int(total):,})",
                        hovertemplate="%{x:.1f}<br>%{y:.2f}%<extra></extra>",
                    )
                )
            palette.style(fig, p, height=250, legend=True, title=metric_name)
            fig.update_xaxes(range=[lo, hi])
            fig.update_yaxes(title="% of values")
            st.plotly_chart(
                fig,
                width="stretch",
                config=palette.plotly_config(),
                key=f"dist_{metric_name}",
            )

    stats = scan_distribution_stats(tuple(days))
    if stats.empty:
        return
    base = stats[stats["series"] == "baseline"].drop(columns=["series"])
    now = stats[stats["series"] == "latest"].drop(columns=["series"])
    drift = metrics.metric_drift(base, now)
    st.markdown("**Shift in the latest day**")
    st.caption(
        "Medians rather than means, and the move expressed in the baseline's "
        "own spread (`shift_mad`, an IQR-based robust σ) as well as in percent "
        "— a 1 mph move means something different for release velocity than for "
        "exit velocity."
    )
    st.dataframe(
        drift[
            [
                "metric",
                "median_base",
                "median_latest",
                "change_pct",
                "shift_mad",
                "p05_latest",
                "p95_latest",
                "null_pct_latest",
                "n_latest",
                "status",
            ]
        ].style.format(
            {
                "median_base": "{:,.2f}",
                "median_latest": "{:,.2f}",
                "change_pct": "{:+.2f}%",
                "shift_mad": "{:+.2f}σ",
                "p05_latest": "{:,.1f}",
                "p95_latest": "{:,.1f}",
                "null_pct_latest": "{:.1f}%",
                "n_latest": "{:,.0f}",
            },
            na_rep="—",
        ),
        width="stretch",
        hide_index=True,
    )


def render_integrity(dataset: str, days: list[str]) -> None:
    """Key uniqueness and referential integrity."""
    st.subheader("Integrity")
    rows, distinct = scan_duplicates(dataset, tuple(days))
    dupes = rows - distinct
    orphans, orphan_games = scan_referential(days[-1])

    c1, c2, c3 = st.columns(3)
    c1.metric(f"`{dataset}` rows scanned", f"{rows:,}")
    c2.metric(
        "Duplicate keys",
        f"{dupes:,}",
        delta=None if dupes == 0 else f"{dupes:,}",
        delta_color="inverse",
    )
    c3.metric(
        "Orphan pitches",
        f"{orphans:,}",
        delta=None if orphans == 0 else f"{orphan_games} game(s)",
        delta_color="inverse",
    )
    st.caption(
        f"Natural key for `{dataset}`: ({', '.join(r2.KEY_COLUMNS[dataset])}) — "
        "the key the export checksum is built from. Orphans are pitches on "
        f"{days[-1]} whose `game_pk` has no row in that day's `games` file."
    )
    if dupes or orphans:
        st.error(
            "Integrity broken: a day written twice produces duplicate keys, and "
            "a missing or partial `games` file produces orphans."
        )
    else:
        st.success("Keys unique and every pitch resolves to a game.")


def render_latest_records(dataset: str, days: list[str]) -> None:
    """The newest 100 rows, filterable."""
    st.subheader("Latest records")
    day = days[-1]
    df = scan_latest_records(dataset, day)
    term = st.text_input(
        "Search",
        key="latest_search",
        placeholder="Filter the 100 rows below (case-insensitive)",
    )
    shown = df
    if term:
        mask = df.astype(str).apply(
            lambda col: col.str.contains(term, case=False, na=False)
        )
        shown = df[mask.any(axis=1)]
    st.caption(
        f"Newest {len(df)} rows of `{dataset}` for {day} ({len(shown)} shown). "
        "Sortable by column, scrollable."
    )
    st.dataframe(shown, width="stretch", height=400, hide_index=True)


def render_inventory(m: dict) -> None:
    """Every Parquet object, newest first."""
    st.subheader("File inventory")
    st.caption(
        "Read from `_manifest.json`, not from a bucket listing: the scoped R2 "
        "token has no LIST permission, so `ListObjectsV2` returns AccessDenied "
        "and a bucket listing would report the warehouse as empty. `modified` "
        "is the ingest time recorded when the object was written."
    )

    rows: list[dict] = []
    for ds in r2.DATASETS:
        for day, entry in m.get("datasets", {}).get(ds, {}).items():
            rows.append(
                {
                    "file": r2.object_key(ds, day),
                    "dataset": ds,
                    "size": metrics.human_bytes(entry.get("bytes")),
                    "bytes": entry.get("bytes", 0),
                    "rows": entry.get("rows", 0),
                    "modified": entry.get("ingested_at"),
                    "verified": bool(
                        entry.get("verified_at") and entry.get("verified_by")
                    ),
                }
            )

    df = pd.DataFrame(
        rows,
        columns=["file", "dataset", "size", "bytes", "rows", "modified", "verified"],
    )
    if df.empty:
        st.warning("The manifest indexes no files.")
        return
    df = df.sort_values("modified", ascending=False, ignore_index=True)

    try:
        snapshot = snapshot_rows()
    except R2Unavailable:
        snapshot = None
    if snapshot is not None:
        st.caption(
            f"Plus `{r2.snapshot_key('players')}` — {snapshot:,} rows. The "
            "snapshot is rewritten in full each run and carries no manifest "
            "entry, so it has no recorded size or write time."
        )

    st.dataframe(
        df.drop(columns=["bytes"]), width="stretch", height=400, hide_index=True
    )
    st.caption(
        f"{len(df):,} files · {metrics.human_bytes(df['bytes'].sum())} · "
        f"{int(df['verified'].sum()):,} independently verified"
    )


# ── page ────────────────────────────────────────────────────────────────────


def render_overview(
    scored: pd.DataFrame,
    cross: pd.DataFrame,
    gaps: pd.DataFrame,
    now: pd.Timestamp,
    trend: str,
) -> None:
    """Everything that costs nothing but the manifest."""
    manifest_checks = checks.manifest_checks(scored, cross, gaps, now)
    render_verdict(manifest_checks)
    st.divider()
    render_freshness(scored, now)
    st.divider()
    render_recent_table(scored)
    st.divider()

    trend_days = TREND_CHOICES[trend]
    st.subheader("Volume and lag")
    chart_dataset = st.radio(
        "Dataset for the charts below",
        list(r2.DATASETS),
        horizontal=True,
        label_visibility="collapsed",
        key="chart_dataset",
    )
    render_volume(scored, chart_dataset, trend_days)
    render_lag(scored, chart_dataset, trend_days)
    st.divider()
    render_cross(cross, trend_days)


def render_deep_dive(dataset: str, days: list[str]) -> None:
    """Everything that reads Parquet, each section isolated from the others."""
    st.header("Deep dive")
    st.caption(
        f"Scanning `{dataset}` over {days[0]} → {days[-1]} ({len(days)} days). "
        "The newest day is compared against the rest of the window."
    )
    for render, args in (
        (render_column_health, (dataset, days)),
        (render_value_sanity, (dataset, days)),
        (render_distributions, (days,)),
        (render_integrity, (dataset, days)),
        (render_latest_records, (dataset, days)),
    ):
        try:
            render(*args)
        except R2Unavailable as exc:
            section_error(exc)
        st.divider()


def main() -> None:
    """Render the page. Any R2 failure becomes a message, never a traceback."""
    st.title(PAGE_TITLE)
    st.caption(
        "Read-only QA over the Cloudflare R2 Parquet warehouse. DuckDB queries "
        "the bucket in place; no data is copied anywhere."
    )

    # Set before the sidebar renders it, or the first paint shows an em dash.
    st.session_state.setdefault("last_refresh", utc_now())
    dataset, window, trend = sidebar()
    now = utc_now()

    try:
        m, scored, cross, gaps = overview_state()
    except R2Unavailable as exc:
        st.error(CONNECT_ERROR)
        with st.expander("Details"):
            st.code(f"{type(exc).__name__}: {exc}\ncause: {exc.__cause__!r}")
        st.info(
            "Check `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` "
            "and `R2_BUCKET`. A wrong bucket name returns HTTP 403 on every "
            "object rather than 404."
        )
        return

    if scored.empty:
        st.warning("The manifest indexes no dataset-days.")
        return

    render_overview(scored, cross, gaps, now, trend)
    st.divider()

    all_days = r2.manifest.days(m, dataset)
    if not all_days:
        st.warning(f"The manifest holds no days for `{dataset}`.")
        return
    days = all_days[-WINDOW_CHOICES[window] :]
    if len(days) < 2:
        st.info("Widen the scan window to at least two days for the deep dive.")
        return

    render_deep_dive(dataset, days)

    try:
        render_inventory(m)
    except R2Unavailable as exc:
        section_error(exc)


main()
