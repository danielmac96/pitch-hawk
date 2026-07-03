"""Request auth for every route.

If API_KEY is set, every request must carry a matching X-API-Key header.
Unset (local dev), auth is skipped but a small per-IP sliding-window rate
limit still applies so an exposed dev instance can't be hammered.
"""

from __future__ import annotations

import time
from collections import deque

from fastapi import HTTPException, Request

from backend.config import API_KEY, RATE_LIMIT_PER_MINUTE

_WINDOW_SECONDS = 60.0
_hits: dict[str, deque[float]] = {}


def _rate_limit(ip: str) -> None:
    now = time.time()
    q = _hits.setdefault(ip, deque())
    while q and now - q[0] > _WINDOW_SECONDS:
        q.popleft()
    if len(q) >= RATE_LIMIT_PER_MINUTE:
        raise HTTPException(429, detail="rate limit exceeded")
    q.append(now)
    # Bound memory: drop stale IPs occasionally.
    if len(_hits) > 10_000:
        stale = [k for k, v in _hits.items() if not v or now - v[-1] > _WINDOW_SECONDS]
        for k in stale:
            _hits.pop(k, None)


async def require_api_key(request: Request) -> None:
    if API_KEY:
        supplied = request.headers.get("x-api-key")
        if supplied != API_KEY:
            raise HTTPException(401, detail="missing or invalid X-API-Key")
        return
    client = request.client
    _rate_limit(client.host if client else "unknown")
