"""The Models page's judgements, shared with the lab doc and the staging gate.

The functions live in modeling/report.py so the dashboard, docs/models/LAB.md
and `python -m modeling stage-v3` read one definition of "what is served" and
"did this run beat its baseline". This module only re-exports them under the
name the page imports; it has to put the repo root on sys.path first because
Streamlit adds dashboard/, not the root.
"""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from modeling.report import (  # noqa: E402,F401
    INERT_TYPES, V3_PIPELINE, fetch_all, fold_frame, live_calibration,
    live_game_record,
    live_stamps, pipeline_of, production, scorecard, unstaged_v3, verdict,
)
