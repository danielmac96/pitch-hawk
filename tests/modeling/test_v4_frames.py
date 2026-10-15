"""The player/game/live frames build end to end through every source path,
and every feature a market declares is a column some frame produces.

The first real-data lab run spent 2h20m in the v3 pipeline and then died in
a source path no test had exercised (duplicate game_pk rows in `games`).
This runs those paths on the synthetic league with sources shaped like R2's,
warts included (tests/modeling/synthetic_sources.py).
"""

from __future__ import annotations

import pandas as pd
import pytest

from modeling import games as G
from modeling import markets as M
from modeling import pa_model as P
from modeling.v4 import catalog as C
from modeling.v4 import frames as FR

from .synthetic_league import league
from .synthetic_sources import sources


@pytest.fixture(scope="module")
def frames():
    pa, box = league(seasons=(2016, 2017, 2018, 2019), days=24)
    # The real warehouse's wart: a second row flagged as the starter for the
    # same team and game (an opener; a suspended game resumed).
    st = box[box["p_started"].fillna(False).astype(bool)].head(6).copy()
    st["player_id"] = st["player_id"] + 90_000
    st["p_bf"] = 3
    st["p_outs"] = 2
    box = pd.concat([box, st], ignore_index=True)
    mp = pytest.MonkeyPatch()
    mp.setattr(P, "load_pa", lambda store, **k: pa.copy())
    mp.setattr(G, "load_box", lambda store, **k: box.copy())
    mp.setattr(P, "WALK_FORWARD", (2018, 2019))
    mp.setattr(P, "HOLDOUT", 2019)
    mp.setattr(M, "SEASONS", (2016, 2017, 2018, 2019))
    mp.setattr(M, "TEST_SEASONS", (2018, 2019))
    run = M.run(None, keep_frames=True)
    out = FR.build_player_frames(None, src=sources(pa, box), run=run)
    mp.undo()
    return out


@pytest.mark.parametrize("grain", ["batter_game", "start", "game", "rog", "live_total"])
def test_every_declared_feature_is_built(frames, grain):
    f = frames[grain]
    declared = set().union(*[set(md.features) | set(md.stack)
                             for md in C.MARKETS.values() if md.grain == grain])
    assert not declared - set(f.columns), sorted(declared - set(f.columns))
    assert len(f) > 0


def test_games_are_one_row_each(frames):
    g = frames["game"]
    assert not g["game_pk"].duplicated().any()


def test_one_start_per_team_game_and_one_row_per_batter_game(frames):
    s, b = frames["start"], frames["batter_game"]
    assert not s.duplicated(["game_pk", "team_id"]).any()
    assert not b.duplicated(["game_pk", "player_id"]).any()
    assert not (s["player_id"] >= 90_000).any()  # the 3-batter "opener" lost
