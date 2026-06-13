"""Sportsbook registry for the 'Bet this' affiliate layer.

Config-driven on purpose: affiliate IDs come from env vars (set them once you're
approved by each book / network), and everything else is a plain dict you can
edit without touching route code. Nothing here is secret — affiliate tags are
public tracking params — so the resolved URLs are safe to hand to the frontend.

Reality check baked into the data model: US books rarely expose stable, deep
linkable URLs for a *specific* live pitch/at-bat market. So each book carries an
affiliate-tagged MLB / live-betting *landing* URL (the best we can reliably link
to today). The richer per-event deep link is left as a future field to fill in
once we map game_pk -> each book's internal event id.
"""

from __future__ import annotations

import os

# key -> static config. `landing` is the MLB/live page we route to; `param` is
# the query param that book/network uses for affiliate attribution; `env` is the
# environment variable that holds your affiliate id for that book.
_BOOKS: list[dict] = [
    {
        "key": "draftkings", "name": "DraftKings", "short": "DK",
        "landing": "https://sportsbook.draftkings.com/leagues/baseball/mlb",
        "param": "wpcid", "env": "SPORTSBOOK_AFF_DRAFTKINGS",
    },
    {
        "key": "fanduel", "name": "FanDuel", "short": "FD",
        "landing": "https://sportsbook.fanduel.com/navigation/mlb",
        "param": "btag", "env": "SPORTSBOOK_AFF_FANDUEL",
    },
    {
        "key": "bet365", "name": "bet365", "short": "B365",
        "landing": "https://www.bet365.com/#/AS/B16/",
        "param": "affiliate", "env": "SPORTSBOOK_AFF_BET365",
    },
    {
        "key": "caesars", "name": "Caesars", "short": "CZR",
        "landing": "https://sportsbook.caesars.com/us/bet/baseball",
        "param": "btag", "env": "SPORTSBOOK_AFF_CAESARS",
    },
    {
        "key": "fanatics", "name": "Fanatics", "short": "FAN",
        "landing": "https://sportsbook.fanatics.com/baseball/mlb",
        "param": "btag", "env": "SPORTSBOOK_AFF_FANATICS",
    },
]

DISCLAIMER = (
    "21+ and present in a state where betting is legal. Odds are illustrative and "
    "change constantly at the book — confirm the live price before wagering. Not "
    "financial advice. If you or someone you know has a gambling problem, call "
    "1-800-GAMBLER."
)


def _book_url(landing: str, param: str, aff_id: str | None) -> str:
    """Append the affiliate param to the landing URL when an id is configured.

    Handles the bet365-style fragment URL (params must precede '#') and URLs that
    already carry a query string.
    """
    if not aff_id:
        return landing
    pair = f"{param}={aff_id}"
    base, frag = (landing.split("#", 1) + [""])[:2]
    sep = "&" if "?" in base else "?"
    base = f"{base}{sep}{pair}"
    return f"{base}#{frag}" if frag else base


def get_books() -> list[dict]:
    """Books with affiliate-resolved URLs, in priority order.

    `affiliate_configured` lets the frontend/analytics tell apart real affiliate
    traffic from placeholder links that won't earn until an id is set.
    """
    out: list[dict] = []
    for b in _BOOKS:
        aff_id = os.environ.get(b["env"]) or None
        out.append({
            "key": b["key"],
            "name": b["name"],
            "short": b["short"],
            "url": _book_url(b["landing"], b["param"], aff_id),
            "affiliate_configured": aff_id is not None,
        })
    return out


def registry() -> dict:
    return {"disclaimer": DISCLAIMER, "books": get_books()}
