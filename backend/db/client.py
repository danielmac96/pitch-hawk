"""Supabase client wrapper."""

import os
from functools import lru_cache

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()


@lru_cache(maxsize=1)
def get_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_KEY must be set in .env")
    return create_client(url, key)


def upsert_live_state(game_pk: int, payload: dict) -> None:
    row = {"game_pk": game_pk, **payload}
    get_client().table("live_state").upsert(row, on_conflict="game_pk").execute()


def upsert_at_bats(rows: list[dict]) -> None:
    if not rows:
        return
    get_client().table("at_bats").upsert(rows, on_conflict="game_pk,at_bat_index").execute()
