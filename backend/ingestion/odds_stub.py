"""Placeholder DraftKings odds + edge calculator."""

# TODO: replace with DraftKings API or scraper

_STUB_ODDS: list[dict] = [
    {"market": "pitch_speed_ou", "line": 92.5, "over_price": -115, "under_price": -105},
    {"market": "pitch_result",   "line": None, "over_price": None, "under_price": None},
    {"market": "ab_result",      "line": None, "over_price": None, "under_price": None},
    {"market": "ab_pitches_ou",  "line": 3.5,  "over_price": -120, "under_price": 100},
]


def get_odds(game_pk: int) -> list[dict]:
    return [{**o, "game_pk": game_pk, "source": "draftkings_stub"} for o in _STUB_ODDS]


def implied_probability(american_odds: int) -> float:
    if american_odds >= 0:
        return 100.0 / (american_odds + 100.0)
    return abs(american_odds) / (abs(american_odds) + 100.0)


def calculate_edge(predicted_prob: float, american_odds: int) -> float:
    """Positive = value bet for the side priced at american_odds."""
    return predicted_prob - implied_probability(american_odds)
