"""Colour tokens and the Plotly template every chart is drawn with.

No chart in this app picks its own colour. Four jobs, four rules:

  * **Categorical** — identity. Slots are assigned in fixed order and never
    cycled; a series keeps its hue when a filter removes its neighbours.
  * **Sequential** — magnitude. One hue, light to dark.
  * **Status** — state. Reserved: `good`/`warning`/`serious`/`critical` never
    stand in for "series 4", and are always rendered as icon + label + colour,
    never colour alone, because two of them sit below 3:1 on a light surface.
  * **Ink / grid** — chrome. Recessive, solid hairlines, never dashed.

The three categorical slots were validated with the data-viz skill's
`validate_palette.js --pairs all` in both modes: PASS on the lightness band,
chroma floor, colour-vision separation (worst ΔE 9.2 light / 9.4 dark against a
floor of 8) and the normal-vision floor (24.0 / 20.9 against 15). Light-mode
aqua is a contrast WARN at 2.74:1, which obliges *relief*: every chart here also
carries direct labels and a table twin, so no value is reachable by colour
alone.

Streamlit renders in the viewer's theme, so both modes are declared and picked
at render time rather than one being flipped from the other.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import plotly.graph_objects as go
import streamlit as st

# Status tokens are mode-invariant by design: the same four steps clear 3:1 on
# the dark surface and are deliberately distinct from the categorical slots so a
# status colour can never impersonate a series.
STATUS_COLORS: dict[str, str] = {
    "pass": "#0ca30c",
    "warn": "#fab219",
    "serious": "#ec835a",
    "fail": "#d03b3b",
}

# The other half of every status: hue never carries the meaning on its own.
STATUS_ICONS: dict[str, str] = {"pass": "✓", "warn": "!", "fail": "✕"}
STATUS_LABELS: dict[str, str] = {"pass": "OK", "warn": "Watch", "fail": "Failing"}

# Worst-first. `overall()` and every sort in the UI use this order.
STATUS_ORDER: dict[str, int] = {"fail": 0, "warn": 1, "pass": 2}


@dataclass(frozen=True)
class Palette:
    """Every colour role one theme needs."""

    mode: str
    surface: str
    plane: str
    ink: str
    ink_secondary: str
    ink_muted: str
    grid: str
    axis: str
    series: tuple[str, str, str]
    band: str
    expected: str

    @property
    def status(self) -> dict[str, str]:
        return STATUS_COLORS


LIGHT = Palette(
    mode="light",
    surface="#fcfcfb",
    plane="#f9f9f7",
    ink="#0b0b0b",
    ink_secondary="#52514e",
    ink_muted="#898781",
    grid="#e1e0d9",
    axis="#c3c2b7",
    series=("#2a78d6", "#eb6834", "#1baf7a"),
    # The de-emphasis gray of the emphasis form: context marks the reader is
    # meant to look past.
    band="rgba(137,135,129,0.18)",
    expected="#898781",
)

DARK = Palette(
    mode="dark",
    surface="#1a1a19",
    plane="#0d0d0d",
    ink="#ffffff",
    ink_secondary="#c3c2b7",
    ink_muted="#898781",
    grid="#2c2c2a",
    axis="#383835",
    series=("#3987e5", "#d95926", "#199e70"),
    band="rgba(137,135,129,0.24)",
    expected="#898781",
)

FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif'


def theme() -> str:
    """`"dark"` or `"light"`, following the viewer's Streamlit theme.

    `st.context.theme` is recent and not present in every deployment, so a
    missing attribute falls back to light rather than raising.
    """
    ctx = getattr(st, "context", None)
    ctx_theme = getattr(ctx, "theme", None)
    kind = getattr(ctx_theme, "type", None)
    return "dark" if kind == "dark" else "light"


def active() -> Palette:
    """The palette for the current theme."""
    return DARK if theme() == "dark" else LIGHT


def style(
    fig: go.Figure,
    p: Palette,
    *,
    height: int = 300,
    legend: bool = False,
    title: str | None = None,
) -> go.Figure:
    """Apply the shared chart chrome: recessive grid, transparent surface, sans.

    Height includes the x-axis band — a fixed height that fits only the plot
    leaves the axis labels in a nested scrollbar.
    """
    # `title=None` is not "no title" to Plotly — it renders the string
    # "undefined" into the SVG — so the key is omitted entirely instead.
    fig.update_layout(
        height=height,
        margin={"l": 8, "r": 8, "t": 34 if title else 8, "b": 8},
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font={"family": FONT_FAMILY, "color": p.ink_secondary, "size": 12},
        hoverlabel={"font": {"family": FONT_FAMILY, "size": 12}},
        showlegend=legend,
        legend={
            "orientation": "h",
            "yanchor": "bottom",
            "y": 1.0,
            "x": 0,
            "bgcolor": "rgba(0,0,0,0)",
        },
        bargap=0.15,
    )
    axis = {
        "showgrid": True,
        "gridcolor": p.grid,
        "gridwidth": 1,
        "zeroline": False,
        "linecolor": p.axis,
        "tickfont": {"color": p.ink_muted, "size": 11},
        "title": {"font": {"color": p.ink_muted, "size": 11}},
    }
    if title:
        fig.update_layout(title={"text": title, "font": {"size": 13}})
    fig.update_xaxes(**{**axis, "showgrid": False})
    fig.update_yaxes(**axis)
    return fig


def sparkline(
    values: list[float], p: Palette, *, color: str | None = None, height: int = 44
) -> go.Figure:
    """A bare trend line for a stat tile: no axes, no grid, no hover chrome."""
    fig = go.Figure(
        go.Scatter(
            y=values,
            mode="lines",
            line={"width": 2, "color": color or p.series[0]},
            hoverinfo="skip",
        )
    )
    fig.update_layout(
        height=height,
        margin={"l": 0, "r": 0, "t": 0, "b": 0},
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        showlegend=False,
        xaxis={"visible": False},
        yaxis={"visible": False},
    )
    return fig


def status_chip(status: str, label: str) -> str:
    """Markdown for one verdict chip — icon, label and colour together."""
    color = STATUS_COLORS.get(status, STATUS_COLORS["warn"])
    icon = STATUS_ICONS.get(status, "?")
    return (
        f"<span style='display:inline-block;padding:2px 10px;margin:2px 4px 2px 0;"
        f"border-radius:999px;border:1px solid {color};color:{color};"
        f"font-size:12px;font-family:{FONT_FAMILY};white-space:nowrap'>"
        f"{icon}&nbsp;{label}</span>"
    )


def severity_background(status: str) -> str:
    """A pandas Styler background for a cell at this severity.

    Tinted rather than saturated: a table of solid status blocks reads as an
    alarm even when nothing is wrong.
    """
    if status == "fail":
        return "background-color: rgba(208,59,59,0.20)"
    if status == "warn":
        return "background-color: rgba(250,178,25,0.22)"
    return ""


def plotly_config() -> dict[str, Any]:
    """Chart toolbar: keep it out of the way, keep the image export."""
    return {"displaylogo": False, "modeBarButtonsToRemove": ["lasso2d", "select2d"]}
