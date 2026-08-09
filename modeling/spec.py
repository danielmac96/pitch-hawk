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
#
# NOTE on "log5": unlike the other three, model.ts has no `type === "log5"`
# branch -- game-predict/index.ts calls log5HomeProb() with its default
# homeAdv and never reads model_params. A fitted game_moneyline row is
# therefore recorded and versioned here but inert in production until the
# edge function is taught to read it. See docs/MODELS.md.
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
    # Width of one form bucket, in the feature's own units. The cell SQL divides
    # by it to bucket; _design multiplies by it to recover the delta. It lives
    # on the spec rather than in the engine because it differs per market
    # (0.03 zone-rate for pitch_result, 0.035 k-rate for ab_result) -- reading
    # it from the spec is what keeps _design from branching on market name.
    bucket_step: float = 0.03
    # Suffix of the per-window bucket column in the cell table, and the value
    # the bucket index is centred on. Together with bucket_step these let one
    # generic _design() serve every family: it recovers the feature as
    # `bucket_baseline + bucket_index * bucket_step`. Markets whose feature is
    # a delta leave the baseline at 0; pitch_speed_ou centres on LEAGUE.avg_speed
    # because model.ts feeds scoreLinear an absolute velocity, not a delta.
    bucket_col: str = "zone_bucket"
    bucket_baseline: float = 0.0

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
