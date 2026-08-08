"""REGISTRY: every market the workbench knows how to train.

One module per market. Phase 2 lands pitch_result; Phase 7 lands the rest.
"""

from __future__ import annotations

from modeling.spec import MarketSpec

REGISTRY: dict[str, MarketSpec] = {}
