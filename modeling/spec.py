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

# Features `_design` builds from the cell grain itself, with no form column.
# Every market gets these for free.
STATIC_FEATURES = frozenset({
    "bias", "balls", "strikes", "two_strikes", "three_balls", "pitch_of_pa",
})

# Every name model.ts::featureValue() branches on. A name outside this set
# scores as 0.0 in production because that switch ends in `default: return 0`,
# so a spec naming one would train a coefficient production never applies.
# tests/modeling/test_parity.py parses the real switch and asserts this list
# matches it, so the two cannot drift.
SCORABLE_FEATURES = frozenset(STATIC_FEATURES | {
    "pitcher_velo", "pitcher_zone_delta", "pitcher_whiff_delta",
    "pitcher_k_delta", "pitcher_bb_delta",
    "pitcher_hr_delta", "pitcher_hit_delta",
    "batter_k_delta", "batter_bb_delta", "batter_chase_delta",
    "batter_contact_delta", "batter_hr_delta", "batter_hit_delta",
    "platoon_same",
})

# The names the legacy single-form-column layout fed from `bucket_col`. Used
# only to derive `form_features` for specs written before it existed; a new
# spec should declare FormFeature directly.
_LEGACY_FORM_FED = frozenset({
    "pitcher_zone_delta", "pitcher_k_delta", "pitcher_velo",
})


