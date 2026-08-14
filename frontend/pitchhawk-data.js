// ════════════════════════════════════════════════════════════════════════
// pitchhawk-data.js — Edge engine + render-ready live dataset.
//
// Mirrors the backend contract (GET /edge/{game_pk}, GET /live):
//   • Four model-priced micro-markets: pitch_speed_ou, pitch_result,
//     ab_result, ab_pitches_ou.
//   • Edge = model probability − market-implied probability, computed PER
//     SOURCE across sportsbooks (DraftKings, FanDuel) and prediction markets
//     (Kalshi, Polymarket). best_source = most positive edge.
//
// Swap-in path to live: replace buildGames() with a fetch of /live and /edge;
// every consumer reads the normalized shape below, not these literals.
// Illustrative sample data — not real odds, not betting advice.
// ════════════════════════════════════════════════════════════════════════

window.PITCHHAWK = (function () {
  // ── odds math ─────────────────────────────────────────────────────────
  const clampP = (p) => Math.max(0.02, Math.min(0.97, p));
  const impliedFromAmerican = (a) => (a < 0 ? -a / (-a + 100) : 100 / (a + 100));
  const americanFromImplied = (p) => {
    p = clampP(p);
    const raw = p >= 0.5 ? -(p / (1 - p)) * 100 : ((1 - p) / p) * 100;
    return Math.round(raw / 5) * 5;
  };
  const calcEdge = (model, implied) => +(model - implied).toFixed(4);

  // ── MLB calendar dates ────────────────────────────────────────────────
  // The server keys every prediction off `games.official_date`, which is an
  // America/New_York date (see _shared/mlb.ts `mlbToday`). The browser's own
  // toISOString() is UTC, and the two disagree for the whole evening: at
  // 21:00 ET the UTC date has already rolled over, so a UTC-derived "today"
  // asks for tomorrow's slate and gets nothing back — during exactly the
  // hours games are being played. Everything that talks dates to the API
  // goes through here instead.
  //
  // en-CA formats as YYYY-MM-DD, matching the server helper it mirrors.
  const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
  const mlbDate = (offsetDays = 0) =>
    ET_DATE.format(new Date(Date.now() + offsetDays * 864e5));

  // ── sources ───────────────────────────────────────────────────────────
  const SOURCES = {
    draftkings: { key: "draftkings", name: "DraftKings", short: "DK",   type: "book",
      url: "https://sportsbook.draftkings.com/leagues/baseball/mlb" },
    fanduel:    { key: "fanduel",    name: "FanDuel",    short: "FD",   type: "book",
      url: "https://sportsbook.fanduel.com/navigation/mlb" },
    kalshi:     { key: "kalshi",     name: "Kalshi",     short: "KAL",  type: "market",
      url: "https://kalshi.com" },
    polymarket: { key: "polymarket", name: "Polymarket", short: "POLY", type: "market",
      url: "https://polymarket.com" },
  };

  // Build per-source quotes around a consensus implied prob. Sportsbooks carry
  // a touch of vig (implied a hair higher → worse for the bettor); prediction
  // markets sit near-fair with a thin spread. Each source's edge is recomputed
  // from its own implied prob, so the "best" source falls out naturally.
  function buildSources(modelProb, baseImplied, keys) {
    return keys.map((k, i) => {
      const s = SOURCES[k];
      const vig = s.type === "book" ? 0.013 : 0.003;
      const jitter = (i % 2 ? 1 : -1) * (0.003 + 0.005 * ((i * 7) % 3) / 2);
      const implied = clampP(baseImplied + vig + jitter);
      return {
        source: k, name: s.name, short: s.short, type: s.type, url: s.url,
        impliedProb: +implied.toFixed(4),
        price: americanFromImplied(implied),
        edge: calcEdge(modelProb, implied),
      };
    });
  }
  const bestOf = (rows) => rows.reduce((a, b) => (b.edge > a.edge ? b : a), rows[0]);

  // over/under market
  function ou(market, predicted, side, line, modelProb, edge, keys) {
    const sources = buildSources(modelProb, modelProb - edge, keys);
    const best = bestOf(sources);
    return { market, kind: "ou", predictedValue: predicted, recommendation: side,
      line, modelProb, sources, best, edge: best.edge };
  }
  // categorical market — specs: [{name, prob, edge, conf}]
  function cat(market, specs, keys) {
    const outcomes = specs.map((o) => {
      const sources = buildSources(o.prob, o.prob - o.edge, keys);
      const best = bestOf(sources);
      return { name: o.name, modelProb: o.prob, conf: o.conf, sources, best, edge: best.edge };
    });
    const rec = outcomes.reduce((a, b) => (b.edge > a.edge ? b : a), outcomes[0]);
    const probs = {};
    specs.forEach((o) => (probs[o.name] = o.prob));
    return { market, kind: "cat", probs, outcomes, recommendation: rec.name,
      recOutcome: rec, modelProb: rec.modelProb, edge: rec.edge, best: rec.best, conf: rec.conf };
  }

  const ALL = ["draftkings", "fanduel", "kalshi", "polymarket"];
  const MKT = ["kalshi", "polymarket", "draftkings"]; // markets lead the micro-props
  const p = (n, type, speed, zone, desc, cat, b, s) =>
    ({ n, type, speed, zone, desc, cat, balls: b, strikes: s });

  // ── markets meta ──────────────────────────────────────────────────────
  const MARKETS = {
    pitch_speed_ou: { key: "pitch_speed_ou", label: "Next Pitch Speed",   short: "Pitch Speed", group: "Pitch",  kind: "ou",  unit: "mph" },
    pitch_result:   { key: "pitch_result",   label: "Next Pitch Result",  short: "Pitch Result", group: "Pitch",  kind: "cat" },
    ab_result:      { key: "ab_result",      label: "At-Bat Result",      short: "AB Result",   group: "At-Bat", kind: "cat" },
    ab_pitches_ou:  { key: "ab_pitches_ou",  label: "Pitches in At-Bat",  short: "AB Pitches",  group: "At-Bat", kind: "ou",  unit: "pitches" },
    // Game-level markets. Absent from this map until 2026-08-06, which meant
    // normalizeGame() silently dropped them even when the API sent them —
    // moneyline and total could never appear on the board.
    game_moneyline: { key: "game_moneyline", label: "Moneyline",  short: "Moneyline", group: "Game", kind: "cat" },
    game_total:     { key: "game_total",     label: "Game Total", short: "Total",     group: "Game", kind: "ou", unit: "runs" },
  };
  const OUTCOME_LABEL = {
    strike_foul: "Strike / Foul", ball: "Ball", in_play: "In Play",
    strikeout: "Strikeout", walk: "Walk", hit: "Hit", out: "Out",
    over: "Over", under: "Under",
    home: "Home", away: "Away",
  };

  // ── games ─────────────────────────────────────────────────────────────
  const now = Date.now();
  const ago = (s) => new Date(now - s * 1000).toISOString();

  function buildGames() {
    return [
      {
        gamePk: 746285, away: "NYY", home: "BOS", label: "NYY @ BOS",
        venue: "Fenway Park", weather: "72°F · Wind 8mph out to RF · Clear", score: { away: 2, home: 0 },
        pitcher: { name: "Gerrit Cole", hand: "R", meta: "0H 1SO · ERA 2.71" },
        batter: { name: "Rafael Devers", hand: "L", meta: "2/4 .312 · OPS .910" },
        onDeck: "T. Story",
        inning: 6, half: "▲", count: "2-1", outs: 1,
        runners: { first: false, second: true, third: false },
        pitchCountPa: 3, pitchCountGame: 78, lastPitch: ago(7),
        pitches: [
          p(1, "FF", 97.2, 5, "called_strike", "strike_foul", 0, 0),
          p(2, "SL", 88.1, 14, "ball", "ball", 0, 1),
          p(3, "FF", 96.8, 11, "ball", "ball", 1, 1),
        ],
        m: {
          pitch_speed_ou: ou("pitch_speed_ou", 96.2, "over", 94.5, 0.78, 0.073, ALL),
          pitch_result: cat("pitch_result", [
            { name: "strike_foul", prob: 0.51, edge: 0.010, conf: 0.78 },
            { name: "ball", prob: 0.34, edge: 0.017, conf: 0.62 },
            { name: "in_play", prob: 0.15, edge: 0.055, conf: 0.55 },
          ], MKT),
          ab_result: cat("ab_result", [
            { name: "strikeout", prob: 0.31, edge: 0.054, conf: 0.71 },
            { name: "walk", prob: 0.09, edge: 0.005, conf: 0.60 },
            { name: "hit", prob: 0.21, edge: 0.015, conf: 0.65 },
            { name: "out", prob: 0.39, edge: -0.040, conf: 0.62 },
          ], MKT),
          ab_pitches_ou: ou("ab_pitches_ou", 5.2, "under", 3.5, 0.71, 0.058, ALL),
        },
      },
      {
        gamePk: 746401, away: "LAD", home: "SFG", label: "LAD @ SFG",
        venue: "Oracle Park", weather: "58°F · Wind 12mph in from CF · Overcast", score: { away: 4, home: 3 },
        pitcher: { name: "Yoshinobu Yamamoto", hand: "R", meta: "1H 4SO · ERA 1.92" },
        batter: { name: "Matt Chapman", hand: "R", meta: "1/3 .268 · OPS .812" },
        onDeck: "J. Yastrzemski",
        inning: 3, half: "▼", count: "1-2", outs: 0,
        runners: { first: true, second: false, third: false },
        pitchCountPa: 4, pitchCountGame: 42, lastPitch: ago(11),
        pitches: [
          p(1, "SP", 90.4, 8, "swinging_strike", "strike_foul", 0, 0),
          p(2, "FF", 96.1, 13, "ball", "ball", 0, 1),
          p(3, "FF", 95.7, 4, "foul", "strike_foul", 1, 1),
          p(4, "CB", 82.3, 6, "foul", "strike_foul", 1, 2),
        ],
        m: {
          pitch_speed_ou: ou("pitch_speed_ou", 94.8, "under", 96.5, 0.66, 0.055, ALL),
          pitch_result: cat("pitch_result", [
            { name: "strike_foul", prob: 0.39, edge: -0.005, conf: 0.66 },
            { name: "ball", prob: 0.42, edge: 0.045, conf: 0.69 },
            { name: "in_play", prob: 0.19, edge: 0.012, conf: 0.58 },
          ], MKT),
          ab_result: cat("ab_result", [
            { name: "strikeout", prob: 0.24, edge: 0.010, conf: 0.62 },
            { name: "walk", prob: 0.07, edge: 0.003, conf: 0.55 },
            { name: "hit", prob: 0.28, edge: 0.050, conf: 0.69 },
            { name: "out", prob: 0.41, edge: -0.032, conf: 0.61 },
          ], MKT),
          ab_pitches_ou: ou("ab_pitches_ou", 5.6, "over", 4.5, 0.69, 0.064, ALL),
        },
      },
      {
        gamePk: 746502, away: "HOU", home: "SEA", label: "HOU @ SEA",
        venue: "T-Mobile Park", weather: "64°F · Roof open · Calm", score: { away: 1, home: 1 },
        pitcher: { name: "Framber Valdez", hand: "L", meta: "0H 2SO · ERA 3.18" },
        batter: { name: "Julio Rodríguez", hand: "R", meta: "0/2 .274 · OPS .851" },
        onDeck: "C. Raleigh",
        inning: 4, half: "▲", count: "0-0", outs: 2,
        runners: { first: false, second: false, third: true },
        pitchCountPa: 0, pitchCountGame: 51, lastPitch: ago(9),
        pitches: [],
        m: {
          pitch_speed_ou: ou("pitch_speed_ou", 93.1, "under", 93.5, 0.58, 0.024, ALL),
          pitch_result: cat("pitch_result", [
            { name: "strike_foul", prob: 0.48, edge: 0.020, conf: 0.62 },
            { name: "ball", prob: 0.37, edge: -0.005, conf: 0.58 },
            { name: "in_play", prob: 0.15, edge: 0.010, conf: 0.55 },
          ], MKT),
          ab_result: cat("ab_result", [
            { name: "strikeout", prob: 0.24, edge: 0.005, conf: 0.61 },
            { name: "walk", prob: 0.08, edge: -0.002, conf: 0.54 },
            { name: "hit", prob: 0.25, edge: -0.008, conf: 0.60 },
            { name: "out", prob: 0.43, edge: 0.048, conf: 0.66 },
          ], MKT),
          ab_pitches_ou: ou("ab_pitches_ou", 5.0, "over", 4.5, 0.62, 0.051, ALL),
        },
      },
      {
        gamePk: 746611, away: "CHC", home: "STL", label: "CHC @ STL",
        venue: "Busch Stadium", weather: "81°F · Wind 6mph L-to-R · Humid", score: { away: 5, home: 5 },
        pitcher: { name: "Justin Steele", hand: "L", meta: "2H 1SO · ERA 3.41" },
        batter: { name: "Paul Goldschmidt", hand: "R", meta: "2/3 .284 · OPS .831" },
        onDeck: "N. Gorman",
        inning: 7, half: "▼", count: "3-2", outs: 2,
        runners: { first: true, second: true, third: false },
        pitchCountPa: 6, pitchCountGame: 96, lastPitch: ago(13),
        pitches: [
          p(1, "FF", 91.4, 13, "ball", "ball", 0, 0),
          p(2, "CH", 83.1, 2, "foul", "strike_foul", 1, 0),
          p(3, "SL", 85.2, 5, "foul", "strike_foul", 1, 1),
          p(4, "FF", 90.8, 14, "ball", "ball", 1, 2),
          p(5, "SL", 84.6, 4, "foul", "strike_foul", 2, 2),
          p(6, "FF", 91.7, 11, "ball", "ball", 3, 2),
        ],
        m: {
          pitch_speed_ou: ou("pitch_speed_ou", 90.9, "under", 91.5, 0.63, 0.042, ALL),
          pitch_result: cat("pitch_result", [
            { name: "strike_foul", prob: 0.36, edge: -0.015, conf: 0.60 },
            { name: "ball", prob: 0.39, edge: 0.020, conf: 0.63 },
            { name: "in_play", prob: 0.25, edge: 0.035, conf: 0.66 },
          ], MKT),
          ab_result: cat("ab_result", [
            { name: "strikeout", prob: 0.21, edge: -0.005, conf: 0.55 },
            { name: "walk", prob: 0.18, edge: 0.060, conf: 0.72 },
            { name: "hit", prob: 0.24, edge: 0.010, conf: 0.60 },
            { name: "out", prob: 0.37, edge: -0.025, conf: 0.58 },
          ], MKT),
          ab_pitches_ou: ou("ab_pitches_ou", 7.1, "over", 6.5, 0.60, 0.031, ALL),
        },
      },
      {
        gamePk: 746712, away: "ATL", home: "PHI", label: "ATL @ PHI",
        venue: "Citizens Bank Park", weather: "77°F · Wind 9mph out to LF · Clear", score: { away: 1, home: 2 },
        pitcher: { name: "Spencer Strider", hand: "R", meta: "1H 5SO · ERA 2.94" },
        batter: { name: "Kyle Schwarber", hand: "L", meta: "1/3 .241 · OPS .891" },
        onDeck: "B. Harper",
        inning: 2, half: "▲", count: "2-2", outs: 0,
        runners: { first: false, second: false, third: false },
        pitchCountPa: 5, pitchCountGame: 31, lastPitch: ago(6),
        pitches: [
          p(1, "FF", 99.1, 5, "called_strike", "strike_foul", 0, 0),
          p(2, "SL", 87.4, 13, "ball", "ball", 0, 1),
          p(3, "FF", 98.6, 4, "swinging_strike", "strike_foul", 0, 2),
          p(4, "SL", 86.9, 14, "ball", "ball", 1, 2),
          p(5, "FF", 98.9, 2, "foul", "strike_foul", 2, 2),
        ],
        m: {
          pitch_speed_ou: ou("pitch_speed_ou", 97.8, "over", 97.5, 0.59, 0.021, ALL),
          pitch_result: cat("pitch_result", [
            { name: "strike_foul", prob: 0.54, edge: 0.005, conf: 0.60 },
            { name: "ball", prob: 0.31, edge: -0.008, conf: 0.55 },
            { name: "in_play", prob: 0.15, edge: 0.003, conf: 0.54 },
          ], MKT),
          ab_result: cat("ab_result", [
            { name: "strikeout", prob: 0.38, edge: 0.020, conf: 0.62 },
            { name: "walk", prob: 0.10, edge: -0.005, conf: 0.54 },
            { name: "hit", prob: 0.18, edge: -0.010, conf: 0.56 },
            { name: "out", prob: 0.34, edge: -0.005, conf: 0.56 },
          ], MKT),
          ab_pitches_ou: ou("ab_pitches_ou", 5.4, "under", 5.5, 0.51, -0.008, ALL),
        },
      },
      {
        gamePk: 746833, away: "TBR", home: "TOR", label: "TBR @ TOR",
        venue: "Rogers Centre", weather: "72°F · Roof closed · Dome", score: { away: 0, home: 3 }, stale: true,
        pitcher: { name: "Shane McClanahan", hand: "L", meta: "3H 2SO · ERA 3.66" },
        batter: { name: "Vladimir Guerrero Jr.", hand: "R", meta: "1/2 .291 · OPS .848" },
        onDeck: "B. Bichette",
        inning: 5, half: "▼", count: "0-1", outs: 1,
        runners: { first: false, second: false, third: false },
        pitchCountPa: 1, pitchCountGame: 64, lastPitch: ago(34),
        pitches: [p(1, "FF", 94.2, 5, "called_strike", "strike_foul", 0, 0)],
        m: {
          pitch_speed_ou: ou("pitch_speed_ou", 93.8, "under", 94.5, 0.66, 0.054, ALL),
          pitch_result: cat("pitch_result", [
            { name: "strike_foul", prob: 0.44, edge: 0.015, conf: 0.60 },
            { name: "ball", prob: 0.36, edge: 0.005, conf: 0.58 },
            { name: "in_play", prob: 0.20, edge: -0.020, conf: 0.56 },
          ], MKT),
          ab_result: cat("ab_result", [
            { name: "strikeout", prob: 0.22, edge: -0.010, conf: 0.55 },
            { name: "walk", prob: 0.09, edge: 0.005, conf: 0.54 },
            { name: "hit", prob: 0.27, edge: 0.030, conf: 0.62 },
            { name: "out", prob: 0.36, edge: -0.025, conf: 0.57 },
          ], MKT),
          ab_pitches_ou: ou("ab_pitches_ou", 4.6, "over", 4.5, 0.54, 0.012, ALL),
        },
      },
    ];
  }

  // Flatten one best-edge opportunity per game × market for the board.
  function buildEdges(games) {
    const out = [];
    for (const g of games) {
      for (const key of Object.keys(MARKETS)) {
        const m = g.m[key];
        const meta = MARKETS[key];
        const pick = meta.kind === "ou"
          ? `${OUTCOME_LABEL[m.recommendation]} ${m.line}`
          : OUTCOME_LABEL[m.recommendation];
        out.push({
          id: `${g.gamePk}:${key}`, gamePk: g.gamePk, market: key,
          kind: meta.kind, marketLabel: meta.label, marketShort: meta.short,
          group: meta.group, pick, recommendation: m.recommendation,
          modelProb: m.modelProb, edge: m.edge, best: m.best, sources: m.best ? m.sources : [],
          predictedValue: m.predictedValue, line: m.line, probs: m.probs,
          stale: !!g.stale,
        });
      }
    }
    out.sort((a, b) => b.edge - a.edge);
    return out;
  }

  // Recent settled at-bats (proof points for the data feed).
  const RECENT = [
    { date: "2026-06-16", matchup: "TOR @ CLE", batter: "V. Guerrero Jr.", pick: "Strikeout",      market: "ab_result",     pitches: 5, price: -120, result: "win" },
    { date: "2026-06-16", matchup: "MIA @ CHC", batter: "M. Machado",      pick: "Next Pitch Over 95.5", market: "pitch_speed_ou", pitches: 1, price: -110, result: "win" },
    { date: "2026-06-16", matchup: "BAL @ TB",  batter: "G. Henderson",    pick: "Hit",            market: "ab_result",     pitches: 4, price: 140,  result: "loss" },
    { date: "2026-06-15", matchup: "STL @ MIL", batter: "W. Contreras",    pick: "Pitches Under 4.5", market: "ab_pitches_ou", pitches: 3, price: -105, result: "win" },
    { date: "2026-06-15", matchup: "KC @ MIN",  batter: "B. Witt Jr.",     pick: "Strikeout",      market: "ab_result",     pitches: 6, price: 105,  result: "win" },
    { date: "2026-06-15", matchup: "TEX @ LAA", batter: "M. Trout",        pick: "Strike or Foul", market: "pitch_result",  pitches: 1, price: -125, result: "push" },
    { date: "2026-06-14", matchup: "BOS @ NYY", batter: "A. Judge",        pick: "Walk",           market: "ab_result",     pitches: 7, price: 240,  result: "loss" },
    { date: "2026-06-14", matchup: "SF @ COL",  batter: "T. Estrada",      pick: "Pitches Over 4.5", market: "ab_pitches_ou", pitches: 6, price: -110, result: "win" },
  ];

  const RECORD = {
    overall: { wins: 312, losses: 248, pushes: 19, units: 41.6, roi: 7.2, picks: 579 },
    last30: { wins: 41, losses: 31, pushes: 3, units: 6.8, roi: 9.1, picks: 75 },
  };

  // ── live tick: subtle drift on edges/predicted, flag changed ids ────────
  function tick(games) {
    const r = (lo, hi) => lo + Math.random() * (hi - lo);
    const flash = new Set();
    for (const g of games) {
      if (g.stale) continue;
      for (const key of Object.keys(g.m)) {
        const m = g.m[key];
        if (m.kind === "ou" && Math.random() < 0.5) {
          const old = m.predictedValue;
          const step = key === "pitch_speed_ou" ? 0.15 : 0.1;
          m.predictedValue = +(old + r(-step, step)).toFixed(2);
          if (Math.abs(m.predictedValue - old) > 0.04) flash.add(`${g.gamePk}:${key}:pred`);
        }
        const pool = m.kind === "ou" ? [m] : m.outcomes;
        for (const o of pool) {
          for (const s of o.sources) {
            const oldE = s.edge;
            s.impliedProb = clampP(s.impliedProb + r(-0.004, 0.004));
            s.price = americanFromImplied(s.impliedProb);
            s.edge = calcEdge(o.modelProb, s.impliedProb);
            if (Math.abs(s.edge - oldE) > 0.002) flash.add(`${g.gamePk}:${key}:edge`);
          }
          o.best = bestOf(o.sources);
        }
        if (m.kind === "ou") { m.edge = m.best.edge; }
        else {
          const rec = m.outcomes.reduce((a, b) => (b.edge > a.edge ? b : a), m.outcomes[0]);
          m.recommendation = rec.name; m.recOutcome = rec; m.modelProb = rec.modelProb;
          m.edge = rec.edge; m.best = rec.best;
        }
      }
    }
    return flash;
  }

  // ── upcoming (on-deck batter) markets ───────────────────────────────────
  // The Live/Upcoming toggle lets users pre-scout the next hitter. We derive an
  // on-deck market book by nudging the current-batter model + prices so the
  // board has real content ahead of the at-bat.
  const ON_DECK = {
    746285: { name: "Trevor Story",     hand: "R", meta: "1/3 .248 · OPS .702" },
    746401: { name: "Mike Yastrzemski", hand: "L", meta: "0/2 .231 · OPS .746" },
    746502: { name: "Cal Raleigh",      hand: "S", meta: "1/3 .233 · OPS .812" },
    746611: { name: "Nolan Gorman",     hand: "L", meta: "1/4 .224 · OPS .743" },
    746712: { name: "Bryce Harper",     hand: "L", meta: "2/3 .289 · OPS .921" },
    746833: { name: "Bo Bichette",      hand: "R", meta: "2/4 .276 · OPS .783" },
  };
  const seeded = (pk) => { let x = (pk % 9973) + 1; return () => (x = (x * 48271) % 2147483647) / 2147483647; };
  function perturbUpcoming(m, rnd) {
    const c = JSON.parse(JSON.stringify(m));
    const nudge = (s, d) => { s.impliedProb = +clampP(s.impliedProb + d).toFixed(4); s.price = americanFromImplied(s.impliedProb); };
    // Null-safe best over a source list (live markets can have zero sources).
    const best = (rows) => (rows && rows.length ? rows.reduce((a, b) => (b.edge > a.edge ? b : a)) : null);
    const edgeOf = (o) => (o.best ? o.best.edge : -Infinity);
    if (c.kind === "ou") {
      c.modelProb = +clampP(c.modelProb + (rnd() - 0.55) * 0.08).toFixed(3);
      if (typeof c.predictedValue === "number") c.predictedValue = +(c.predictedValue + (rnd() - 0.5) * 0.9).toFixed(2);
      c.sources.forEach((s, i) => { nudge(s, (i % 2 ? 1 : -1) * (0.004 + rnd() * 0.01)); s.edge = calcEdge(c.modelProb, s.impliedProb); });
      c.best = best(c.sources); c.edge = c.best ? c.best.edge : null;
    } else {
      c.outcomes.forEach((o) => {
        o.modelProb = +clampP(o.modelProb + (rnd() - 0.5) * 0.08).toFixed(3);
        o.sources.forEach((s, i) => { nudge(s, (i % 2 ? 1 : -1) * (0.004 + rnd() * 0.01)); s.edge = calcEdge(o.modelProb, s.impliedProb); });
        o.best = best(o.sources);
      });
      const rec = c.outcomes.length
        ? c.outcomes.reduce((a, b) => (edgeOf(b) > edgeOf(a) ? b : a))
        : { name: c.recommendation, modelProb: c.modelProb, best: null };
      c.recommendation = rec.name; c.recOutcome = rec; c.modelProb = rec.modelProb;
      c.edge = rec.best ? rec.best.edge : null; c.best = rec.best;
    }
    return c;
  }
  // Per-pitch pre-pitch model reads (predicted speed + strike/ball/in-play
  // probabilities). Sample-data only and no longer rendered: the live backend
  // serves just the latest next-pitch prediction per market (no per-past-pitch
  // history), so the board shows the model's pitch-level read as a per-game
  // "Next pitch · model read" block instead of per-row feed columns.
  const PITCH_BASE_SPEED = { FF: 96.2, SI: 94.1, FC: 90.4, SL: 85.6, CB: 80.2, CH: 84.8, SP: 89.1, KC: 82.3, CU: 79.4 };
  function enrichPitchPredictions(games) {
    for (const g of games) {
      const rnd = seeded(g.gamePk * 31 + 7);
      for (const pt of g.pitches) {
        const base = PITCH_BASE_SPEED[pt.type] != null ? PITCH_BASE_SPEED[pt.type] : 90;
        pt.predSpeed = +(base + (rnd() - 0.5) * 2.2).toFixed(1);
        let a = 0.40 + rnd() * 0.24;      // strike / foul
        let b = 0.22 + rnd() * 0.20;      // ball
        let c = Math.max(0.05, 1 - a - b); // in play
        const sum = a + b + c;
        pt.pStrike = +(a / sum).toFixed(2);
        pt.pBall = +(b / sum).toFixed(2);
        pt.pInPlay = +(1 - pt.pStrike - pt.pBall).toFixed(2);
        // Per-value model edge (model prob − market implied). Some clear the
        // highlight threshold, some don't — deterministic per game.
        const edge = () => +(rnd() * 0.11 - 0.03).toFixed(3); // −0.030 … +0.080
        pt.predSpeedEdge = edge();
        pt.pStrikeEdge = edge();
        pt.pBallEdge = edge();
        pt.pInPlayEdge = edge();
      }
    }
  }

  function enrichUpcoming(games) {
    for (const g of games) {
      g.onDeckBatter = ON_DECK[g.gamePk] || { name: g.onDeck, hand: "R", meta: "" };
      const rnd = seeded(g.gamePk);
      g.mNext = {};
      for (const k of Object.keys(g.m)) g.mNext[k] = perturbUpcoming(g.m[k], rnd);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // LIVE ADAPTER — swap the sample buildGames() for real backend data.
  //
  // Normalizes GET /live (situation, current-PA pitches, per-market model probs)
  // joined with GET /edge/{game_pk} (per-source implied prob + edge) into the
  // exact game shape the board consumes. Everything the board reads goes through
  // here, so the render path is identical whether data is sample or live.
  //
  // Backend reality (honest degradation):
  //   • Only over/under markets are priced by a source today (the stub book,
  //     optionally Kalshi), so only those carry an edge; categorical markets
  //     arrive with model probs but no market price → no edge → skipped on the
  //     Edges/Markets boards, still shown in the Data Feed distribution/call.
  //   • /live has no score, venue, runners, or on-deck projection. Scores/venue
  //     render as "—"; the Upcoming book is derived by perturbing the live book
  //     (same mechanism as the sample), until a backend on-deck endpoint exists.
  // ════════════════════════════════════════════════════════════════════════

  // Map a backend source key to the board's source model (name/short/type/url).
  function boardSource(key, impliedProb, price, edge) {
    const norm = key === "draftkings_stub" ? "draftkings" : key;
    const meta = SOURCES[norm] || {
      key: norm, name: key, short: (key || "?").slice(0, 4).toUpperCase(),
      type: "book", url: "#",
    };
    const ip = impliedProb != null ? +impliedProb : null;
    return {
      source: norm, name: meta.name, short: meta.short, type: meta.type, url: meta.url,
      impliedProb: ip,
      price: price != null ? price : (ip != null ? americanFromImplied(ip) : null),
      edge: edge != null ? +edge : (ip != null ? null : null),
    };
  }

  function ouFromLive(key, liveMkt, edgeRow) {
    const src = ((edgeRow && edgeRow.sources) || [])
      .filter((s) => s.implied_prob != null)
      .map((s) => boardSource(s.source, s.implied_prob, s.price, s.edge));
    const best = src.length ? bestOf(src) : null;
    // modelProb must stay null when nothing scored this market. It used to
    // default to 0, and the renderer turned that into a confident-looking
    // "0%" — a game with no prediction was indistinguishable from one the
    // model genuinely called at zero.
    const rawProb = (edgeRow && edgeRow.confidence != null) ? edgeRow.confidence
      : (liveMkt && liveMkt.confidence != null ? liveMkt.confidence : null);
    return {
      market: key, kind: "ou",
      covered: !!(liveMkt || edgeRow),
      modelProb: rawProb != null ? +rawProb : null,
      predictedValue: (edgeRow && edgeRow.predicted_value != null ? edgeRow.predicted_value
        : (liveMkt && liveMkt.predicted_value)),
      line: (edgeRow && edgeRow.line != null ? edgeRow.line : (liveMkt && liveMkt.line)),
      recommendation: (edgeRow && edgeRow.recommendation) || (liveMkt && liveMkt.recommendation),
      sources: src, best, edge: best ? best.edge : null,
    };
  }

  function catFromLive(key, liveMkt, edgeRow) {
    // Full distribution comes from /live (argmax market carries `probs`);
    // /edge only reports the top outcome. No source prices categorical markets
    // today, so outcomes carry model probs with empty source lists.
    const probs = (liveMkt && liveMkt.probs) || {};
    const conf = (liveMkt && liveMkt.confidence) != null ? liveMkt.confidence : null;
    const outcomes = Object.keys(probs).map((name) => ({
      name, modelProb: probs[name], conf, sources: [], best: null, edge: null,
    }));
    let rec = (edgeRow && edgeRow.recommendation) || (liveMkt && liveMkt.recommendation);
    if (!rec && outcomes.length) {
      rec = outcomes.reduce((a, b) => (b.modelProb > a.modelProb ? b : a)).name;
    }
    const recOutcome = outcomes.find((o) => o.name === rec) || outcomes[0] || null;
    return {
      market: key, kind: "cat", probs, outcomes, recommendation: rec,
      covered: !!(liveMkt || edgeRow),
      recOutcome,
      // null, not 0 — see the note in ouFromLive.
      modelProb: recOutcome && recOutcome.modelProb != null ? +recOutcome.modelProb : null,
      edge: null, best: null, conf,
    };
  }

  // ── per-pitch prediction join ───────────────────────────────────────────
  // /live's pa_predictions carries the model's pre-pitch calls for the current
  // PA: a row at pitch_number k was scored after k pitches, i.e. it predicts
  // pitch k+1. Group rows by that position so each thrown pitch can be paired
  // with the call made before it, and the newest position becomes the read on
  // the upcoming (not yet thrown) pitch.
  function paPredsByPos(rows) {
    const byPos = {};
    (rows || []).forEach((r) => {
      if (!r || !r.market) return;
      const pos = r.pitch_number != null ? r.pitch_number : 0;
      const slot = byPos[pos] || (byPos[pos] = {});
      if (r.market === "pitch_result") slot.result = r;
      else if (r.market === "pitch_speed_ou") slot.speed = r;
    });
    return byPos;
  }
  // Shape one position's prediction pair for rendering; when the actual pitch
  // is known, grade each call with the same rules the settle job uses
  // (result: predicted class vs result_category; speed: over/under the line).
  function gradedPred(slot, actual) {
    if (!slot || (!slot.result && !slot.speed)) return null;
    const rp = slot.result, sp = slot.speed;
    const out = {
      resultCat: rp ? rp.recommendation : null,
      resultProb: rp && rp.probs && rp.recommendation != null && rp.probs[rp.recommendation] != null
        ? +rp.probs[rp.recommendation] : (rp && rp.confidence != null ? +rp.confidence : null),
      resultOk: null,
      speed: sp && sp.predicted_value != null ? +sp.predicted_value : null,
      speedRec: sp ? sp.recommendation : null,
      speedLine: sp && sp.line != null ? +sp.line : null,
      speedOk: null,
    };
    if (actual) {
      if (out.resultCat && actual.cat) out.resultOk = out.resultCat === actual.cat;
      if (out.speedRec && out.speedLine != null && actual.speed != null) {
        out.speedOk = (actual.speed > out.speedLine ? "over" : "under") === out.speedRec;
      }
    }
    return out;
  }

  function normalizeGame(lg, edgeRows) {
    const sit = lg.situation || {};
    const edgeByMarket = {};
    (edgeRows || []).forEach((r) => { if (r && r.market) edgeByMarket[r.market] = r; });
    const liveByMarket = {};
    (lg.markets || []).forEach((m) => { if (m && m.market) liveByMarket[m.market] = m; });

    const m = {};
    for (const key of Object.keys(MARKETS)) {
      const meta = MARKETS[key];
      m[key] = meta.kind === "ou"
        ? ouFromLive(key, liveByMarket[key], edgeByMarket[key])
        : catFromLive(key, liveByMarket[key], edgeByMarket[key]);
    }

    const label = lg.game_label || "";
    let away = "", home = "";
    if (label.includes(" @ ")) { [away, home] = label.split(" @ ", 2); }
    // Prefer compact abbreviations + live scores when the API supplies them.
    if (lg.away_abbr) away = lg.away_abbr;
    if (lg.home_abbr) home = lg.home_abbr;

    const pitches = (lg.current_pa_pitches || []).map((p) => ({
      n: p.pitch_number, type: p.pitch_type || "—",
      speed: p.start_speed != null ? +p.start_speed : null,
      zone: p.zone != null ? p.zone : "—",
      desc: p.description || "", cat: p.result_category || "",
      balls: p.balls || 0, strikes: p.strikes || 0,
    }));

    // Pair each thrown pitch with the model call made before it (position
    // n-1 predicts pitch n) and grade it; the call at the current position is
    // the pending read on the next pitch.
    const predPos = paPredsByPos(lg.pa_predictions);
    pitches.forEach((pt) => { pt.pred = gradedPred(predPos[(pt.n || 0) - 1], pt); });
    const nextPred = gradedPred(predPos[pitches.length], null);

    let stale = false;
    if (sit.last_pitch_ts) {
      const age = Date.now() - Date.parse(sit.last_pitch_ts);
      if (isFinite(age) && age > 30000) stale = true;
    }

    return {
      gamePk: lg.game_pk, away: away || "AWY", home: home || "HOM",
      label: label || `${away} @ ${home}`, venue: lg.venue || "",
      score: {
        away: sit.away_score != null ? String(sit.away_score) : "—",
        home: sit.home_score != null ? String(sit.home_score) : "—",
      },
      // `id` is carried through for the Data Feed's warehouse lookups, which
      // are keyed on player id. The live board renders names only.
      pitcher: { id: lg.pitcher_id || null, name: lg.pitcher_name || "TBD", hand: lg.pitcher_hand || "", meta: "" },
      batter: { id: lg.batter_id || null, name: lg.batter_name || "TBD", hand: lg.batter_hand || "", meta: "" },
      onDeck: "On-deck TBD",
      inning: sit.inning, half: sit.half || "▲", count: sit.count || "0-0",
      outs: sit.outs || 0,
      runners: { first: false, second: false, third: false },
      pitchCountPa: sit.pitch_count_pa != null ? sit.pitch_count_pa : pitches.length,
      pitchCountGame: null, pitches, nextPred, lastPitch: sit.last_pitch_ts, stale, m,
      modelVersion: lg.model_version || null,
      // Phase + coverage are what let the board render a scheduled game
      // honestly: which markets exist, which do not, and why the situation
      // panel is empty.
      phase: lg.phase || (sit.inning != null ? "live" : "pregame"),
      status: lg.status || null,
      startTs: lg.start_ts || null,
      coverage: lg.coverage || null,
      probables: {
        home: (lg.probable_home_pitcher && lg.probable_home_pitcher.name) || null,
        away: (lg.probable_away_pitcher && lg.probable_away_pitcher.name) || null,
        homeId: (lg.probable_home_pitcher && lg.probable_home_pitcher.id) || null,
        awayId: (lg.probable_away_pitcher && lg.probable_away_pitcher.id) || null,
      },
    };
  }

  // Fetch + normalize the live board. Resolves to [] when there's nothing live
  // so the caller can keep the sample board on screen. Throws on network error
  // so the caller can distinguish "backend down" from "no games right now".
  async function loadLive(apiBase, fetchImpl) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const res = await f(`${apiBase}/live`);
    if (!res.ok) throw new Error(`/live ${res.status}`);
    const live = await res.json();
    if (!Array.isArray(live) || !live.length) return [];
    // Wagering surfaces off → no odds/edge data is fetched at all; markets
    // normalize from /live alone (model probs, no source prices, edge null).
    const wager = !!(window.PH_FEATURES && window.PH_FEATURES.wageringInsights);
    const edgeRows = wager ? await Promise.all(live.map(async (lg) => {
      try {
        const r = await f(`${apiBase}/edge/${lg.game_pk}`);
        return r.ok ? await r.json() : [];
      } catch (_e) { return []; }
    })) : live.map(() => []);
    const games = live.map((lg, i) => normalizeGame(lg, edgeRows[i]));
    enrichUpcoming(games); // derive mNext + on-deck placeholder (see note above)
    return games;
  }

  // Fetch the whole day: yesterday's graded recap, what's live now, and what's
  // still to come. This is the boot call — /live alone returned only in-progress
  // games, so before first pitch the board had nothing to render.
  async function loadBoard(apiBase, fetchImpl, date) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const qs = date ? `?date=${encodeURIComponent(date)}` : "";
    const res = await f(`${apiBase}/board${qs}`);
    if (!res.ok) throw new Error(`/board ${res.status}`);
    const b = await res.json();
    const norm = (arr) => {
      const games = (arr || []).map((lg) => normalizeGame(lg, []));
      enrichUpcoming(games);
      return games;
    };
    return {
      date: b.date || null,
      recap: b.recap || null,
      live: norm(b.live),
      upcoming: norm(b.upcoming),
      final: norm(b.final),
    };
  }

  // The 30-day rolling feed. Filters map straight onto /api/feed's query
  // params; anything null is omitted so the server applies its own default.
  async function loadFeed(apiBase, filters, fetchImpl) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const qs = new URLSearchParams();
    Object.keys(filters || {}).forEach((k) => {
      const v = filters[k];
      if (v != null && v !== "" && v !== "all") qs.set(k, v);
    });
    const res = await f(`${apiBase}/feed?${qs.toString()}`);
    if (!res.ok) throw new Error(`/feed ${res.status}`);
    return await res.json();
  }

  // Per-pitch graded predictions for one day, paginated.
  //
  // Replaces the Data Feed's old session-accumulated log. The server has been
  // making and grading these predictions all along; nothing served them, so
  // the browser rebuilt a partial copy from whatever it happened to watch.
  // Every user now gets the same rows for the same day.
  async function loadPitches(apiBase, params, fetchImpl) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const qs = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v != null && v !== "" && v !== "all") qs.set(k, v);
    });
    const res = await f(`${apiBase}/pitches?${qs.toString()}`);
    if (!res.ok) throw new Error(`/pitches ${res.status}`);
    return await res.json();
  }

  // Live-only boot: the board starts empty and fills from loadLive(). The
  // sample generators above are kept for local demos (call buildGames() +
  // enrichUpcoming/enrichPitchPredictions by hand); RECENT/RECORD sample
  // literals are likewise not exported until graded picks ship in the UI.
  const games = [];
  return {
    SOURCES, MARKETS, OUTCOME_LABEL, RECENT: [], RECORD: null,
    games, edges: [], buildEdges,
    tick, impliedFromAmerican, americanFromImplied, calcEdge,
    mlbDate,
    loadLive, loadBoard, loadFeed, loadPitches,
    buildGames, enrichUpcoming, enrichPitchPredictions,
  };
})();

window.dispatchEvent(new Event("pitchhawk-ready"));
