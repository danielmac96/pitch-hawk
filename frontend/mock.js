// Mock /live payload + tick simulator for the MLB live-edge prototype.
// Mirrors the schema in the brief; expressed as a flat list of games and a
// tick() that mutates predictions/edges/lines in place with subtle drift,
// occasionally adding a pitch to a current PA.
(function () {
  const now = Date.now();
  const ago = (s) => new Date(now - s * 1000).toISOString();

  // ── helpers ────────────────────────────────────────────────────────────
  // pitch_type codes: FF four-seam, SI sinker, SL slider, CB curve, CH change,
  // SP splitter, CT cutter, KC knuckle-curve, FC cutter
  // description: called_strike, swinging_strike, ball, foul, in_play, hit_by_pitch
  // result_category: strike_foul | ball | in_play

  const mkPitch = (n, type, speed, zone, desc, cat, b, s) => ({
    pitch_number: n, pitch_type: type, start_speed: speed, zone,
    description: desc, result_category: cat, balls: b, strikes: s,
  });

  // ── games ──────────────────────────────────────────────────────────────
  const GAMES = [
    // 1. NYY @ BOS — Cole vs Devers, top edge
    {
      game_pk: 746285, game_label: "NYY @ BOS", away: "NYY", home: "BOS",
      score: { away: 2, home: 0 },
      pitcher_name: "Gerrit Cole", pitcher_hand: "R", pitcher_meta: "0H 1SO · ERA 2.71",
      batter_name:  "Rafael Devers", batter_hand: "L",  batter_meta:  "2/4 .312 · OPS .910",
      on_deck: "T. Story",
      situation: {
        inning: 6, half: "▲", count: "2-1", outs: 1,
        runners: { first: false, second: true, third: false },
        pitcher_id: 543037, batter_id: 646240,
        pitch_count_pa: 3, pitch_count_game: 78,
        last_pitch_ts: ago(7),
      },
      current_pa_pitches: [
        mkPitch(1, "FF", 97.2, 5,  "called_strike", "strike_foul", 0, 0),
        mkPitch(2, "SL", 88.1, 14, "ball",          "ball",        0, 1),
        mkPitch(3, "FF", 96.8, 11, "ball",          "ball",        1, 1),
      ],
      markets: [
        { market: "pitch_speed_ou", predicted_value: 96.2, recommendation: "over",
          line: 94.5, price: -115, edge: 0.073, confidence: 0.78,
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","pitcher_rolling","fatigue"] },
        { market: "pitch_result", predicted_value: 0.51, recommendation: "strike_foul",
          line: null, price: null, edge: null, confidence: 0.51,
          probs: { strike_foul: 0.51, ball: 0.34, in_play: 0.15 },
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","umpire"] },
        { market: "ab_result", predicted_value: 0.31, recommendation: "strikeout",
          line: null, price: null, edge: null, confidence: 0.31,
          probs: { strikeout: 0.31, walk: 0.09, hit: 0.21, out: 0.39 },
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","platoon","matchup","batter_rolling"] },
        { market: "ab_pitches_ou", predicted_value: 5.2, recommendation: "under",
          line: 3.5, price: 105, edge: 0.058, confidence: 0.71,
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","batter_rolling"] },
      ],
      // forward-looking: next at-bat markets, available pre-PA
      next_ab_markets: [
        { market: "next_ab_result", predicted_value: 0.28, recommendation: "strikeout",
          line: null, price: null, edge: null, confidence: 0.28,
          probs: { strikeout: 0.28, walk: 0.07, hit: 0.23, out: 0.42 },
          sample_size: 280, model_version: "freq_v2",
          features_used: ["pitcher_freq","platoon","matchup"] },
        { market: "next_ab_pitches_ou", predicted_value: 4.8, recommendation: "over",
          line: 4.5, price: -110, edge: 0.041, confidence: 0.64,
          sample_size: 280, model_version: "freq_v2",
          features_used: ["pitcher_freq"] },
      ],
    },

    // 2. LAD @ SFG — Yamamoto vs Chapman, 1-2 count, lots of pitches
    {
      game_pk: 746401, game_label: "LAD @ SFG", away: "LAD", home: "SFG",
      score: { away: 4, home: 3 },
      pitcher_name: "Yoshinobu Yamamoto", pitcher_hand: "R", pitcher_meta: "1H 4SO · ERA 1.92",
      batter_name:  "Matt Chapman", batter_hand: "R", batter_meta: "1/3 .268 · OPS .812",
      on_deck: "J. Yastrzemski",
      situation: {
        inning: 3, half: "▼", count: "1-2", outs: 0,
        runners: { first: true, second: false, third: false },
        pitcher_id: 660271, batter_id: 656305,
        pitch_count_pa: 4, pitch_count_game: 42,
        last_pitch_ts: ago(11),
      },
      current_pa_pitches: [
        mkPitch(1, "SP", 90.4, 8,  "swinging_strike", "strike_foul", 0, 0),
        mkPitch(2, "FF", 96.1, 13, "ball",            "ball",        0, 1),
        mkPitch(3, "FF", 95.7, 4,  "foul",            "strike_foul", 1, 1),
        mkPitch(4, "CB", 82.3, 6,  "foul",            "strike_foul", 1, 2),
      ],
      markets: [
        { market: "pitch_speed_ou", predicted_value: 94.8, recommendation: "under",
          line: 96.5, price: -120, edge: 0.055, confidence: 0.66,
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","pitcher_rolling"] },
        { market: "pitch_result", predicted_value: 0.42, recommendation: "ball",
          line: null, price: null, edge: null, confidence: 0.42,
          probs: { strike_foul: 0.39, ball: 0.42, in_play: 0.19 },
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","umpire","count_state"] },
        { market: "ab_result", predicted_value: 0.28, recommendation: "hit",
          line: null, price: null, edge: null, confidence: 0.28,
          probs: { strikeout: 0.24, walk: 0.07, hit: 0.28, out: 0.41 },
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","platoon","matchup","batter_rolling"] },
        { market: "ab_pitches_ou", predicted_value: 5.6, recommendation: "over",
          line: 4.5, price: -110, edge: 0.064, confidence: 0.69,
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","batter_rolling"] },
      ],
      next_ab_markets: [],
    },

    // 3. HOU @ SEA — Valdez vs J. Rodríguez, fresh PA 0-0
    {
      game_pk: 746502, game_label: "HOU @ SEA", away: "HOU", home: "SEA",
      score: { away: 1, home: 1 },
      pitcher_name: "Framber Valdez", pitcher_hand: "L", pitcher_meta: "0H 2SO · ERA 3.18",
      batter_name:  "Julio Rodríguez", batter_hand: "R", batter_meta: "0/2 .274 · OPS .851",
      on_deck: "C. Raleigh",
      situation: {
        inning: 4, half: "▲", count: "0-0", outs: 2,
        runners: { first: false, second: false, third: true },
        pitcher_id: 664285, batter_id: 677594,
        pitch_count_pa: 0, pitch_count_game: 51,
        last_pitch_ts: ago(9),
      },
      current_pa_pitches: [],
      markets: [
        { market: "pitch_speed_ou", predicted_value: 93.1, recommendation: "under",
          line: 93.5, price: -115, edge: 0.024, confidence: 0.58,
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","pitcher_rolling"] },
        { market: "pitch_result", predicted_value: 0.48, recommendation: "strike_foul",
          line: null, price: null, edge: null, confidence: 0.48,
          probs: { strike_foul: 0.48, ball: 0.37, in_play: 0.15 },
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","count_state"] },
        { market: "ab_result", predicted_value: 0.43, recommendation: "out",
          line: null, price: null, edge: null, confidence: 0.43,
          probs: { strikeout: 0.24, walk: 0.08, hit: 0.25, out: 0.43 },
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","platoon","matchup"] },
        { market: "ab_pitches_ou", predicted_value: 5.0, recommendation: "over",
          line: 4.5, price: -115, edge: 0.051, confidence: 0.62,
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","batter_rolling"] },
      ],
      next_ab_markets: [
        { market: "next_ab_pitches_ou", predicted_value: 4.2, recommendation: "under",
          line: 4.5, price: -105, edge: 0.038, confidence: 0.61,
          sample_size: 280, model_version: "freq_v2",
          features_used: ["pitcher_freq","batter_rolling"] },
      ],
    },

    // 4. CHC @ STL — Steele vs Goldschmidt, full count, deep PA
    {
      game_pk: 746611, game_label: "CHC @ STL", away: "CHC", home: "STL",
      score: { away: 5, home: 5 },
      pitcher_name: "Justin Steele", pitcher_hand: "L", pitcher_meta: "2H 1SO · ERA 3.41",
      batter_name:  "Paul Goldschmidt", batter_hand: "R", batter_meta: "2/3 .284 · OPS .831",
      on_deck: "N. Gorman",
      situation: {
        inning: 7, half: "▼", count: "3-2", outs: 2,
        runners: { first: true, second: true, third: false },
        pitcher_id: 657006, batter_id: 502671,
        pitch_count_pa: 6, pitch_count_game: 96,
        last_pitch_ts: ago(13),
      },
      current_pa_pitches: [
        mkPitch(1, "FF", 91.4, 13, "ball",            "ball",        0, 0),
        mkPitch(2, "CH", 83.1, 2,  "foul",            "strike_foul", 1, 0),
        mkPitch(3, "SL", 85.2, 5,  "foul",            "strike_foul", 1, 1),
        mkPitch(4, "FF", 90.8, 14, "ball",            "ball",        1, 2),
        mkPitch(5, "SL", 84.6, 4,  "foul",            "strike_foul", 2, 2),
        mkPitch(6, "FF", 91.7, 11, "ball",            "ball",        3, 2),
      ],
      markets: [
        { market: "pitch_speed_ou", predicted_value: 90.9, recommendation: "under",
          line: 91.5, price: -110, edge: 0.042, confidence: 0.63,
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","fatigue"] },
        { market: "pitch_result", predicted_value: 0.39, recommendation: "ball",
          line: null, price: null, edge: null, confidence: 0.39,
          probs: { strike_foul: 0.36, ball: 0.39, in_play: 0.25 },
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","count_state"] },
        { market: "ab_result", predicted_value: 0.24, recommendation: "hit",
          line: null, price: null, edge: null, confidence: 0.24,
          probs: { strikeout: 0.21, walk: 0.18, hit: 0.24, out: 0.37 },
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","platoon","matchup"] },
        { market: "ab_pitches_ou", predicted_value: 7.1, recommendation: "over",
          line: 6.5, price: 105, edge: 0.031, confidence: 0.60,
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","batter_rolling"] },
      ],
      next_ab_markets: [],
    },

    // 5. ATL @ PHI — Strider vs Schwarber, 2-2 count, no edges above threshold
    {
      game_pk: 746712, game_label: "ATL @ PHI", away: "ATL", home: "PHI",
      score: { away: 1, home: 2 },
      pitcher_name: "Spencer Strider", pitcher_hand: "R", pitcher_meta: "1H 5SO · ERA 2.94",
      batter_name:  "Kyle Schwarber", batter_hand: "L", batter_meta: "1/3 .241 · OPS .891",
      on_deck: "B. Harper",
      situation: {
        inning: 2, half: "▲", count: "2-2", outs: 0,
        runners: { first: false, second: false, third: false },
        pitcher_id: 675911, batter_id: 656941,
        pitch_count_pa: 5, pitch_count_game: 31,
        last_pitch_ts: ago(6),
      },
      current_pa_pitches: [
        mkPitch(1, "FF", 99.1, 5,  "called_strike",   "strike_foul", 0, 0),
        mkPitch(2, "SL", 87.4, 13, "ball",            "ball",        0, 1),
        mkPitch(3, "FF", 98.6, 4,  "swinging_strike", "strike_foul", 0, 2),
        mkPitch(4, "SL", 86.9, 14, "ball",            "ball",        1, 2),
        mkPitch(5, "FF", 98.9, 2,  "foul",            "strike_foul", 2, 2),
      ],
      markets: [
        { market: "pitch_speed_ou", predicted_value: 97.8, recommendation: "over",
          line: 97.5, price: -115, edge: 0.021, confidence: 0.59,
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","pitcher_rolling"] },
        { market: "pitch_result", predicted_value: 0.54, recommendation: "strike_foul",
          line: null, price: null, edge: null, confidence: 0.54,
          probs: { strike_foul: 0.54, ball: 0.31, in_play: 0.15 },
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","umpire"] },
        { market: "ab_result", predicted_value: 0.38, recommendation: "strikeout",
          line: null, price: null, edge: null, confidence: 0.38,
          probs: { strikeout: 0.38, walk: 0.10, hit: 0.18, out: 0.34 },
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","platoon","matchup"] },
        { market: "ab_pitches_ou", predicted_value: 5.4, recommendation: "under",
          line: 5.5, price: -105, edge: -0.008, confidence: 0.51,
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","batter_rolling"] },
      ],
      next_ab_markets: [],
    },

    // 6. TBR @ TOR — STALE — last pitch >25s ago, predictions phantom
    {
      game_pk: 746833, game_label: "TBR @ TOR", away: "TBR", home: "TOR",
      score: { away: 0, home: 3 },
      pitcher_name: "Shane McClanahan", pitcher_hand: "L", pitcher_meta: "3H 2SO · ERA 3.66",
      batter_name:  "Vladimir Guerrero Jr.", batter_hand: "R", batter_meta: "1/2 .291 · OPS .848",
      on_deck: "B. Bichette",
      situation: {
        inning: 5, half: "▼", count: "0-1", outs: 1,
        runners: { first: false, second: false, third: false },
        pitcher_id: 663556, batter_id: 665489,
        pitch_count_pa: 1, pitch_count_game: 64,
        last_pitch_ts: ago(34),
      },
      current_pa_pitches: [
        mkPitch(1, "FF", 94.2, 5, "called_strike", "strike_foul", 0, 0),
      ],
      markets: [
        { market: "pitch_speed_ou", predicted_value: 93.8, recommendation: "under",
          line: 94.5, price: -110, edge: 0.054, confidence: 0.66,
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq","pitcher_rolling","fatigue"] },
        { market: "pitch_result", predicted_value: 0.44, recommendation: "strike_foul",
          line: null, price: null, edge: null, confidence: 0.44,
          probs: { strike_foul: 0.44, ball: 0.36, in_play: 0.20 },
          sample_size: 2400, model_version: "freq_v2",
          features_used: ["pitcher_freq"] },
        { market: "ab_result", predicted_value: 0.36, recommendation: "out",
          line: null, price: null, edge: null, confidence: 0.36,
          probs: { strikeout: 0.22, walk: 0.09, hit: 0.27, out: 0.36 },
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","platoon","matchup"] },
        { market: "ab_pitches_ou", predicted_value: 4.6, recommendation: "over",
          line: 4.5, price: -115, edge: 0.012, confidence: 0.54,
          sample_size: 380, model_version: "freq_v2",
          features_used: ["pitcher_freq","batter_rolling"] },
      ],
      next_ab_markets: [],
    },
  ];

  // mark has_edge / top_edge derived
  for (const g of GAMES) {
    let top = 0;
    for (const m of g.markets) if (m.edge != null && m.edge > top) top = m.edge;
    g.top_edge = top;
    g.has_edge = top > 0.05;
    g.model_version = "freq_v2";
  }

  // ── per-outcome lines for probabilistic markets ───────────────────────
  // Each prob market gets an `outcomes: [{name, prob, price, edge, confidence}]`
  // array — books post per-outcome American odds; edge = prob − implied(price).
  function priceForEdge(prob, edge) {
    const imp = Math.max(0.02, Math.min(0.97, prob - edge));
    const raw = imp > 0.5 ? -imp / (1 - imp) * 100 : (1 - imp) / imp * 100;
    return Math.round(raw / 5) * 5; // snap to nearest 5
  }
  function mkO(name, prob, edge, confidence) {
    return { name, prob, price: priceForEdge(prob, edge), edge: +edge.toFixed(4),
             confidence: confidence != null ? confidence : 0.65 };
  }

  // outcomes per game_pk × market — chosen to give a mix of hot / warm / soft / neg
  const OUTCOMES_BY_GAME = {
    // 1. NYY @ BOS (top edge — hot strikeout + hot in_play)
    746285: {
      pitch_result: [
        mkO("strike_foul", 0.51, 0.010, 0.78),
        mkO("ball",        0.34, 0.017, 0.62),
        mkO("in_play",     0.15, 0.055, 0.55),
      ],
      ab_result: [
        mkO("strikeout", 0.31,  0.054, 0.71),
        mkO("walk",      0.09,  0.005, 0.60),
        mkO("hit",       0.21,  0.015, 0.65),
        mkO("out",       0.39, -0.040, 0.62),
      ],
      next_ab_result: [
        mkO("strikeout", 0.28,  0.035, 0.64),
        mkO("walk",      0.07,  0.002, 0.55),
        mkO("hit",       0.23,  0.018, 0.60),
        mkO("out",       0.42, -0.020, 0.58),
      ],
    },
    // 2. LAD @ SFG (warm ball, hot hit)
    746401: {
      pitch_result: [
        mkO("strike_foul", 0.39, -0.005, 0.66),
        mkO("ball",        0.42,  0.045, 0.69),
        mkO("in_play",     0.19,  0.012, 0.58),
      ],
      ab_result: [
        mkO("strikeout", 0.24,  0.010, 0.62),
        mkO("walk",      0.07,  0.003, 0.55),
        mkO("hit",       0.28,  0.050, 0.69),
        mkO("out",       0.41, -0.032, 0.61),
      ],
    },
    // 3. HOU @ SEA (warm out)
    746502: {
      pitch_result: [
        mkO("strike_foul", 0.48,  0.020, 0.62),
        mkO("ball",        0.37, -0.005, 0.58),
        mkO("in_play",     0.15,  0.010, 0.55),
      ],
      ab_result: [
        mkO("strikeout", 0.24,  0.005, 0.61),
        mkO("walk",      0.08, -0.002, 0.54),
        mkO("hit",       0.25, -0.008, 0.60),
        mkO("out",       0.43,  0.048, 0.66),
      ],
    },
    // 4. CHC @ STL (full count — hot walk!)
    746611: {
      pitch_result: [
        mkO("strike_foul", 0.36, -0.015, 0.60),
        mkO("ball",        0.39,  0.020, 0.63),
        mkO("in_play",     0.25,  0.035, 0.66),
      ],
      ab_result: [
        mkO("strikeout", 0.21, -0.005, 0.55),
        mkO("walk",      0.18,  0.060, 0.72),
        mkO("hit",       0.24,  0.010, 0.60),
        mkO("out",       0.37, -0.025, 0.58),
      ],
    },
    // 5. ATL @ PHI (no big edges)
    746712: {
      pitch_result: [
        mkO("strike_foul", 0.54,  0.005, 0.60),
        mkO("ball",        0.31, -0.008, 0.55),
        mkO("in_play",     0.15,  0.003, 0.54),
      ],
      ab_result: [
        mkO("strikeout", 0.38,  0.020, 0.62),
        mkO("walk",      0.10, -0.005, 0.54),
        mkO("hit",       0.18, -0.010, 0.56),
        mkO("out",       0.34, -0.005, 0.56),
      ],
    },
    // 6. TBR @ TOR (STALE — warm hit, mostly small edges)
    746833: {
      pitch_result: [
        mkO("strike_foul", 0.44,  0.015, 0.60),
        mkO("ball",        0.36,  0.005, 0.58),
        mkO("in_play",     0.20, -0.020, 0.56),
      ],
      ab_result: [
        mkO("strikeout", 0.22, -0.010, 0.55),
        mkO("walk",      0.09,  0.005, 0.54),
        mkO("hit",       0.27,  0.030, 0.62),
        mkO("out",       0.36, -0.025, 0.57),
      ],
    },
  };

  for (const g of GAMES) {
    const byMarket = OUTCOMES_BY_GAME[g.game_pk] || {};
    for (const m of g.markets) {
      if (byMarket[m.market]) m.outcomes = byMarket[m.market];
    }
    for (const m of (g.next_ab_markets || [])) {
      if (byMarket[m.market]) m.outcomes = byMarket[m.market];
    }
  }

  // ── tick: small drift on numerics, flag changed keys for flash ─────────
  // Returns a *new* shallow-cloned array of games with updated values, plus a
  // Set of "game_pk:market:field" strings the UI can use to flash.
  function tick(games, opts = {}) {
    const r = (lo, hi) => lo + Math.random() * (hi - lo);
    const flash = new Set();
    const out = games.map((g) => {
      const ng = { ...g, situation: { ...g.situation }, markets: g.markets.map((m) => ({ ...m })),
                   next_ab_markets: (g.next_ab_markets || []).map((m) => ({ ...m })) };

      // age last_pitch_ts (don't artificially refresh stale game)
      // but pretend a tick arrived: bump game pitch_count_game by 0–1
      // (mostly no-op; just for "live" feel)

      // jitter each market's prediction + edge slightly
      for (const m of ng.markets) {
        if (m.market === "pitch_speed_ou") {
          const oldP = m.predicted_value;
          m.predicted_value = +(oldP + r(-0.15, 0.15)).toFixed(2);
          if (Math.abs(m.predicted_value - oldP) > 0.05) flash.add(`${ng.game_pk}:${m.market}:predicted_value`);
        }
        if (m.market === "ab_pitches_ou") {
          const oldP = m.predicted_value;
          m.predicted_value = +(oldP + r(-0.1, 0.1)).toFixed(2);
          if (Math.abs(m.predicted_value - oldP) > 0.03) flash.add(`${ng.game_pk}:${m.market}:predicted_value`);
        }
        if (m.edge != null) {
          const oldE = m.edge;
          m.edge = +(Math.max(-0.05, oldE + r(-0.006, 0.006))).toFixed(4);
          if (Math.abs(m.edge - oldE) > 0.002) flash.add(`${ng.game_pk}:${m.market}:edge`);
        }
        if (m.confidence != null) {
          m.confidence = +(Math.min(0.95, Math.max(0.4, m.confidence + r(-0.01, 0.01)))).toFixed(3);
        }
        if (m.outcomes) {
          m.outcomes = m.outcomes.map((o) => {
            const oldEdge = o.edge;
            const newEdge = +(o.edge + r(-0.005, 0.005)).toFixed(4);
            if (Math.abs(newEdge - oldEdge) > 0.002) {
              flash.add(`${ng.game_pk}:${m.market}:${o.name}:edge`);
            }
            return { ...o, edge: newEdge };
          });
        }
      }

      // re-derive top edge
      let top = 0;
      for (const m of ng.markets) if (m.edge != null && m.edge > top) top = m.edge;
      ng.top_edge = top;
      ng.has_edge = top > 0.05;
      return ng;
    });
    return { games: out, flash };
  }

  window.MOCK = { GAMES, tick };
})();
