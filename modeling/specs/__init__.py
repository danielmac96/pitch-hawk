"""REGISTRY: every market the workbench knows how to train.

One module per market. The engine never branches on market name -- only on
MarketSpec.family -- so adding a market is adding a file here.
"""

from __future__ import annotations

from modeling.spec import MarketSpec
from modeling.specs import (ab_pitches_ou, ab_result, game_moneyline,
                            pitch_result, pitch_speed_ou)

REGISTRY: dict[str, MarketSpec] = {
    s.market: s for s in (
        pitch_result.SPEC,
        ab_result.SPEC,
        pitch_speed_ou.SPEC,
        ab_pitches_ou.SPEC,
        game_moneyline.SPEC,
    )
}
