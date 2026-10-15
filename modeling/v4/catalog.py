"""Every market the app offers, declared once: grain, outcome, kind, features.

The ladder (modeling/v4/ladder.py) never branches on a market's name. What
differs between markets lives here, the same contract `modeling/spec.py`
holds the v2 cell models to.

Feature lists are *candidates*: a name the frame does not carry is dropped
with a log line rather than failing the run, so a frame builder can add a
group without touching every market. The ladder records the features it
actually used on every run.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Incumbent:
    """How to reproduce the model production serves (or v3 would serve).

    style:
      calibrated  binary: logistic recalibration of `cols[0]` fitted on the
                  training seasons, `cols[1:]` as extra calibrator inputs
                  -- exactly markets.batter_markets
      prob        binary: `cols[0]` already an out-of-sample probability
      pmf         count: columns `<cols[0]>0..<cols[0]><cap>` are an
                  out-of-sample pmf
      probs       multiclass: `cols` are out-of-sample class probabilities
      nb_mean     count: `cols[0]` is a mean; NB dispersion fitted on train
      gauss       gaussian: `cols[0]` mean, sigma = training residual sd
    """
    style: str
    cols: tuple[str, ...]
    label: str


@dataclass(frozen=True)
class MarketDef:
    name: str
    grain: str                     # frame name in modeling/v4/frames
    kind: str                      # binary | multiclass | count | gaussian
    target: str                    # outcome column in the frame
    outcome: str                   # human definition, shown on the dashboard
    keys: tuple[str, ...]          # row identity in the backfill
    features: tuple[str, ...]
    stack: tuple[str, ...] = ()    # v3/v2 structural outputs, for i4
    classes: tuple[str, ...] = ()
    cap: int = 0                   # count support 0..cap (cap = "cap or more")
    line: float | None = None      # reference line for count P(over)
    baseline_group: str | None = None  # naive baseline: rate by this column
    incumbent: Incumbent | None = None
    max_train_rows: int = 1_500_000
    tune_rows: int = 400_000       # rows per fit inside the hyperparameter search
    served_as: str = ""            # what production stamps today
    notes: str = ""
    extra: dict = field(default_factory=dict)


# ── shared feature groups ───────────────────────────────────────────────────
# Column names produced by modeling/v4/frames.py and modeling/v4/feats.py.

RATING7 = tuple(f"{p}_{c}" for p in ("rb", "rs") for c in range(7))
CONTEXT_GAME = ("is_home", "park_hr", "park_h", "temp_c", "wind_out",
                "roof_closed", "day_of_season", "night")
BAT_FORM = tuple(f"bf_{s}_{w}" for s in ("h", "hr", "tb", "bb", "k", "pa", "r", "rbi")
                 for w in ("g15", "g50", "szn"))
BAT_CONTACT = ("bc_ev", "bc_hardhit", "bc_la_sweet", "bc_pull_air", "bc_barrel",
               "bc_n")
SP_FORM = tuple(f"pf_{s}_{w}" for s in ("k", "bb", "h", "hr", "outs", "er", "bf",
                                        "pitches")
                for w in ("s5", "s15", "szn"))
SP_STUFF = ("ps_velo", "ps_velo_trend", "ps_spin", "ps_ivb", "ps_hb", "ps_ext",
            "ps_whiff", "ps_csw", "ps_zone", "ps_chase", "ps_ff_share", "ps_n")
OPP_LINEUP = ("opp_k_rate", "opp_bb_rate", "opp_h_rate", "opp_iso", "opp_value",
              "opp_lhb_share")
WORKLOAD = ("own_mean", "team_leash", "pitches_mean", "rest", "first_start",
            "quality", "mu_outs", "mu_bf", "last_pitches", "season_ip")
UMP = ("ump_called_strike", "ump_out_zone_strike", "ump_n")
PEN = ("pen_ip_3d", "pen_rating_k", "pen_rating_out")

BATTER =(("slot", "e_pa", "same_hand", "sp_left", "bat_left", "switch",
           "team_value", "lineup_obp_behind")
          + RATING7 + tuple(f"rpen_{c}" for c in range(7))
          + CONTEXT_GAME + BAT_FORM + BAT_CONTACT
          + ("bd_swing", "bd_whiff", "bd_chase", "bd_ball_rate", "bd_inplay_rate")
          + ("opp_sp_velo", "opp_sp_whiff", "opp_sp_k_s15", "opp_sp_bb_s15",
             "opp_sp_hr_s15", "opp_sp_mu_bf", "h2h_pa", "h2h_ops")
          + PEN + UMP)
STARTER = (("is_home", "p_left", "rest") + tuple(f"rs_{c}" for c in range(7))
           + CONTEXT_GAME + SP_FORM + SP_STUFF + OPP_LINEUP + WORKLOAD + UMP)
GAME = tuple(f"{s}_{x}" for s in ("h", "a") for x in (
    "value", "sp_quality", "sp_k_s15", "sp_era_s15", "sp_mu_outs", "pen_rating_out",
    "pen_ip_3d", "win_pct", "run_diff_pg", "rest_days", "rs_pg_g15", "ra_pg_g15")) + \
    ("park_runs", "temp_c", "wind_out", "roof_closed", "day_of_season", "night") + UMP

BATTER_KEYS = ("game_pk", "player_id")
START_KEYS = ("game_pk", "player_id")
GAME_KEYS = ("game_pk",)

PITCH_FEATS = (
    "balls", "strikes", "outs", "inning", "top_inning", "on_1b", "on_2b", "on_3b",
    "score_diff", "pitch_of_game", "pitch_of_pa", "tto", "same_hand", "p_left",
    "prev_type_fb", "prev_type_br", "prev_type_os", "prev_result_ball",
    "prev_result_strike", "prev_result_foul", "prev_speed", "game_velo_delta",
    "p_velo", "p_velo_sd", "p_ff_share", "p_br_share", "p_os_share", "p_zone",
    "p_whiff", "p_chase", "p_ball_rate", "p_inplay_rate", "p_n",
    "p_cnt_ball_rate", "p_cnt_inplay_rate", "p_cnt_ff_share",
    "b_swing", "b_whiff", "b_chase", "b_inplay_rate", "b_ball_rate", "b_n",
    "b_cnt_swing",
    "ump_called_strike", "day_of_season",
)
PA_FEATS = (
    "balls", "strikes", "outs", "inning", "on_1b", "on_2b", "on_3b", "score_diff",
    "tto", "same_hand", "p_left", "is_home_bat", "pitch_of_game",
    "p_k_rate", "p_bb_rate", "p_h_rate", "p_pitches_pa", "p_whiff", "p_zone",
    "p_velo", "p_n",
    "b_k_rate", "b_bb_rate", "b_h_rate", "b_pitches_pa", "b_swing", "b_whiff",
    "b_chase", "b_n", "ump_called_strike", "day_of_season",
)
# Not in PA_FEATS: the v3 per-PA probabilities (pa3_*). They exist in the
# frames, but the live scorer cannot compute them, and a feature present in
# training and missing at serving time is a model scored off-distribution.


# Columns carried into each market's backfill so accuracy can be sliced by
# situation on the dashboard without re-reading the frames.
SEGMENTS = {
    "batter_game": ("slot", "is_home", "same_hand", "is_post"),
    "start": ("is_home", "p_left", "is_post"),
    "game": ("is_post",),
    "pitch": ("balls", "strikes", "inning", "pitch_of_pa", "is_post"),
    "pa_state": ("balls", "strikes", "inning", "is_post"),
    "rog": ("pa_k", "inning", "slot", "is_post"),
    "live_total": ("inning", "top_inning", "is_post"),
}

MARKETS: dict[str, MarketDef] = {}


def _add(m: MarketDef) -> None:
    MARKETS[m.name] = m


# ── batter, pregame ─────────────────────────────────────────────────────────
for _name, _tgt, _desc, _stack, _inc, _cap, _line in (
    ("batter_hit", "y_hit", "1+ hit in the game (box H >= 1)",
     ("s_hit", "s_e_hits"), Incumbent("calibrated", ("s_hit",), "v3 structural + calibrator"), 0, None),
    ("batter_hr", "y_hr", "1+ home run in the game (box HR >= 1)",
     ("s_hr",), Incumbent("calibrated", ("s_hr",), "v3 structural + calibrator"), 0, None),
    ("batter_tb15", "y_tb2", "2+ total bases in the game (box TB >= 2)",
     ("s_tb2", "s_e_value"), Incumbent("calibrated", ("s_tb2",), "v3 structural + calibrator"), 0, None),
    ("batter_hrr", "y_hrr", "1+ of hits + runs + RBI (box H+R+RBI >= 1)",
     ("s_hit", "s_e_onbase", "s_e_value"),
     Incumbent("calibrated", ("s_hit", "s_e_onbase", "top_order", "log_team_value"),
               "v3 P(hit) + calibrator with on-base and lineup value"), 0, None),
):
    _add(MarketDef(
        name=_name, grain="batter_game", kind="binary", target=_tgt, outcome=_desc,
        keys=BATTER_KEYS, features=BATTER, stack=_stack, baseline_group="slot",
        incumbent=_inc, max_train_rows=600_000, tune_rows=200_000, served_as="v2_20260924" if _name in ("batter_hit", "batter_hr") else "base_v1"))

# ── starters, pregame (count distributions) ─────────────────────────────────
for _name, _tgt, _desc, _cap, _line, _stack in (
    ("pitcher_k", "k", "strikeouts by the starter", 15, 4.5, ("v3_e_k",)),
    ("pitcher_bb", "bb", "walks issued by the starter (box BB, excludes HBP)", 8, 1.5, ("v3_e_bb",)),
    ("pitcher_hits", "h", "hits allowed by the starter", 14, 4.5, ("v3_e_h",)),
    ("pitcher_outs", "outs", "outs recorded by the starter", 27, 16.5, ("v3_e_outs", "mu_outs")),
    ("pitcher_er", "er", "earned runs charged to the starter", 12, 2.5, ("v3_e_er", "rpo")),
):
    _inc = (Incumbent("nb_mean", ("v3_e_er",), "v3 ER GLM (NB)") if _name == "pitcher_er"
            else Incumbent("pmf", (f"v3pmf_{_tgt}_",), "v3 structural count pmf"))
    _add(MarketDef(
        name=_name, grain="start", kind="count", target=_tgt, outcome=_desc,
        keys=START_KEYS, features=STARTER, stack=_stack, cap=_cap, line=_line,
        incumbent=_inc, served_as="base_v1"))

# ── games, pregame ──────────────────────────────────────────────────────────
_add(MarketDef(
    name="game_moneyline", grain="game", kind="binary", target="y_home_win",
    outcome="home team wins", keys=GAME_KEYS, features=GAME,
    stack=("v3_p_home", "v3_mu_home", "v3_mu_away"),
    incumbent=Incumbent("prob", ("v3_p_home",), "v3 team-runs NB + calibrator"),
    served_as="log5_v1"))
_add(MarketDef(
    name="game_total", grain="game", kind="count", target="total_runs",
    outcome="total runs scored by both teams", keys=GAME_KEYS, features=GAME,
    stack=("v3_mu_home", "v3_mu_away"), cap=30, line=8.5,
    incumbent=Incumbent("pmf", ("v3pmf_total_",), "v3 team-runs NB convolution"),
    served_as="total_v1"))

# ── micro, in-game ──────────────────────────────────────────────────────────
_add(MarketDef(
    name="pitch_result", grain="pitch", kind="multiclass", target="y_pitch",
    outcome="next pitch is a strike/foul, ball, or put in play",
    classes=("strike_foul", "ball", "in_play"),
    keys=("game_pk", "at_bat_index", "pitch_number"), features=PITCH_FEATS,
    baseline_group="count_state",
    served_as="v2_20260809", max_train_rows=1_200_000, tune_rows=300_000))
_add(MarketDef(
    name="pitch_speed_ou", grain="pitch", kind="gaussian", target="speed",
    outcome="release speed of the next pitch (mph); P(over line) from N(mu, sigma)",
    keys=("game_pk", "at_bat_index", "pitch_number"), features=PITCH_FEATS,
    baseline_group="pitcher_prior",
    incumbent=Incumbent("gauss", ("p_velo_all",), "pitcher's as-of mean speed"),
    served_as="v2_20260809", max_train_rows=1_200_000, tune_rows=300_000))
_add(MarketDef(
    name="ab_result", grain="pa_state", kind="multiclass", target="y_ab",
    outcome="plate appearance ends in strikeout, walk, hit, or other out (from this count)",
    classes=("strikeout", "walk", "hit", "out"),
    keys=("game_pk", "at_bat_index", "balls", "strikes"), features=PA_FEATS,
    baseline_group="count_state",
    served_as="v2_20260809", max_train_rows=1_200_000, tune_rows=300_000))
_add(MarketDef(
    name="ab_pitches_ou", grain="pa_state", kind="count", target="remaining",
    outcome="pitches remaining in the plate appearance from this count",
    keys=("game_pk", "at_bat_index", "balls", "strikes"), features=PA_FEATS,
    cap=12, line=2.5, baseline_group="count_state",
    served_as="v2_20260809", max_train_rows=1_200_000, tune_rows=300_000))

# ── live ────────────────────────────────────────────────────────────────────
for _name, _tgt, _desc, _stack in (
    ("batter_hit_rog", "y_hit_rest", "1+ hit in the batter's remaining plate appearances",
     ("rog_v3_hit",)),
    ("batter_hr_rog", "y_hr_rest", "1+ home run in the batter's remaining plate appearances",
     ("rog_v3_hr",)),
):
    _add(MarketDef(
        name=_name, grain="rog", kind="binary", target=_tgt, outcome=_desc,
        keys=("game_pk", "player_id", "pa_k"),
        features=("pa_k", "inning", "outs", "score_diff", "is_home", "slot",
                  "hits_so_far", "hr_so_far", "pa_so_far", "rem_pa_base",
                  "e_pa", "s_hit", "s_hr", "rb_2", "rb_5", "bf_h_g50", "bf_hr_g50",
                  "sp_still_in", "sp_pitches", "day_of_season"),
        stack=_stack, baseline_group="pa_k", max_train_rows=700_000, tune_rows=200_000,
        incumbent=Incumbent("prob", (_stack[0],), "v3 per-PA rate over base_v1 remaining PAs"),
        served_as="base_v1"))
_add(MarketDef(
    name="game_total_live", grain="live_total", kind="count", target="total_runs",
    outcome="final total runs, from the state at the start of each half-inning",
    keys=("game_pk", "inning", "top_inning"),
    features=("inning", "top_inning", "runs_now", "home_runs_now", "away_runs_now",
              "outs_left_home", "outs_left_away", "v3_mu_home", "v3_mu_away",
              "h_sp_in", "a_sp_in", "temp_c",
              "wind_out", "park_runs"),
    stack=("live_v3_mu_rest",), cap=30, line=8.5,
    incumbent=Incumbent("pmf", ("live_v3pmf_",), "v3 means scaled by outs left (NB)"),
    served_as="base_v1"))


GROUPS = {
    "player": ("batter_hit", "batter_hr", "batter_tb15", "batter_hrr",
               "pitcher_k", "pitcher_bb", "pitcher_hits", "pitcher_outs",
               "pitcher_er", "game_moneyline", "game_total"),
    "batter": ("batter_hit", "batter_hr", "batter_tb15", "batter_hrr"),
    "starter": ("pitcher_k", "pitcher_bb", "pitcher_hits", "pitcher_outs", "pitcher_er"),
    "game": ("game_moneyline", "game_total"),
    "pitch": ("pitch_result", "pitch_speed_ou"),
    "pa": ("ab_result", "ab_pitches_ou"),
    "live": ("batter_hit_rog", "batter_hr_rog", "game_total_live"),
}


def get(name: str) -> MarketDef:
    try:
        return MARKETS[name]
    except KeyError:
        raise KeyError(f"unknown v4 market {name!r}; known: {sorted(MARKETS)}") from None


def resolve(names: list[str]) -> list[MarketDef]:
    out: list[str] = []
    for n in names:
        out.extend(GROUPS.get(n, (n,)))
    return [get(n) for n in dict.fromkeys(out)]
