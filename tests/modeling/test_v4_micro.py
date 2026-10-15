"""The v4 micro frames and daily sources run against a real local warehouse.

The fixture is two games ingested from tests/fixtures/playbyplay_sample.json
by the real ingest path, so the SQL meets the real Parquet schema: column
names, types, the manifest -- what a synthetic frame cannot check.
"""

from __future__ import annotations

import numpy as np

from modeling.v4 import catalog as C
from modeling.v4 import feats as F
from modeling.v4 import micro
from modeling.v4 import storage as S
from tests.warehouse.test_ingest_roundtrip import DAY, pbp, store, stub_api  # noqa: F401
from warehouse import ingest


def test_sources_and_micro_frames_build(store, stub_api):  # noqa: F811
    ingest.ingest_day(store, DAY)
    src = F.load_sources(store)
    assert {"pitcher_day", "batter_day", "ump_day", "games", "pa_start"} <= set(src)
    assert src["pitcher_day"]["n"].sum() > 0

    micro.build_micro_frames(store, [2026])
    pitch = S.get_frame(store, "pitch")
    assert len(pitch) > 0
    assert set(pitch["y_pitch"].dropna().unique()) <= {0, 1, 2}
    feats = set(C.get("pitch_result").features)
    missing = feats - set(pitch.columns)
    assert not missing, missing
    # The first pitch of every PA has no previous pitch.
    first = pitch["pitch_of_pa"] == pitch.groupby(
        ["game_pk", "at_bat_index"])["pitch_of_pa"].transform("min")
    assert (pitch.loc[first, "prev_result_ball"] == 0).all()

    pas = S.get_frame(store, "pa_state")
    assert len(pas) > 0
    assert (pas["remaining"] >= 1).all()
    assert set(pas["y_ab"].dropna().unique()) <= {0, 1, 2, 3}
    missing = set(C.get("ab_result").features) - set(pas.columns) - {
        f"pa3_{c}" for c in range(7)}
    assert not missing, missing
    # One row per count state reached in a PA.
    assert not pas.duplicated(["game_pk", "at_bat_index", "balls", "strikes"]).any()
    # Pregame features on the only day in the warehouse have no history.
    assert np.allclose(pitch["p_n"].fillna(0), 0)
