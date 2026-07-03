"""Shared vocab: MLB Stats API codes -> normalized descriptions/categories.

Single source of truth for how raw feed values map onto the app's market
outcome spaces:
  * pitch result_category: strike_foul | ball | in_play
  * at-bat result:         strikeout | walk | hit | out
The TypeScript edge functions (supabase/functions/_shared/vocab.ts) mirror
these tables — keep them in sync.
"""

from __future__ import annotations

# details.call.code -> normalized description. Codes per MLB Stats API
# playEvents[].details.call for type == "pitch".
CALL_CODE_TO_DESCRIPTION: dict[str, str] = {
    "B": "ball",
    "*B": "ball",           # ball in dirt
    "I": "ball",            # intentional ball
    "P": "ball",            # pitchout
    "V": "ball",            # automatic ball (pitch clock)
    "H": "hit_by_pitch",
    "C": "called_strike",
    "S": "swinging_strike",
    "W": "swinging_strike",  # swinging strike (blocked)
    "M": "swinging_strike",  # missed bunt
    "Q": "swinging_strike",  # swinging pitchout
    "A": "called_strike",    # automatic strike (pitch clock)
    "F": "foul",
    "T": "foul",             # foul tip
    "L": "foul",             # foul bunt
    "O": "foul",             # foul tip bunt
    "R": "foul",             # foul pitchout
    "X": "in_play",          # in play, out(s)
    "D": "in_play",          # in play, no out
    "E": "in_play",          # in play, run(s)
    "J": "in_play",          # in play (rare)
}

_STRIKE_FOUL = {"called_strike", "swinging_strike", "foul"}
_BALL = {"ball", "hit_by_pitch"}


def result_category(description: str | None) -> str | None:
    """Normalized description -> pitch_result market outcome."""
    if not description:
        return None
    d = description.lower()
    if d in _STRIKE_FOUL:
        return "strike_foul"
    if d in _BALL:
        return "ball"
    if d == "in_play" or d.startswith("in_play"):
        return "in_play"
    # Unmapped raw descriptions (from the fallback path in mlb_api._flatten_pitch).
    if "strike" in d or "foul" in d:
        return "strike_foul"
    if "ball" in d or "pitchout" in d:
        return "ball"
    if "in play" in d or "in_play" in d:
        return "in_play"
    return None


# result.eventType values -> ab_result market outcome.
_AB_HIT = {"single", "double", "triple", "home_run"}
_AB_WALK = {"walk", "intent_walk", "hit_by_pitch"}
_AB_STRIKEOUT = {"strikeout", "strikeout_double_play", "strikeout_triple_play"}
# Everything else that ends a PA counts as a non-K out for market purposes,
# with a handful of PA-enders that are neither (errors, interference) also
# bucketed to "out" — the batter didn't reach on a hit/walk/K.


def ab_result_category(event_type: str | None) -> str | None:
    if not event_type:
        return None
    e = event_type.lower()
    if e in _AB_STRIKEOUT:
        return "strikeout"
    if e in _AB_WALK:
        return "walk"
    if e in _AB_HIT:
        return "hit"
    return "out"
