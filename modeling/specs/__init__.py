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
