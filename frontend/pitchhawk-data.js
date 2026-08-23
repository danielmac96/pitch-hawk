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

  const bestOf = (rows) => rows.reduce((a, b) => (b.edge > a.edge ? b : a), rows[0]);

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

  // Per-day, per-market grading history.
  //
  // The only source of accuracy for a day older than the 21-day raw-prediction
  // prune: `prediction_accuracy_daily` is rolled up nightly and never pruned,
  // so this answers "how has the model been doing" long after /pitches has
  // forgotten the individual calls. The server already sums the
  // per-model_version split, so a row here is one (day, market).
  async function loadAccuracy(apiBase, filters, fetchImpl) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const qs = new URLSearchParams();
    Object.keys(filters || {}).forEach((k) => {
      const v = filters[k];
      if (v != null && v !== "" && v !== "all") qs.set(k, v);
    });
    const res = await f(`${apiBase}/accuracy?${qs.toString()}`);
    if (!res.ok) throw new Error(`/accuracy ${res.status}`);
    return await res.json();
  }


  // Every prediction made in ONE game, all at-bats, newest first.
  //
  // /live only ever carries the current plate appearance, so the board used to
  // rebuild earlier at-bats in the browser by watching each poll — which meant
  // the strip was empty on first paint, disagreed between two people watching
  // the same game, and was wiped by a reload. The server has had every one of
  // these rows all along.
  //
  // Ungraded rows are included deliberately (no `status` filter): the at-bat in
  // progress has not been settled yet and is exactly the one the board is
  // showing.
  async function loadGamePitches(apiBase, gamePk, date, fetchImpl, markets) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const rows = [];
    let cursor = 0;
    // A single game is ~1,200 rows at full per-pitch coverage; 1000 is the
    // server's page ceiling, so this is bounded at a handful of round trips.
    for (let page = 0; page < 8; page += 1) {
      const qs = new URLSearchParams({ game_pk: String(gamePk), limit: "1000" });
      if (date) qs.set("date", date);
      if (markets && markets.length) qs.set("market", markets.join(","));
      if (cursor) qs.set("cursor", String(cursor));
      const res = await f(`${apiBase}/pitches?${qs.toString()}`);
      if (!res.ok) throw new Error(`/pitches ${res.status}`);
      const body = await res.json();
      rows.push(...(body.rows || []));
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
    }
    return rows;
  }


  // Live-only boot: the board starts empty and fills from loadLive(). There is
  // no offline fallback -- the synthetic demo generators that used to sit here
  // were never wired into the load path and were removed in 2026-08.
  const games = [];
  return {
    MARKETS, OUTCOME_LABEL,
    games,
    mlbDate,
    loadLive, loadBoard, loadFeed, loadGamePitches, loadAccuracy,
  };
})();

window.dispatchEvent(new Event("pitchhawk-ready"));