@dataclass(frozen=True)
class FormFeature:
    """One bucketed rolling-form column, and the feature it feeds.

    The engine used to carry exactly ONE of these per market, implicitly: every
    pitcher-form name in `_design` read the same array, and every batter-form
    name was hardcoded to zeros. That was survivable while all five markets
    were pitcher-facing and count-driven. A batter market needs at least two
    form dimensions at once -- how the pitcher has been throwing AND how the
    batter has been hitting -- so the relationship is declared per feature
    rather than assumed.

    `cell_sql` divides by `step` to bucket; `_design` recovers the value as
    `baseline + index * step`. `baseline` is 0 for a feature that is already a
    delta and the league centre for one that is absolute (pitch_speed_ou feeds
    model.ts an absolute velocity, not a difference).
    """

    feature: str
    bucket_col: str
    step: float
    baseline: float = 0.0

    def column(self, form_window: str) -> str:
        """The per-window cell column this reads."""
        return f"{form_window}_{self.bucket_col}"


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
    # R2 datasets cell_sql reads. build_cells creates a view per entry and
    # counts only these files in its scan stats, so the reported cost is the
    # cost this market actually incurred rather than a flat guess.
    datasets: tuple[str, ...] = ("pitches",)
    # Rolling-form dimensions, one per feature that varies with a player's
    # recent form. Left empty, it is derived from the legacy
    # bucket_col/bucket_step/bucket_baseline triple so the five markets
    # written before FormFeature existed keep their exact design matrix.
    form_features: tuple[FormFeature, ...] = ()
    # Features read verbatim from a cell column of the same name. Unlike a
    # FormFeature these are not bucketed and not per-window: `platoon_same` is
    # 1 or 0 for a given matchup and has no rolling history to window over.
    cell_features: tuple[str, ...] = ()
    # The class a rate-style market is *about*, when it has one. Names the
    # column calibration is measured on; `pitch_result` has no such class and
    # leaves it None.
    positive_class: str | None = None
    # Acceptable (low, high) for out-of-sample calibration-in-the-large --
    # mean predicted probability over observed rate. None means no veto.
    #
    # Worth having for the same reason SIGMA_BAND is: a model can score well
    # on its primary metric and still be systematically over-confident, and
    # log loss barely moves for a rare class when it is. `ab_result` shipped
    # at ~1.4x the realised rate and was patched at serve time with a constant
    # shrink; a band would have held it instead.
    calibration_band: tuple[float, float] | None = None
    # Form spines this market's cell_sql joins. `python -m modeling build`
    # materializes the union across the markets it is asked for, so a spec
    # that needs the batter side gets it without the CLI knowing which market
    # is which. Empty means the market reads no spine at all.
    spines: tuple[str, ...] = ()
    # Features this market NAMES but whose value the cell grain does not
    # carry, so they enter the fit as zeros and fold into the intercept.
    #
    # Declared rather than inferred, and that is the point. `pitcher_bb_delta`
    # has trained as a hardcoded 0.0 since the first trainer while being
    # computed for real at scoring time -- training and serving disagreeing on
    # one of six features, recorded as a known defect and easy to miss because
    # nothing in the spec said so. Now the spec says so.
    intercept_folded: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.family not in FAMILIES:
            raise ValueError(
                f"unknown family {self.family!r} for market {self.market!r}; "
                f"model.ts scores only {sorted(FAMILIES)}")
        if not self.form_features:
            object.__setattr__(self, "form_features", tuple(
                FormFeature(name, self.bucket_col, self.bucket_step,
                            self.bucket_baseline)
                for name in self.feature_names if name in _LEGACY_FORM_FED))
        self._validate_features()
        if self.family in _NEEDS_CLASSES and not self.classes:
            raise ValueError(
                f"{self.market!r}: family {self.family!r} requires classes")
        if self.metric_direction not in _DIRECTIONS:
            raise ValueError(
                f"{self.market!r}: metric_direction must be one of "
                f"{sorted(_DIRECTIONS)}, got {self.metric_direction!r}")
        if not self.form_windows:
            raise ValueError(f"{self.market!r}: form_windows must not be empty")
        if self.positive_class and self.classes \
                and self.positive_class not in self.classes:
            raise ValueError(
                f"{self.market!r}: positive_class "
                f"{self.positive_class!r} is not one of {list(self.classes)}")
        if self.calibration_band and not self.positive_class:
            raise ValueError(
                f"{self.market!r}: calibration_band needs a positive_class to "
                f"measure calibration against")

    def _validate_features(self) -> None:
        """Every named feature must be scorable, and accounted for exactly once.

        Both halves matter and both fail silently otherwise:

          * a name outside SCORABLE_FEATURES scores 0.0 in production, because
            model.ts::featureValue ends in `default: return 0`. The fit would
            learn a coefficient that is never applied.
          * a name with no form column and no `intercept_folded` entry would
            quietly become zeros, which is exactly how `pitcher_bb_delta` came
            to train as a constant while being computed live.
        """
        named = set(self.feature_names)

        unknown = sorted(named - SCORABLE_FEATURES)
        if unknown:
            raise ValueError(
                f"{self.market!r}: {unknown} are not scored by "
                f"model.ts::featureValue(), which returns 0.0 for names it "
                f"does not know -- the fit would be silently inert in "
                f"production")

        form = [f.feature for f in self.form_features]
        dupes = sorted({f for f in form if form.count(f) > 1})
        if dupes:
            raise ValueError(
                f"{self.market!r}: {dupes} declared as more than one "
                f"FormFeature; the later would silently win")

        stray = sorted((set(form) | set(self.cell_features)) - named)
        if stray:
            raise ValueError(
                f"{self.market!r}: {stray} are declared but not in "
                f"feature_names, so they would never be built")

        folded = set(self.intercept_folded)
        cellf = set(self.cell_features)
        for a, b, label in ((folded, set(form), "intercept_folded"),
                            (cellf, set(form), "cell_features"),
                            (cellf, folded, "cell_features")):
            overlap = sorted(a & b)
            if overlap:
                raise ValueError(
                    f"{self.market!r}: {overlap} declared twice "
                    f"({label} and another kind); pick one")

        unaccounted = sorted(
            named - STATIC_FEATURES - set(form) - folded - cellf)
        if unaccounted:
            raise ValueError(
                f"{self.market!r}: {unaccounted} have no form column and are "
                f"not listed in intercept_folded. Add a FormFeature if the "
                f"cell grain carries them, or list them as intercept_folded "
                f"to record that they train as zero.")


def get_spec(market: str) -> MarketSpec:
    from modeling.specs import REGISTRY
    if market not in REGISTRY:
        raise ValueError(
            f"unknown market {market!r}; expected one of {sorted(REGISTRY)}")
    return REGISTRY[market]


def all_markets() -> tuple[str, ...]:
    from modeling.specs import REGISTRY
    return tuple(sorted(REGISTRY))
