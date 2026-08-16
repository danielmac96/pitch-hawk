// ════════════════════════════════════════════════════════════════════════
// pitchhawk.js — Pitch Hawk single-page app.
//
// One page, three tabs: Home / Live Markets / Data Feed. Vanilla port of the
// design reference's `class Component` (design_handoff_live_markets) — same
// client state and data shaping (homeVals / liveVals / dataVals), rendered to
// the DOM without a framework. Markup mirrors the design's inline-styled
// template so it's pixel-faithful across the light/dark token palette.
//
// Data layer (live-only):
//   • Home shows today's schedule from GET /games, refreshed alongside polls.
//   • Live Markets + Data Feed read window.PITCHHAWK.games, filled exclusively
//     by PITCHHAWK.loadLive (/live + /edge). The board is empty outside game
//     windows. No odds are ingested yet, so price/edge columns render "—";
//     picks and the graded record return to the UI when odds ship.
// ════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  const API_BASE = window.PITCH_EDGE_API || "http://localhost:8080";
  const POLL_MS = 8000;   // backend polls MLB every ~8s (POLL_INTERVAL_SECONDS)
  // Last pitcher/batter/game the Data Feed showed. Persisted so the warehouse
  // scouting panels survive a reload — the session graded log cannot, because
  // nothing stores per-pitch prediction history (that store is deferred).
  const SCOUT_KEY = "ph.scout.v1";

  const PH = window.PITCHHAWK;
  const COPY = window.PH_COPY;
  // Wagering surfaces (source filters, edge highlighting/columns, settled
  // picks) render only when the flag is on — see config.js / copy.js.
  const WAGER = !!(window.PH_FEATURES && window.PH_FEATURES.wageringInsights);

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // The board is locked to dark mode (product decision) — no light theme, no
  // toggle. The light CSS tokens and the dk()/light color forks below are kept
  // dormant so the light path stays trivially revivable if that ever changes.
  function initialDark() {
    return true;
  }

  // ── Home data loaders ─────────────────────────────────────────────────
  async function fetchJson(path, init) {
    try {
      const r = await fetch(`${API_BASE}${path}`, init);
      return r.ok ? await r.json() : null;
    } catch (_e) { return null; }
  }
  // Game status helpers shared by the home slate and the live-board filters.
  const isLiveStatus = (s) => /in progress|live|manager challenge/i.test(s || "");
  const isFinalStatus = (s) => /final|game over|completed/i.test(s || "");

  // Live-game count for the header + glance tiles. The slate's MLB status is
  // the source of truth — the per-game `stale` flag only means "no pitch in
  // 30s" (inning breaks, mound visits) and must not zero this counter.
  const liveNowCount = () =>
    Array.isArray(SLATE)
      ? SLATE.filter((g) => isLiveStatus(g.status)).length
      : PH.games.length;

  // Upcoming games slate (GET /games). null = not loaded yet, [] = none scheduled.
  let SLATE = null;
  let SLATE_AT = 0;
  async function fetchSlate() {
    if (SLATE !== null && Date.now() - SLATE_AT < 60000) return false;
    const rows = await fetchJson("/games");
    if (!Array.isArray(rows)) return false;
    SLATE_AT = Date.now();
    const changed = JSON.stringify(rows) !== JSON.stringify(SLATE);
    SLATE = rows;
    return changed;
  }

  // Last completed slate, graded. Fetched from /board and refreshed rarely —
  // it only changes when a day finishes. This is what the Live Board shows
  // above everything else, and it is why there is no longer an empty state:
  // at 9am, before a pitch is thrown, yesterday's numbers fill the screen.
  let RECAP = null;
  let RECAP_AT = 0;
  let RECAP_ERR = false;
  // On boot this is the FIRST paint: /board returns the recap plus the whole
  // slate in one call, so the board has content before the 8s /live poll has
  // even fired. Afterwards it refreshes only every 5 minutes, because a
  // completed slate does not change.
  async function fetchRecap(force) {
    if (!force && RECAP !== null && Date.now() - RECAP_AT < 300000) return false;
    try {
      const b = await PH.loadBoard(API_BASE);
      RECAP_AT = Date.now();
      RECAP_ERR = false;
      const changed = JSON.stringify(b && b.recap) !== JSON.stringify(RECAP);
      RECAP = (b && b.recap) || null;
      // Seed the slate on a cold start; the live poll takes over from here and
      // must not be clobbered once it has run.
      if (!PH.games || !PH.games.length) {
        PH.games = [].concat(b.live || [], b.upcoming || [], b.final || []);
      }
      return changed;
    } catch (_e) {
      // Distinct from "no games": the board must never present a fetch failure
      // as a quiet day.
      RECAP_ERR = true;
      RECAP_AT = Date.now();
      return false;
    }
  }

  class Board {
    constructor(root) {
      this.root = root;
      this.state = {
        view: "home",
        focusGame: null, dfGame: "all", mkt: "all", openLog: null,
        // How many earlier at-bats the Live Board strip reveals, raised by its
        // "show more" control. A full game runs to ~55 plate appearances.
        paShow: 12,
        // Which slate the graded log is showing, as an America/New_York
        // date. null means today; the Yesterday chip sets the prior date.
        dfDate: null,
        // How many graded-log rows are revealed. Bumped by the "show more"
        // control so a full slate is reachable rather than truncated.
        dfShow: 60,
        liveGames: {}, liveSources: { draftkings: true, fanduel: true, kalshi: true, polymarket: true },
        edgeThreshold: 0.03,
        dark: initialDark(), t: 0,
        // Phase 4 aggregates. `loaded` stays false until the first fetch
        // settles, so the panels are absent rather than flashing empty.
        scout: { seed: null, ctx: null, profile: null, fatigue: null, matchup: null, loaded: false },
        // Durable prediction history from /api/feed.
        feed: { rows: [], players: [], summary: null, loaded: false, err: false },
        // `phase` is a real filter, not cosmetic: game_predictions holds a
        // pregame row and a live row per (game, market), so leaving it open
        // shows every game twice — the call made before first pitch and the
        // one it finished on.
        feedF: { days: 30, market: "all", phase: "all", team: "", pitcher_id: "", batter_id: "" },
        // How many history rows are revealed, raised by "show more".
        feedShow: 120,
        // Per-pitch graded predictions for today, from /api/pitches. This
        // replaced a session-accumulated array: the server has been making and
        // grading these all along, so the table is now identical for every
        // user, complete from the first game of the day, and survives a
        // reload.
        pitchFeed: { rows: [], summary: null, loaded: false, err: false },
      };
      this._pollIv = null;
      // Per-game plate-appearance history, keyed by game_pk and filled from
      // /api/pitches (see syncPaHistory). `_paSig` gates the refetch so it runs
      // when the at-bat turns over, not on every 8s poll.
      this.paHist = {};
      this._paSig = {};
      // Warehouse-backed scouting panels. `_scoutSigs` gates re-fetching per
      // panel, so a new batter does not re-request the pitcher profile or the
      // game context.
      this._scoutSigs = {};
      this._feedSig = null;
      this.root.addEventListener("click", (e) => this._onClick(e));
      // `change` rather than `input`: it fires on blur/Enter, so a re-render
      // never lands mid-keystroke. Combined with the focus guard in render(),
      // typing in a filter box survives the 8s poll.
      this.root.addEventListener("change", (e) => this._onFilterChange(e));
    }

    _onFilterChange(e) {
      const el = e.target && e.target.closest ? e.target.closest("[data-feedfilter]") : null;
      if (!el) return;
      const key = el.getAttribute("data-feedfilter");
      const val = (el.value || "").trim();
      if (this.state.feedF[key] === val) return;
      this.state.feedF[key] = val;
      this.syncFeed();
      this.render();
    }
    setState(patch) { Object.assign(this.state, patch); this.render(); }

    // ── formatters ───────────────────────────────────────────────────────
    dk() { return this.state.dark; }
    // A missing prediction renders as "—", never as 0%.
    //
    // This used to be `Math.round((p || 0) * 100)`, so an unscored market — the
    // normal state of every game before first pitch — displayed as a confident
    // "0%". That is a wrong number presented as a real one, which is worse than
    // an empty cell.
    pct(p) { return p == null ? "—" : Math.round(p * 100) + "%"; }
    fmtEdge(e) { return e == null ? "—" : (e >= 0 ? "+" : "−") + (Math.abs(e) * 100).toFixed(1) + "%"; }
    am(a) { return a == null ? "—" : (a > 0 ? "+" + a : "" + a); }
    tier(e) {
      const d = this.dk(), P = (l, dv) => (d ? dv : l);
      if (e == null) return { bg: P("#eef1f7", "#1e2b40"), fg: P("#8590a3", "#7c8ca3"), label: "—" };
      if (e >= 0.05) return { bg: P("#dff1e7", "#123020"), fg: P("#0f7a44", "#5fe093"), label: "Strong" };
      if (e >= 0.03) return { bg: P("#e8f4ed", "#12301f"), fg: P("#2f9159", "#54cf86"), label: "Solid" };
      if (e >= 0.01) return { bg: P("#eef3f0", "#182a20"), fg: P("#5a8a6c", "#8fc7a3"), label: "Slim" };
      if (e > -0.01) return { bg: P("#eef1f7", "#1e2b40"), fg: P("#8590a3", "#8493aa"), label: "Flat" };
      return { bg: P("#fbece9", "#3a1c1a"), fg: P("#c0392f", "#ff7b6b"), label: "Neg" };
    }
    resultMeta(desc) {
      const d = this.dk();
      const g = d ? "#4ade80" : "#0f7a44", bl = d ? "#6aa2ff" : "#2563c9", am = d ? "#e0a83a" : "#b07d12",
        rd = d ? "#ff7b6b" : "#c0392f", mu = d ? "#8493aa" : "#7a879c";
      const m = {
        called_strike: ["Called Strike", g], swinging_strike: ["Swinging Strike", g],
        ball: ["Ball", mu], foul: ["Foul", am],
        in_play: ["In Play", bl], hit_by_pitch: ["HBP", rd],
      };
      return m[desc] || [desc || "—", mu];
    }
    player(p) { return p.hand ? `${p.name} (${p.hand})` : p.name; }
    chipSm(e) {
      const t = this.tier(e);
      return `font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:.82rem;padding:.16rem .5rem;border-radius:6px;background:${t.bg};color:${t.fg};white-space:nowrap;`;
    }
    // strike-zone plot position (percent) for an MLB zone id
    zonePos(zone) {
      const map = {
        1: [33.3, 32], 2: [50, 32], 3: [66.7, 32],
        4: [33.3, 50], 5: [50, 50], 6: [66.7, 50],
        7: [33.3, 68], 8: [50, 68], 9: [66.7, 68],
        11: [13, 14], 12: [87, 14], 13: [13, 86], 14: [87, 86],
      };
      return map[zone] || [50, 50];
    }
    // colour per pitch type (shared by zone plot + feed Type column)
    pitchColor(type) {
      const map = { FF: "#e0392f", FA: "#e0392f", SI: "#e8863a", FT: "#e8863a", FC: "#d6a11e", SL: "#2f8fd6", ST: "#2f8fd6", CB: "#8a5cf0", CU: "#8a5cf0", KC: "#8a5cf0", CH: "#26a269", SP: "#12a594", FS: "#12a594" };
      return map[type] || (this.dk() ? "#8493aa" : "#7a879c");
    }
    // velo → red (fast, 100) … orange (slow, 75)
    veloColor(sp) {
      const t = Math.max(0, Math.min(1, (sp - 75) / 25));
      const r = Math.round(245 + (220 - 245) * t), g = Math.round(158 + (38 - 158) * t), b = Math.round(11 + (38 - 11) * t);
      return `rgb(${r},${g},${b})`;
    }
    // ── prediction grading → cell shading ────────────────────────────────
    // The verdict rides on the cell background instead of a ✓/✗ mark, so a
    // dense log reads at a glance and spends no width on notation.
    //   velo  · |called − actual| ≤1.5 green · ≤3 amber · beyond red
    //   class · right green · wrong red · ungraded (pending/unknowable) neutral
    veloBand(delta) {
      if (delta == null || !isFinite(delta)) return null;
      const a = Math.abs(delta);
      return a <= 1.5 ? "good" : a <= 3 ? "amber" : "bad";
    }
    countBand(delta) {
      if (delta == null || !isFinite(delta)) return null;
      const a = Math.abs(delta);
      return a <= 1 ? "good" : a <= 2 ? "amber" : "bad";
    }
    gradeStyle(band) {
      const map = {
        good: ["var(--good-bg)", "var(--good-strong)"],
        amber: ["var(--amber-bg)", "var(--amber)"],
        bad: ["var(--bad-bg)", "var(--bad)"],
      };
      const t = map[band];
      return `background:${t ? t[0] : "transparent"};color:${t ? t[1] : "var(--text-2)"};`;
    }
    // A shaded cell: the actual value, then the model's pre-pitch call.
    gradedCell(band, main, sub) {
      return `<span style="display:inline-flex;align-items:baseline;gap:.4rem;min-width:0;padding:.16rem .42rem;border-radius:7px;${this.gradeStyle(band)}"><b style="font-weight:700;white-space:nowrap;">${main}</b>${sub ? `<span style="font-size:.74rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${sub}</span>` : ""}</span>`;
    }
    pendingCell(main, sub) {
      return `<span style="display:inline-flex;align-items:baseline;gap:.4rem;padding:.16rem .42rem;border-radius:7px;background:var(--good-bg);"><b style="font-weight:700;color:var(--accent);white-space:nowrap;">${main}</b>${sub ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:.74rem;color:var(--muted);">${sub}</span>` : ""}</span>`;
    }
    chipCell(band, text) {
      return `<span style="font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:.78rem;padding:.16rem .42rem;border-radius:7px;${this.gradeStyle(band)}">${esc(text)}</span>`;
    }
    veloCellHtml(actual, pred, pending) {
      const called = pred && pred.speed != null ? pred.speed : null;
      if (pending) {
        return called == null ? `<span style="color:var(--faint);">—</span>`
          : this.pendingCell(`<span style="font-family:'IBM Plex Mono',monospace;">${esc(called.toFixed(1))}</span>`, "called");
      }
      if (actual == null) return `<span style="font-family:'IBM Plex Mono',monospace;color:var(--faint);">—</span>`;
      const d = called == null ? null : called - actual;
      const sub = d == null ? ""
        : `<span style="font-family:'IBM Plex Mono',monospace;">${esc(called.toFixed(1))} · ${d >= 0 ? "+" : "−"}${esc(Math.abs(d).toFixed(1))}</span>`;
      return this.gradedCell(this.veloBand(d), `<span style="font-family:'IBM Plex Mono',monospace;">${esc(actual.toFixed(1))}</span>`, sub);
    }
    resultCellHtml(pitch, pred, pending) {
      const cat = pred && pred.resultCat ? pred.resultCat : null;
      const label = cat ? (PH.OUTCOME_LABEL[cat] || cat) : null;
      const prob = pred && pred.resultProb != null ? `${Math.round(pred.resultProb * 100)}%` : "";
      if (pending) {
        return !label ? `<span style="color:var(--faint);">—</span>` : this.pendingCell(esc(label), esc(prob));
      }
      if (!pitch) return `<span style="color:var(--faint);">—</span>`;
      const rm = this.resultMeta(pitch.desc);
      const band = pred && pred.resultOk === true ? "good" : pred && pred.resultOk === false ? "bad" : null;
      const main = band ? esc(rm[0]) : `<span style="color:${rm[1]};">${esc(rm[0])}</span>`;
      const sub = label ? `${esc(label)} <span style="font-family:'IBM Plex Mono',monospace;">${esc(prob)}</span>` : "";
      return this.gradedCell(band, main, sub);
    }
    // True when the last pitch ended the at-bat (ball in play, strike three,
    // ball four, HBP) — the pending model call is then for the NEXT batter's
    // first pitch, so the feed labels it that way instead of implying pitch N+1.
    abLikelyOver(pitches) {
      const lp = pitches[pitches.length - 1];
      if (!lp) return false;
      return lp.cat === "in_play" || lp.desc === "hit_by_pitch" ||
        (lp.balls || 0) >= 4 || (lp.strikes || 0) >= 3;
    }
    // ── at-bat history (server-backed) ───────────────────────────────────
    //
    // Until 2026-08-15 this strip was accumulated in the browser: /live carries
    // only the CURRENT plate appearance, so the board watched each poll and
    // archived a summary when the batter changed. That meant it was empty on
    // first paint, two people watching the same game saw different rows, and a
    // reload wiped it — someone joining in the 6th inning saw one at-bat of a
    // game the server had been scoring and grading since the 1st.
    //
    // /api/pitches has served every one of those rows all along, per game and
    // paginated. This reads them, so the strip is complete from first paint and
    // identical for everybody.
    //
    // Fetched for the FOCUSED game, and only when its at-bat has actually moved
    // — the board polls every 8s and this is a multi-page read.
    //
    // The game came off `state.feedGame` until 2026-08-16, but the Live Board's
    // selection is `state.focusGame` (see focused()). Nothing kept the two in
    // step — and nothing ever rendered a control for feedGame at all; poll()
    // simply pinned it to the first live game. So clicking any other game in the
    // rail fetched nothing, and every game but the first showed an empty strip
    // forever, however long it had been running.
    async syncPaHistory() {
      const g = this.focused();
      if (!g) return false;
      // The at-bat index is not on the live payload, so the batter plus the
      // half-inning is the signature that a PA has turned over. Kept per game,
      // not globally: a single signature meant switching games and switching
      // back refetched a game whose history had not moved.
      const sig = `${g.batter.name}|${g.inning}${g.half}|${g.phase}`;
      if (this._paSig[g.gamePk] === sig) return false;
      this._paSig[g.gamePk] = sig;
      try {
        // Eastern, because the server resolves the slate through
        // games.official_date — see the note in syncFeed().
        const rows = await PH.loadGamePitches(API_BASE, g.gamePk, PH.mlbDate(0));
        const all = PH.paSummaries(rows); // newest at-bat first
        // The at-bat in progress is the one the main panel is already showing,
        // so the strip starts at the one before it. On a finished game there is
        // nothing live and every at-bat belongs in the history.
        const earlier = g.phase === "live" ? all.slice(1) : all;
        // Every plate appearance, not the first twelve. The old cap predated the
        // server-backed fetch and silently hid most of a game — 55 PAs by the
        // 9th, of which 12 were reachable.
        this.paHist[g.gamePk] = earlier.map((s) => this.bandPa(s));
        return true;
      } catch (_e) {
        // Keep whatever we had; the strip is history, not the live read.
        delete this._paSig[g.gamePk];
        return false;
      }
    }
    // Display bands are a presentation concern, so they stay here rather than
    // in the data layer that shapes the server rows.
    bandPa(s) {
      return Object.assign({}, s, {
        pitchBand: s.projPitches == null ? null : this.countBand(s.projPitches - s.pitches),
        veloBand: this.veloBand(s.avgErr),
        pickBand: s.ratio == null ? null : s.ratio >= 0.6 ? "good" : s.ratio >= 0.4 ? "amber" : "bad",
      });
    }
    liveGameOn(pk) { return this.state.liveGames[pk] !== false; }
    selLiveSourceSet() { const s = this.state.liveSources; return new Set(Object.keys(s).filter((k) => s[k])); }

    // ── click delegation ─────────────────────────────────────────────────
    _onClick(e) {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      const act = el.getAttribute("data-act");
      const arg = el.getAttribute("data-arg");
      switch (act) {
        case "view": return this.setState({ view: arg });
        case "goHome": return this.setState({ view: "home" });
        case "goLive": return this.setState({ view: "live" });
        case "feedDays": {
          this.state.feedF.days = Number(arg) || 30;
          this.state.feedShow = 120;
          this.syncFeed();
          return this.render();
        }
        case "feedMarket": {
          this.state.feedF.market = arg;
          this.state.feedShow = 120;
          this.syncFeed();
          return this.render();
        }
        case "feedPhase": {
          this.state.feedF.phase = arg;
          this.state.feedShow = 120;
          this.syncFeed();
          return this.render();
        }
        case "feedMore": return this.setState({ feedShow: (this.state.feedShow || 120) + 240 });
        case "feedClear": {
          this.state.feedF = {
            days: 30, market: "all", phase: "all", team: "", pitcher_id: "", batter_id: "",
          };
          this.state.feedShow = 120;
          this.syncFeed();
          return this.render();
        }
        case "liveGame": {
          const pk = Number(arg);
          const o = Object.assign({}, this.state.liveGames); o[pk] = this.liveGameOn(pk) ? false : true;
          return this.setState({ liveGames: o });
        }
        case "liveAllGames": return this.setState({ liveGames: {} });
        case "liveSource": {
          const s = Object.assign({}, this.state.liveSources); s[arg] = !s[arg];
          return this.setState({ liveSources: s });
        }
        case "focusGame": {
          // Paint the selection immediately, then pull that game's at-bat
          // history in behind it — waiting for the next 8s poll to notice made
          // the rail feel dead for up to eight seconds after every click.
          this.setState({ focusGame: Number(arg), paShow: 12 });
          this.syncPaHistory()
            .then((changed) => { if (changed) this.render(); })
            .catch(() => {});
          return;
        }
        case "paMore": return this.setState({ paShow: (this.state.paShow || 12) + 24 });
        case "dfGame": {
          this.setState({ dfGame: arg === "all" ? "all" : Number(arg), dfShow: 60 });
          // Scope is applied server-side, so the chip needs a refetch. Render
          // immediately off the old rows (filtered by the guard in dfRows) and
          // again when the new page lands.
          this.loadPitchFeed()
            .then((changed) => { if (changed) this.render(); })
            .catch(() => {});
          // The scouting panels describe a pitcher, a batter and a game, so
          // they follow this selector too.
          this.syncScouting();
          return;
        }
        case "dfDate": {
          // "today" -> null so the request omits `date` and the server applies
          // its own America/New_York today, which is the authority.
          this.setState({ dfDate: arg === "today" ? null : arg, dfShow: 60 });
          this.loadPitchFeed()
            .then((changed) => { if (changed) this.render(); })
            .catch(() => {});
          return;
        }
        case "dfMore": {
          // Revealing more can outrun what has been fetched, so this pulls the
          // next page in behind the reveal rather than showing a short table.
          this.setState({ dfShow: this.state.dfShow + 120 });
          this.loadPitchFeed()
            .then((changed) => { if (changed) this.render(); })
            .catch(() => {});
          return;
        }
        case "mkt": {
          // The market is a server-side filter too, so narrowing to one
          // refills the pages with rows of it rather than filtering a mixed
          // page down. The client-side filter in the renderer still applies
          // and covers the tick before this lands.
          this.setState({ mkt: arg, dfShow: 60 });
          this.loadPitchFeed()
            .then((changed) => { if (changed) this.render(); })
            .catch(() => {});
          return;
        }
        case "logRow": return this.setState({ openLog: this.state.openLog === arg ? null : arg });
      }
    }

    // ══ HEADER / FOOTER ══════════════════════════════════════════════════
    headerHtml() {
      const view = this.state.view;
      const tabs = COPY.tabs.map(([k, label]) => {
        const on = view === k;
        return `<button data-act="view" data-arg="${k}" class="ph-tab${on ? " ph-tab-on" : ""}">${label}</button>`;
      }).join("");
      const liveCount = liveNowCount();
      const liveText = liveCount
        ? `${liveCount} game${liveCount === 1 ? "" : "s"} live · auto-refreshing`
        : "No games live right now";
      return `
      <header style="position:sticky;top:0;z-index:50;background:var(--header-bg);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);">
        <div class="ph-header-inner">
          <div data-act="goHome" style="display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:1.16rem;letter-spacing:-.02em;color:inherit;cursor:pointer;">
            <span style="color:var(--accent);font-size:.85rem;">◆</span>
            <span>Pitch<span style="color:var(--accent);">Hawk</span></span>
          </div>
          <div style="display:flex;align-items:center;gap:.42rem;font-size:.78rem;color:var(--muted);font-weight:600;">
            <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:ph-pulse 1.8s ease-in-out infinite;"></span>
            ${esc(liveText)}
          </div>
          <nav class="ph-nav">${tabs}</nav>
        </div>
      </header>`;
    }
    footerHtml() {
      return `
      <footer class="ph-footer">
        <div style="width:min(1220px,95vw);margin:0 auto;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:center;">
          <div data-act="goHome" style="display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:1.05rem;color:inherit;cursor:pointer;"><span style="color:#4ade80;">◆</span> Pitch<span style="color:#4ade80;">Hawk</span></div>
          <p style="margin:0;font-size:.74rem;color:#8a9bb2;max-width:46rem;flex:1;min-width:240px;">${esc(COPY.footerDisclaimer)}</p>
        </div>
      </footer>`;
    }

    // ══ HOME ═════════════════════════════════════════════════════════════
    homeHtml() {
      const slate = SLATE;
      const liveNow = liveNowCount();
      const fmtTime = (ts) => {
        const d = new Date(ts);
        return isNaN(d) ? "TBD" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      };

      const fmtDay = (ts) => {
        const d = new Date(ts);
        return isNaN(d) ? "" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      };
      const fmtDow = (ts) => {
        const d = new Date(ts);
        return isNaN(d) ? "" : d.toLocaleDateString(undefined, { weekday: "short" });
      };
      const sameLocalDay = (ts, ref) => {
        const d = new Date(ts);
        return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
      };
      // /games can span today and tomorrow — always render first upcoming to last.
      const sorted = Array.isArray(slate)
        ? slate.slice().sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts))
        : slate;

      // hero — live status at a glance (picks + record return when odds ship)
      const now = new Date();
      const leftToday = Array.isArray(sorted)
        ? sorted.filter((g) => sameLocalDay(g.start_ts, now) && !isFinalStatus(g.status)).length
        : null;
      const nextUp = Array.isArray(sorted)
        ? sorted.find((g) => !isLiveStatus(g.status) && !isFinalStatus(g.status))
        : null;
      const firstPitch = nextUp
        ? (sameLocalDay(nextUp.start_ts, now) ? "" : fmtDow(nextUp.start_ts) + " ") + fmtTime(nextUp.start_ts)
        : null;
      const doneToday = Array.isArray(sorted)
        ? sorted.filter((g) => isFinalStatus(g.status)).length
        : null;
      const glance = [
        { big: String(liveNow), lbl: "live right now" },
        { big: doneToday == null ? "—" : String(doneToday), lbl: "games completed" },
        { big: leftToday == null ? "—" : String(leftToday), lbl: "games left today" },
        { big: firstPitch || "—", lbl: "next game first pitch" },
      ].map((t) => `
            <div style="display:flex;flex-direction:column;"><span style="font-family:'IBM Plex Mono',monospace;font-size:1.7rem;font-weight:800;">${esc(t.big)}</span><span style="font-size:.76rem;color:#9fb2c9;margin-top:.15rem;">${esc(t.lbl)}</span></div>`).join("");
      const hero = `
      <div class="ph-hero" style="background:linear-gradient(180deg,var(--surface),var(--bg));border:1px solid var(--border);border-radius:18px;padding:clamp(1.3rem,4vw,2.6rem);margin-bottom:1.4rem;">
        <div>
          <span style="display:inline-block;font-size:.74rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--good-strong);background:var(--good-bg);padding:.3rem .6rem;border-radius:999px;margin-bottom:1rem;">${esc(COPY.heroBadge)}</span>
          <h1 style="font-size:clamp(1.9rem,4vw,3rem);font-weight:800;letter-spacing:-.02em;margin:0;line-height:1.08;">${esc(COPY.heroTitle)}</h1>
          <p style="font-size:1.08rem;color:var(--text-2);max-width:34rem;margin:1rem 0 1.4rem;">${esc(COPY.heroSub)}</p>
          <div style="display:flex;gap:.7rem;flex-wrap:wrap;">
            <button data-act="goLive" style="display:inline-flex;align-items:center;justify-content:center;gap:.4rem;font-weight:600;font-size:.92rem;padding:.62rem 1.05rem;border-radius:9px;border:1px solid transparent;background:var(--accent);color:#fff;cursor:pointer;font-family:inherit;">${esc(COPY.heroCta)}</button>
          </div>
          ${COPY.heroCompliance ? `<p style="margin-top:1rem;font-size:.8rem;color:var(--muted);letter-spacing:.02em;">${esc(COPY.heroCompliance)}</p>` : ""}
        </div>
        <div style="background:var(--bc-bg);color:#fff;border-radius:14px;padding:1.4rem 1.5rem;box-shadow:0 12px 40px rgba(15,27,45,.18);">
          <span style="font-size:.78rem;font-weight:600;color:#9fb2c9;letter-spacing:.04em;text-transform:uppercase;">Today at a glance</span>
          <div style="display:flex;gap:1.3rem;margin:1.1rem 0 1.2rem;flex-wrap:wrap;">${glance}</div>
          <div style="font-size:.88rem;font-weight:600;color:#8fd3ad;">${liveNow ? "Games are live — the model is reading every pitch." : "Live model reads begin at first pitch."}</div>
        </div>
      </div>`;

      // Game slate (GET /games) as a card grid: live first, then upcoming by
      // first pitch, finals (with final score) last. Scheduled games carry no
      // status chip — the start time IS the status.
      const statusRank = (g) => (isLiveStatus(g.status) ? 0 : isFinalStatus(g.status) ? 2 : 1);
      const display = Array.isArray(sorted)
        ? sorted.slice().sort((a, b) => statusRank(a) - statusRank(b) || new Date(a.start_ts) - new Date(b.start_ts))
        : sorted;
      let slateCards;
      if (display === null) {
        slateCards = `<div style="padding:1.4rem 1rem;color:var(--muted);font-style:italic;">Loading today's games…</div>`;
      } else if (!display.length) {
        slateCards = `<div style="padding:1.4rem 1rem;color:var(--muted);">No MLB games on today's schedule.</div>`;
      } else {
        const cards = display.map((g) => {
          const liveG = isLiveStatus(g.status);
          const finalG = isFinalStatus(g.status);
          const hasScore = g.away_score != null && g.home_score != null;
          const chip = liveG
            ? `<span style="font-size:.64rem;font-weight:800;letter-spacing:.05em;padding:.18rem .5rem;border-radius:6px;color:var(--good-strong);background:var(--good-bg);white-space:nowrap;">● LIVE</span>`
            : finalG
              ? `<span style="font-size:.64rem;font-weight:700;letter-spacing:.05em;padding:.18rem .5rem;border-radius:6px;color:var(--muted);background:var(--surface-2);white-space:nowrap;">FINAL</span>`
              : "";
          // Big slot: score for live/final games, first-pitch time for scheduled.
          const big = (liveG || finalG) && hasScore
            ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:1.45rem;font-weight:700;line-height:1;${finalG ? "" : "color:var(--good-strong);"}">${esc(g.away_score)}<span style="color:var(--vs);font-weight:600;"> – </span>${esc(g.home_score)}</span>`
            : `<span style="font-family:'IBM Plex Mono',monospace;font-size:1.45rem;font-weight:700;line-height:1;">${esc(fmtTime(g.start_ts))}</span>`;
          const when = (liveG || finalG) && hasScore
            ? `${fmtDay(g.start_ts)} · ${fmtTime(g.start_ts)}`
            : fmtDay(g.start_ts);
          const foot = liveG
            ? `<button data-act="goLive" style="border:0;background:transparent;color:var(--accent);font-family:inherit;font-weight:700;font-size:.8rem;cursor:pointer;padding:0;text-align:left;">Watch live →</button>`
            : `<span style="font-size:.74rem;color:var(--muted);">${esc(g.away_team)} at ${esc(g.home_team)}</span>`;
          return `
          <div style="display:flex;flex-direction:column;gap:.45rem;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.85rem 1rem;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);${finalG ? "opacity:.82;" : ""}">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;">
              <span style="font-weight:800;font-size:.98rem;">${esc(g.away_abbr || g.away_team)} <span style="color:var(--vs);font-weight:500;">@</span> ${esc(g.home_abbr || g.home_team)}</span>
              ${chip}
            </div>
            ${big}
            <span style="font-size:.72rem;color:var(--faint);font-weight:600;">${esc(when)}</span>
            ${foot}
          </div>`;
        }).join("");
        slateCards = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(215px,100%),1fr));gap:.8rem;">${cards}</div>`;
      }
      const slateBlock = `
      <div style="margin-bottom:1.6rem;">
        <div style="margin-bottom:1rem;">
          <h2 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0;">${esc(COPY.slateTitle)}</h2>
          <p style="margin:.35rem 0 0;color:var(--muted);font-size:.95rem;">${esc(COPY.slateSub)}</p>
        </div>
        ${slateCards}
      </div>`;
      // live board promo
      const promo = `
      <div class="ph-promo" style="background:var(--bc-bg);border:1px solid var(--bc-inner);border-radius:18px;padding:clamp(1.3rem,4vw,2.6rem);margin-bottom:1.6rem;color:#fff;">
        <div>
          <span style="display:inline-block;font-size:.74rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6ee7a0;background:rgba(74,222,128,.13);padding:.3rem .6rem;border-radius:999px;margin-bottom:.9rem;">${esc(COPY.promoBadge)}</span>
          <h2 style="color:#fff;font-size:clamp(1.5rem,3vw,2.1rem);font-weight:800;letter-spacing:-.02em;margin:0;">${esc(COPY.promoTitle)}</h2>
          <p style="color:#b7c6da;font-size:1.02rem;line-height:1.6;margin:.9rem 0 1.5rem;max-width:34rem;">${esc(COPY.promoSub)}</p>
          <button data-act="goLive" style="display:inline-flex;align-items:center;justify-content:center;gap:.4rem;font-weight:600;font-size:.92rem;padding:.62rem 1.05rem;border-radius:9px;border:1px solid transparent;background:var(--accent);color:#fff;cursor:pointer;font-family:inherit;">${esc(COPY.heroCta)}</button>
        </div>
        <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.9rem;">
          ${COPY.promoBullets.map(([title, body]) => `<li style="display:flex;flex-direction:column;gap:.2rem;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:9px;padding:.85rem 1rem;"><b style="color:#fff;font-size:.96rem;">${esc(title)}</b><span style="color:#93a6bd;font-size:.86rem;line-height:1.5;">${esc(body)}</span></li>`).join("")}
        </ul>
      </div>`;

      // how it works
      const steps = COPY.steps.map(([n, title, body]) => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.3rem;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:var(--bc-bg);color:#fff;font-weight:800;margin-bottom:.8rem;">${n}</span>
          <h3 style="font-size:1.05rem;font-weight:700;margin:0 0 .35rem;">${esc(title)}</h3>
          <p style="margin:0;color:var(--text-2);font-size:.92rem;">${esc(body)}</p>
        </div>`).join("");
      const how = `
      <div>
        <h2 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0 0 1rem;">${esc(COPY.howTitle)}</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:1.1rem;">${steps}</div>
      </div>`;

      return hero + slateBlock + promo + how;
    }

    // ══ DARK PALETTE ═════════════════════════════════════════════════════
    // The board is dark-only (product decision), so the ported views use the
    // literal palette from the approved mocks 1b/1c/1d/1e rather than theme
    // tokens — there is no light fork to keep in sync.
    C = {
      bg: "#0c1424", panel: "#141f33", panel2: "#101b2e", panel3: "#0d1729", rail: "#0a1322",
      bd: "#253449", bd2: "#31435f", row: "#1a2740", chip: "#1b2942",
      txt: "#eef3f9", dim: "#aebdd2", mut: "#8493aa", faint: "#6f7f96", blue: "#7fa0c4", vs: "#3a4a63",
      acc: "#22a566", grn: "#4ade80", amb: "#e0a83a", red: "#ff7b6b",
      gsub: "#82ae92", gbd: "#1f3d2b", gbg: "linear-gradient(180deg,#12301f,#0f1f18)",
    };
    GRD = {
      good: { bg: "rgba(34,165,102,.22)", fg: "#5fe094" },
      amber: { bg: "rgba(224,168,58,.20)", fg: "#f0c063" },
      bad: { bg: "rgba(242,86,76,.20)", fg: "#ff9b8f" },
    };
    grd(band) { return this.GRD[band] || { bg: "transparent", fg: this.C.dim }; }

    // Mobile (1b/1e) and desktop (1c/1d) are distinct layouts, so the board picks
    // one and re-renders on the breakpoint crossing.
    mob() { return window.innerWidth < 1024; }
    // Between ~1024 and ~1240 the desktop layout has no room for a 380px side
    // column, so the prediction panel stacks under the feed instead.
    narrow() { return window.innerWidth < 1240; }
    _bindMq() {
      if (this._mqBound) return;
      this._mqBound = true;
      this._wasMob = this.mob(); this._wasNarrow = this.narrow();
      window.addEventListener("resize", () => {
        const m = this.mob(), n = this.narrow();
        if (m !== this._wasMob || n !== this._wasNarrow) { this._wasMob = m; this._wasNarrow = n; this.render(); }
      });
    }

    // ── small shared pieces ──────────────────────────────────────────────
    shortName(n) {
      const parts = String(n || "").trim().split(/\s+/);
      if (parts.length < 2) return n || "—";
      return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
    }
    dotsHtml(n, filled, color, size) {
      const s = size || 11;
      return Array.from({ length: n }, (_, i) => `<span style="width:${s}px;height:${s}px;border-radius:50%;background:${i < filled ? color : this.C.chip};border:1px solid ${i < filled ? color : this.C.bd2};"></span>`).join("");
    }
    bsoHtml(g, size) {
      const cnt = (g.count || "0-0").split("-").map(Number);
      const lab = `font-size:${size > 9 ? 10.5 : 9.5}px;font-weight:700;color:${this.C.faint};width:9px;`;
      const rowGap = size > 9 ? 7 : 5;
      const line = (l, dots) => `<div style="display:flex;align-items:center;gap:${rowGap}px;"><span style="${lab}">${l}</span>${dots}</div>`;
      return `<div style="display:flex;flex-direction:column;gap:${size > 9 ? 5 : 3}px;flex:none;">
        ${line("B", this.dotsHtml(3, cnt[0] || 0, this.C.grn, size))}
        ${line("S", this.dotsHtml(2, cnt[1] || 0, this.C.amb, size))}
        ${line("O", this.dotsHtml(2, g.outs || 0, this.C.red, size))}
      </div>`;
    }
    diamondHtml(g, box, sq) {
      const on = (v) => (v ? this.C.grn : this.C.chip);
      const ob = (v) => (v ? this.C.grn : this.C.bd2);
      const b = (v, pos) => `<div style="position:absolute;${pos}width:${sq}px;height:${sq}px;border-radius:3px;background:${on(v)};border:${box > 40 ? 2 : 1.5}px solid ${ob(v)};"></div>`;
      const home = box > 40 ? `<div style="position:absolute;bottom:1px;left:50%;transform:translateX(-50%) rotate(45deg);width:11px;height:11px;border-radius:2px;background:${this.C.vs};"></div>` : "";
      return `<div style="position:relative;width:${box}px;height:${box}px;flex:none;">
        ${b(g.runners.second, "left:50%;top:" + (box > 40 ? "2px" : "0") + ";transform:translateX(-50%) rotate(45deg);")}
        ${b(g.runners.third, "left:" + (box > 40 ? "2px" : "0") + ";top:48%;transform:translateY(-50%) rotate(45deg);")}
        ${b(g.runners.first, "right:" + (box > 40 ? "2px" : "0") + ";top:48%;transform:translateY(-50%) rotate(45deg);")}
        ${home}
      </div>`;
    }
    // The model's read on the upcoming pitch, flattened for rails and chips.
    nextCall(g) {
      const pres = (g.m && g.m.pitch_result) || {}, spd = (g.m && g.m.pitch_speed_ou) || {};
      const rec = pres.recommendation;
      const p = pres.probs && rec && pres.probs[rec] != null ? Math.round(pres.probs[rec] * 100) : null;
      return {
        label: rec ? (PH.OUTCOME_LABEL[rec] || rec) : "—",
        pct: p == null ? "" : `${p}%`,
        velo: spd.predictedValue != null ? `${Number(spd.predictedValue).toFixed(1)}` : "—",
        rows: ["strike_foul", "ball", "in_play"]
          .filter((n) => pres.probs && pres.probs[n] != null)
          .map((n) => ({ name: n, label: PH.OUTCOME_LABEL[n] || n, pct: Math.round(pres.probs[n] * 100), rec: n === rec }))
          .sort((a, b) => b.pct - a.pct),
      };
    }
    OUT_COLOR = { out: "#6aa2ff", hit: "#e0a83a", strikeout: "#a37bff", walk: "#4fb877", in_play: "#6aa2ff", ball: "#8493aa", strike_foul: "#4ade80" };
    abRows(g) {
      const abr = (g.m && g.m.ab_result) || {};
      return ["out", "hit", "strikeout", "walk"].map((n) => {
        const oc = (abr.outcomes || []).find((x) => x.name === n) || { modelProb: 0 };
        return { name: n, label: PH.OUTCOME_LABEL[n] || n, pct: Math.round((oc.modelProb || 0) * 100), rec: n === abr.recommendation, c: this.OUT_COLOR[n] };
      }).sort((a, b) => b.pct - a.pct);
    }
    // Every game on today's slate, live first, then finished, then still to
    // come — the selectable set for the rail and the Data Feed panels.
    //
    // Selection must not be gated on `phase === "live"`, for two reasons. It
    // put every finished game out of reach the moment it ended, taking its
    // whole graded record with it; and `phase` is not even reliable for that,
    // because /live derives it from the presence of a live_state row rather
    // than from status — on 2026-08-16 two of fifteen games read "Final" while
    // still arriving as phase "live". The rail lists the slate; `phase` decides
    // only how a panel is drawn.
    slateGames() {
      const rank = (g) => (g.phase === "live" ? 0 : g.phase === "final" ? 1 : 2);
      return (PH.games || []).slice().sort((a, b) => rank(a) - rank(b));
    }
    focused() {
      const list = this.slateGames();
      if (!list.length) return null;
      return list.find((g) => g.gamePk === this.state.focusGame) || list[0];
    }

    // ── Live Board · game rail (1c) / focus strip (1b) ────────────────────
    gameRailHtml(focusPk, mobile) {
      const C = this.C;
      const rail = this.slateGames();
      const items = rail.map((g) => {
        const on = g.gamePk === focusPk;
        const live = g.phase === "live";
        const nc = this.nextCall(g);
        // A finished game has no half-inning left to report and an upcoming one
        // has no score, so neither gets the live line. Showing "0–0 ▲" against a
        // game that has not started reads as a scoreless first inning.
        const mini = live
          ? `${g.score.away}–${g.score.home} ${g.half}${g.inning}`
          : g.phase === "final"
            ? `${g.score.away}–${g.score.home} F`
            : (this.firstPitch(g.startTs) || "TBD");
        if (mobile) {
          return `<button data-act="focusGame" data-arg="${g.gamePk}" style="flex:none;display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:82px;border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.chip};color:${C.txt};font-family:inherit;padding:6px 9px;border-radius:10px;text-align:left;cursor:pointer;opacity:${g.stale ? 0.7 : 1};">
            <span style="font-size:11px;font-weight:800;letter-spacing:.02em;color:${on ? C.grn : C.txt};">${esc(g.label)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${on ? C.gsub : C.mut};">${esc(mini)}</span>
          </button>`;
        }
        return `<button data-act="focusGame" data-arg="${g.gamePk}" style="display:flex;flex-direction:column;gap:6px;text-align:left;border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.panel};border-radius:11px;padding:10px 11px;font-family:inherit;color:${C.txt};cursor:pointer;opacity:${g.stale ? 0.7 : 1};">
          <div style="display:flex;align-items:center;gap:7px;">
            <span style="font-size:13px;font-weight:800;">${esc(g.label)}</span>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;font-weight:600;color:${C.dim};">${esc(mini)}</span>
          </div>
          ${live ? `<div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:${C.mut};min-width:0;">
            <span style="font-family:'IBM Plex Mono',monospace;">${esc(g.count)}</span>
            <span style="width:1px;height:10px;background:${C.bd2};"></span>
            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(this.shortName(g.batter.name))}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:10px;font-weight:800;letter-spacing:.04em;color:${on ? C.grn : C.dim};background:${on ? "rgba(74,222,128,.16)" : C.chip};padding:2px 6px;border-radius:5px;white-space:nowrap;">${esc(nc.label)} ${esc(nc.pct)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${C.faint};">${esc(nc.velo)}</span>
          </div>` : `<div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${C.faint};">${g.phase === "final" ? "Final · full record" : "Scheduled"}</div>`}
        </button>`;
      }).join("");
      if (mobile) {
        return `<div class="phv-sc" style="flex:none;display:flex;gap:6px;overflow-x:auto;padding:10px 14px;border-bottom:1px solid ${C.bd};background:${C.rail};">${items}</div>`;
      }
      return `<div class="phv-sc" style="border-right:1px solid ${C.bd};background:${C.rail};overflow-y:auto;padding:14px 12px;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;padding:0 2px;">
          <span style="font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">Today's games</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">${rail.length}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">${items}</div>
      </div>`;
    }

    // ── Live Board · broadcast situation strip ────────────────────────────
    situationHtml(g, mobile) {
      const C = this.C;
      // The count, bases and half-inning only mean something while a game is in
      // progress. Rendering them on a finished game showed a live-looking 0-0
      // with nobody on; on a scheduled one it showed a scoreless first inning
      // for a game that had not been played.
      const live = g.phase === "live";
      const chip = (t) => `<span style="font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.dim};background:${C.chip};border:1px solid ${C.bd2};padding:4px 9px;border-radius:7px;white-space:nowrap;">${esc(t)}</span>`;
      // firstPitch() is empty when the schedule carries no start time, and
      // "First pitch " with nothing after it reads as a missing value rather
      // than as an unknown one.
      const fp = this.firstPitch(g.startTs);
      const stateChip = g.phase === "final"
        ? chip("Final")
        : chip(fp ? `First pitch ${fp}` : "Scheduled");
      if (mobile) {
        return `<div style="flex:none;background:${C.rail};border-bottom:1px solid ${C.bd};padding:11px 14px 12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="display:flex;align-items:baseline;gap:5px;font-family:'IBM Plex Mono',monospace;">
              <span style="font-size:11px;font-weight:600;color:${C.blue};">${esc(g.away)}</span>
              <span style="font-size:28px;font-weight:700;line-height:1;">${esc(g.score.away)}</span>
              <span style="font-size:15px;color:${C.vs};">–</span>
              <span style="font-size:28px;font-weight:700;line-height:1;">${esc(g.score.home)}</span>
              <span style="font-size:11px;font-weight:600;color:${C.blue};">${esc(g.home)}</span>
            </div>
            ${live
              ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;color:${C.grn};">${esc(g.half)} ${esc(g.inning)}</span>
                 <div style="margin-left:auto;">${this.diamondHtml(g, 36, 12)}</div>
                 ${this.bsoHtml(g, 8)}`
              : `<span style="margin-left:auto;">${stateChip}</span>`}
          </div>
          ${live ? `<div style="display:flex;gap:14px;margin-top:9px;font-size:12.5px;">
            <div><span style="color:${C.blue};font-size:10.5px;font-weight:700;">PITCHING</span> <b style="font-weight:700;">${esc(this.player(g.pitcher))}</b></div>
            <div><span style="color:${C.blue};font-size:10.5px;font-weight:700;">AT BAT</span> <b style="font-weight:700;">${esc(this.player(g.batter))}</b></div>
          </div>` : ""}
        </div>`;
      }
      return `<div style="display:flex;align-items:center;gap:26px;flex-wrap:wrap;background:${C.rail};border:1px solid ${C.bd};border-radius:14px;padding:14px 18px;margin-bottom:16px;">
        <div style="display:flex;align-items:baseline;gap:8px;font-family:'IBM Plex Mono',monospace;">
          <span style="font-size:12px;font-weight:600;color:${C.blue};">${esc(g.away)}</span>
          <span style="font-size:34px;font-weight:700;line-height:1;">${esc(g.score.away)}</span>
          <span style="font-size:18px;color:${C.vs};">–</span>
          <span style="font-size:34px;font-weight:700;line-height:1;">${esc(g.score.home)}</span>
          <span style="font-size:12px;font-weight:600;color:${C.blue};">${esc(g.home)}</span>
        </div>
        ${live ? `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
          <span style="font-size:16px;line-height:1;color:${C.grn};">${esc(g.half)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;color:${C.dim};">Inn ${esc(g.inning)}</span>
        </div>
        ${this.diamondHtml(g, 52, 16)}
        ${this.bsoHtml(g, 11)}` : stateChip}
        ${live ? `<div style="display:flex;flex-direction:column;gap:6px;margin-left:auto;font-size:13.5px;">
          <div style="display:flex;gap:10px;"><span style="color:${C.blue};width:60px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">Pitching</span><b style="font-weight:700;">${esc(this.player(g.pitcher))}</b></div>
          <div style="display:flex;gap:10px;"><span style="color:${C.blue};width:60px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">At bat</span><b style="font-weight:700;">${esc(this.player(g.batter))}</b><span style="color:${C.faint};font-family:'IBM Plex Mono',monospace;font-size:12px;">on deck ${esc(this.shortName(g.onDeckBatter && g.onDeckBatter.name))}</span></div>
        </div>` : ""}
      </div>`;
    }

    // ── Live Board · the green prediction panel ───────────────────────────
    predPanelHtml(g, mobile) {
      const C = this.C;
      const nc = this.nextCall(g);
      const abr = (g.m && g.m.ab_result) || {};
      const abp = (g.m && g.m.ab_pitches_ou) || {};
      const abOver = this.abLikelyOver(g.pitches);
      const tag = abOver ? "for pitch #1 · next batter" : `for pitch #${g.pitches.length + 1} of this at-bat`;
      const pending = abOver && !g.nextPred;
      const rows = this.abRows(g);
      const abCall = PH.OUTCOME_LABEL[abr.recommendation] || abr.recommendation || "—";
      const abProj = abp.predictedValue != null ? Number(abp.predictedValue).toFixed(1) : "—";
      const head = `<div style="display:flex;align-items:center;gap:7px;margin-bottom:${mobile ? 8 : 10}px;">
        <span style="width:7px;height:7px;border-radius:50%;background:${C.grn};animation:ph-pulse 1.8s ease-in-out infinite;"></span>
        <span style="font-size:${mobile ? 10 : 10.5}px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.grn};">Next pitch · ${esc(tag)}</span>
      </div>`;
      // The predicted values carry the panel, so they are set at the headline
      // weight and colour: call · probability · projected velocity on one line.
      const bigVal = `font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 24 : 23}px;font-weight:700;color:${C.txt};line-height:1;letter-spacing:-.01em;`;
      const bigCall = `<div style="display:flex;align-items:baseline;gap:${mobile ? 8 : 10}px;flex-wrap:wrap;${mobile ? "" : "margin-bottom:12px;"}">
        <span style="font-size:${mobile ? 26 : 28}px;font-weight:800;letter-spacing:-.03em;line-height:1;">${esc(nc.label)}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 21 : 22}px;font-weight:600;color:${C.grn};line-height:1;">${esc(nc.pct)}</span>
        <span style="font-size:${mobile ? 18 : 19}px;line-height:1;color:${C.gsub};">·</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 21 : 22}px;font-weight:700;color:${C.txt};line-height:1;">${esc(nc.velo)} <span style="font-size:13px;font-weight:600;color:${C.gsub};">mph</span></span>
      </div>`;
      const dist = mobile
        ? `<div style="display:flex;gap:6px;margin-top:11px;">${nc.rows.map((r) => `
            <div style="flex:1;background:rgba(0,0,0,.28);border-radius:9px;padding:7px 8px;">
              <div style="font-size:10.5px;font-weight:700;color:${r.rec ? C.grn : C.gsub};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.label)}</div>
              <div style="font-family:'IBM Plex Mono',monospace;font-size:15px;font-weight:600;margin-top:2px;">${r.pct}%</div>
            </div>`).join("")}</div>`
        : nc.rows.map((r) => `
            <div style="display:grid;grid-template-columns:84px 1fr 52px;gap:10px;align-items:center;padding:4px 0;">
              <span style="font-size:12.5px;font-weight:${r.rec ? 700 : 500};color:${r.rec ? C.grn : C.gsub};">${esc(r.label)}</span>
              <span style="height:7px;background:#0b1c14;border-radius:999px;overflow:hidden;display:block;"><span style="display:block;height:100%;border-radius:999px;width:${r.pct}%;background:${r.rec ? C.grn : "#2f7a52"};"></span></span>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;text-align:right;">${r.pct}%</span>
            </div>`).join("");
      const veloLine = mobile
        ? `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:11px;padding-top:10px;border-top:1px solid ${C.gbd};font-size:12.5px;">
            <span style="color:${C.gsub};">Pitch #</span><b style="${bigVal}">${abOver ? 1 : g.pitches.length + 1}</b>
          </div>`
        : "";
      const abBlock = `<div style="margin-top:${mobile ? 13 : 14}px;padding-top:${mobile ? 12 : 13}px;border-top:1px solid ${C.gbd};">
        <div style="font-size:${mobile ? 10 : 10.5}px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.gsub};margin-bottom:${mobile ? 7 : 8}px;">At-bat outcome</div>
        <div style="display:flex;align-items:baseline;gap:${mobile ? 8 : 10}px;margin-bottom:${mobile ? 10 : 12}px;">
          <span style="font-size:${mobile ? 26 : 28}px;font-weight:800;letter-spacing:-.03em;line-height:1;color:${C.txt};">${esc(abCall)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 21 : 22}px;font-weight:600;color:${C.grn};line-height:1;">${esc(this.pct(abr.modelProb))}</span>
        </div>
        ${mobile
          ? `<div style="display:flex;height:9px;border-radius:999px;overflow:hidden;background:rgba(0,0,0,.35);">${rows.map((r) => `<span style="display:block;height:100%;width:${r.pct}%;background:${r.c};"></span>`).join("")}</div>
             <div style="display:flex;flex-wrap:wrap;gap:7px 13px;margin-top:9px;">${rows.map((r) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#a6c5b3;"><span style="width:8px;height:8px;border-radius:2px;background:${r.c};"></span>${esc(r.label)} <b style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:${C.txt};">${r.pct}%</b></span>`).join("")}</div>`
          : rows.map((r) => `
            <div style="display:grid;grid-template-columns:84px 1fr 52px;gap:10px;align-items:center;padding:4px 0;">
              <span style="font-size:12.5px;font-weight:${r.rec ? 700 : 500};color:${r.rec ? C.grn : C.gsub};">${esc(r.label)}</span>
              <span style="height:7px;background:#0b1c14;border-radius:999px;overflow:hidden;display:block;"><span style="display:block;height:100%;border-radius:999px;width:${r.pct}%;background:${r.rec ? C.grn : "#2f7a52"};"></span></span>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;text-align:right;">${r.pct}%</span>
            </div>`).join("")}
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:${mobile ? 11 : 12}px;font-size:12.5px;">
          <span style="color:${C.gsub};">Total pitches</span><b style="${bigVal}">${esc(abProj)}</b>
          <span style="color:${C.gsub};">Thrown</span><b style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:${C.dim};">${esc(g.pitchCountPa)}</b>
        </div>
      </div>`;
      return `<div style="border:1px solid ${C.acc};border-radius:14px;background:${C.gbg};padding:${mobile ? "13px 14px" : "15px 16px"};${mobile ? "margin-bottom:12px;" : ""}">
        ${head}
        ${pending
          ? `<div style="font-size:13px;color:${C.gsub};font-style:italic;">At-bat over — the read on the next batter's first pitch arrives when they step in.</div>`
          : bigCall + dist + veloLine}
        ${abBlock}
      </div>`;
    }

    // ── Live Board · dense pitch log ─────────────────────────────────────
    pitchLogHtml(g, mobile) {
      const C = this.C;
      const cols = mobile ? "30px 30px 1fr 1.3fr" : "46px 54px 1fr 1.5fr";
      const pitches = g.pitches.slice().reverse();
      const rows = pitches.map((p) => {
        const called = p.pred && p.pred.speed != null ? p.pred.speed : null;
        const d = called == null || p.speed == null ? null : called - p.speed;
        const vg = this.grd(this.veloBand(d));
        const rm = this.resultMeta(p.desc);
        const rg = this.grd(p.pred && p.pred.resultOk === true ? "good" : p.pred && p.pred.resultOk === false ? "bad" : null);
        const cat = p.pred && p.pred.resultCat ? p.pred.resultCat : null;
        const xres = cat ? (PH.OUTCOME_LABEL[cat] || cat) : "—";
        const xpct = p.pred && p.pred.resultProb != null ? `${Math.round(p.pred.resultProb * 100)}%` : "";
        const delta = d == null ? "—" : (d >= 0 ? "+" : "−") + Math.abs(d).toFixed(1);
        if (mobile) {
          return `<div style="display:grid;grid-template-columns:${cols};gap:6px;align-items:stretch;padding:6px 10px;border-bottom:1px solid ${C.row};">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:${C.dim};align-self:center;">${esc(p.balls)}-${esc(p.strikes)}</span>
            <span style="font-size:11px;font-weight:800;color:${this.pitchColor(p.type)};align-self:center;">${esc(p.type)}</span>
            <span style="display:block;border-radius:7px;background:${vg.bg};padding:5px 7px;">
              <span style="display:block;font-family:'IBM Plex Mono',monospace;font-size:13.5px;font-weight:600;line-height:1.1;color:${vg.fg};">${p.speed == null ? "—" : esc(p.speed.toFixed(1))}</span>
              <span style="display:block;font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.mut};">${called == null ? "—" : esc(called.toFixed(1))} · ${esc(delta)}</span>
            </span>
            <span style="display:block;border-radius:7px;background:${rg.bg};padding:5px 7px;min-width:0;">
              <span style="display:block;font-size:12px;font-weight:700;line-height:1.15;color:${rg.fg === C.dim ? rm[1] : rg.fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(rm[0])}</span>
              <span style="display:block;font-size:10px;color:${C.mut};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(xres)} ${esc(xpct)}</span>
            </span>
          </div>`;
        }
        return `<div style="display:grid;grid-template-columns:${cols};gap:10px;align-items:stretch;padding:8px 14px;border-bottom:1px solid ${C.row};">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:${C.dim};align-self:center;">${esc(p.balls)}-${esc(p.strikes)}</span>
          <span style="font-size:12px;font-weight:800;color:${this.pitchColor(p.type)};align-self:center;">${esc(p.type)}</span>
          <span style="display:flex;align-items:baseline;gap:9px;border-radius:8px;background:${vg.bg};padding:6px 10px;">
            <b style="font-family:'IBM Plex Mono',monospace;font-size:15px;font-weight:600;color:${vg.fg};">${p.speed == null ? "—" : esc(p.speed.toFixed(1))}</b>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:${C.mut};white-space:nowrap;">called ${called == null ? "—" : esc(called.toFixed(1))}</span>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${vg.fg};">${esc(delta)}</span>
          </span>
          <span style="display:flex;align-items:baseline;gap:9px;border-radius:8px;background:${rg.bg};padding:6px 10px;min-width:0;">
            <b style="font-size:13.5px;font-weight:700;color:${rg.fg === C.dim ? rm[1] : rg.fg};white-space:nowrap;">${esc(rm[0])}</b>
            <span style="font-size:12.5px;color:${C.mut};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">called ${esc(xres)} <span style="font-family:'IBM Plex Mono',monospace;">${esc(xpct)}</span></span>
          </span>
        </div>`;
      }).join("");
      const head = `<div style="display:grid;grid-template-columns:${cols};gap:${mobile ? 6 : 10}px;padding:${mobile ? "7px 10px" : "9px 14px"};border-bottom:1px solid ${C.bd};background:${C.panel2};font-size:${mobile ? 9.5 : 10.5}px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:${C.faint};">
        <span>Cnt</span><span>Type</span><span>${mobile ? "Velo" : "Velo · called"}</span><span>${mobile ? "Result" : "Result · called"}</span>
      </div>`;
      const empty = `<div style="padding:${mobile ? "14px 10px" : "16px 14px"};font-size:13px;color:${C.faint};font-style:italic;">Fresh at-bat — no pitches thrown yet.</div>`;
      return head + (rows || empty);
    }

    // ── Live Board · earlier at-bats (server-backed) ──────────────────────
    earlierRows(g, mobile) {
      const C = this.C;
      const all = this.paHist[g.gamePk] || [];
      // Revealed in pages rather than truncated: the strip holds every plate
      // appearance of the game now, and a 55-row wall would bury the live panel
      // under it on first paint.
      const shown = Math.max(Number(this.state.paShow) || 12, 12);
      const hist = all.slice(0, shown);
      const more = all.length > shown
        ? `<div style="padding:10px 14px;text-align:center;"><button data-act="paMore" style="border:1px solid ${C.bd};background:${C.chip};color:${C.dim};font-family:inherit;font-weight:600;font-size:11.5px;padding:6px 14px;border-radius:999px;cursor:pointer;">Show 24 more · ${all.length - shown} earlier at-bats</button></div>`
        : "";
      return hist.map((h) => {
        const rg = this.grd(h.callOk === true ? "good" : h.callOk === false ? "bad" : null);
        const pg = this.grd(h.pitchBand), vg = this.grd(h.veloBand), kg = this.grd(h.pickBand);
        const pc = `${h.projPitches != null ? h.projPitches.toFixed(1) : "—"}/${h.pitches}`;
        const ve = h.avgErr == null ? "—" : (h.avgErr >= 0 ? "+" : "−") + Math.abs(h.avgErr).toFixed(1);
        const rec = h.gradedN ? `${h.right}/${h.gradedN}` : "—";
        const callTxt = h.call ? `${PH.OUTCOME_LABEL[h.call] || h.call}` : "—";
        const callPct = h.callProb != null ? `${Math.round(h.callProb * 100)}%` : "";
        if (mobile) {
          return `<div style="display:grid;grid-template-columns:1fr 50px 42px 34px;gap:6px;align-items:center;padding:7px 10px;border-bottom:1px solid ${C.row};background:#0f1a2c;">
            <span style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><b style="font-size:11.5px;font-weight:700;">${esc(this.shortName(h.batter))}</b> <span style="font-size:11px;font-weight:700;padding:2px 5px;border-radius:5px;background:${rg.bg};color:${rg.fg};">${esc(h.outcomeLabel)}</span></span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:600;text-align:center;padding:3px 0;border-radius:6px;background:${pg.bg};color:${pg.fg};">${esc(pc)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:600;text-align:center;padding:3px 0;border-radius:6px;background:${vg.bg};color:${vg.fg};">${esc(ve)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:600;text-align:center;padding:3px 0;border-radius:6px;background:${kg.bg};color:${kg.fg};">${esc(rec)}</span>
          </div>`;
        }
        return `<div style="display:grid;grid-template-columns:92px 2fr 74px 62px 50px;gap:12px;align-items:center;padding:9px 14px;border-bottom:1px solid ${C.row};font-size:13px;">
          <span style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(this.shortName(h.batter))}</span>
          <span style="display:flex;align-items:baseline;gap:9px;border-radius:8px;background:${rg.bg};padding:5px 10px;min-width:0;">
            <b style="font-weight:700;color:${rg.fg};white-space:nowrap;">${esc(h.outcomeLabel)}</b>
            <span style="font-size:12.5px;color:${C.mut};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">called ${esc(callTxt)} <span style="font-family:'IBM Plex Mono',monospace;">${esc(callPct)}</span></span>
          </span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;text-align:center;padding:5px 0;border-radius:7px;background:${pg.bg};color:${pg.fg};">${esc(pc)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;text-align:center;padding:5px 0;border-radius:7px;background:${vg.bg};color:${vg.fg};">${esc(ve)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;text-align:center;padding:5px 0;border-radius:7px;background:${kg.bg};color:${kg.fg};">${esc(rec)}</span>
        </div>`;
      }).join("") + more;
    }
    // "12 of 55 plate appearances" — the strip is a window onto the server's
    // complete record now, so it says how much of it is on screen.
    // Three genuinely different empty states. Saying "starts empty on reload"
    // stopped being true when this moved server-side on 2026-08-15 — the record
    // is complete from first paint, so an empty strip now means the game has
    // not produced one yet, or the fetch has not landed.
    paEmptyNote(g) {
      if (g.phase === "pregame") return COPY.paEmptyPregame;
      if (!(g.gamePk in this._paSig)) return COPY.paLoading;
      return COPY.paEmptyLive;
    }
    paCountLabel(g) {
      const all = this.paHist[g.gamePk] || [];
      if (!all.length) return "";
      const shown = Math.min(all.length, Math.max(Number(this.state.paShow) || 12, 12));
      return shown < all.length
        ? `${shown} of ${all.length} plate appearances`
        : `${all.length} plate appearance${all.length === 1 ? "" : "s"}`;
    }

    // ── Live Board · locations (1c right column) ──────────────────────────
    zonePanelHtml(g) {
      const C = this.C;
      const seen = [];
      const dots = g.pitches.map((p) => {
        const pos = this.zonePos(p.zone);
        if (!seen.includes(p.type)) seen.push(p.type);
        return `<span style="position:absolute;left:${pos[0]}%;top:${pos[1]}%;transform:translate(-50%,-50%);width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:${C.bg};background:${this.pitchColor(p.type)};">${esc(p.n)}</span>`;
      }).join("");
      const legend = seen.map((t) => `<span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:${C.dim};"><span style="width:9px;height:9px;border-radius:50%;background:${this.pitchColor(t)};"></span>${esc(t)}</span>`).join("");
      return `<div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel};padding:15px 16px;">
        <div style="font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};margin-bottom:11px;">Locations · this at-bat</div>
        <div style="display:flex;gap:16px;align-items:flex-start;">
          <div style="position:relative;width:150px;height:158px;flex:none;">
            <div style="position:absolute;left:25%;top:23%;width:50%;height:54%;border:1.5px solid ${C.bd2};border-radius:3px;background:${C.panel2};"></div>
            <div style="position:absolute;left:41.67%;top:23%;width:1px;height:54%;background:${C.bd};"></div>
            <div style="position:absolute;left:58.33%;top:23%;width:1px;height:54%;background:${C.bd};"></div>
            <div style="position:absolute;left:25%;top:41%;width:50%;height:1px;background:${C.bd};"></div>
            <div style="position:absolute;left:25%;top:59%;width:50%;height:1px;background:${C.bd};"></div>
            ${dots || `<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:12px;color:${C.faint};font-style:italic;">no pitches yet</div>`}
          </div>
          <div style="flex:1;display:flex;flex-direction:column;gap:7px;">${legend}</div>
        </div>
      </div>`;
    }

    // ── Live Board · section header ───────────────────────────────────────
    sectionHead(title, note) {
      const C = this.C;
      return `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:22px 0 10px;">
        <span style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">${esc(title)}</span>
        ${note ? `<span style="font-size:11.5px;color:${C.faint};">${esc(note)}</span>` : ""}
      </div>`;
    }

    // Coverage pill: how many of the six markets this game actually carries.
    // Renders the shortfall explicitly rather than letting missing markets
    // disappear into blank cells.
    covPill(g) {
      const C = this.C;
      const c = g.coverage;
      if (!c) return "";
      const full = c.markets_covered >= c.markets_total;
      return `<span title="${esc((c.missing || []).join(", ") || "all markets scored")}" style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px;white-space:nowrap;background:${full ? "rgba(74,222,128,.14)" : C.chip};color:${full ? C.grn : C.dim};">${c.markets_covered}/${c.markets_total}</span>`;
    }

    firstPitch(ts) {
      if (!ts) return "";
      const t = Date.parse(ts);
      if (!isFinite(t)) return "";
      const mins = Math.round((t - Date.now()) / 60000);
      const clock = new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      if (mins <= 0) return `${clock} · starting`;
      if (mins < 60) return `${clock} · in ${mins}m`;
      return `${clock} · in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    }

    // ── Live Board · yesterday's graded totals ────────────────────────────
    // The section that fills the screen when nothing has started. Built from
    // graded game_predictions, so it is real history, not a placeholder.
    recapHtml() {
      const C = this.C;
      if (RECAP_ERR && !RECAP) {
        return this.sectionHead("Last completed slate") +
          `<div style="padding:14px;border:1px solid ${C.bd};border-radius:12px;background:${C.panel};font-size:12.5px;color:${C.mut};">
            Couldn't reach the results feed just now — this is a connection problem, not an empty schedule. Retrying automatically.
          </div>`;
      }
      if (!RECAP || !RECAP.games || !RECAP.games.length) return "";
      const t = RECAP.totals || {};
      const kpi = (label, value, tone) => `<div style="flex:1;min-width:96px;padding:10px 12px;border:1px solid ${C.bd};border-radius:11px;background:${C.panel};">
        <div style="font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};margin-bottom:3px;">${esc(label)}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:17px;font-weight:700;color:${tone || C.txt};">${esc(value)}</div>
      </div>`;
      const units = Number(t.profit_units || 0);
      const tiles = [
        kpi("Games", String(t.games != null ? t.games : RECAP.games.length)),
        kpi("Calls graded", String(t.n_graded != null ? t.n_graded : 0)),
        kpi("Hit rate", t.win_rate != null ? `${Math.round(t.win_rate * 100)}%` : "—"),
        kpi("Net units", (units >= 0 ? "+" : "−") + Math.abs(units).toFixed(2), units >= 0 ? C.grn : "#ff7b6b"),
      ].join("");

      const rows = RECAP.games.map((gm) => {
        const graded = (gm.markets || []).filter((m) => m.result === "win" || m.result === "loss");
        const wins = graded.filter((m) => m.result === "win").length;
        const score = `${gm.away_abbr || "AWY"} ${gm.away_score != null ? gm.away_score : "—"} · ${gm.home_abbr || "HOM"} ${gm.home_score != null ? gm.home_score : "—"}`;
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid ${C.bd};font-size:12.5px;">
          <span style="font-weight:700;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(score)}</span>
          <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.faint};">${graded.length ? `${wins}/${graded.length} calls` : "ungraded"}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px;background:${C.chip};color:${C.dim};">${gm.coverage ? `${gm.coverage.markets_covered}/${gm.coverage.markets_total}` : "—"}</span>
        </div>`;
      }).join("");

      return this.sectionHead("Last completed slate", RECAP.date || "") +
        `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">${tiles}</div>
         <div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel2};overflow:hidden;">${rows}</div>`;
    }

    // ── Live Board · today's upcoming games ───────────────────────────────
    upcomingHtml() {
      const C = this.C;
      const list = this.upcomingGames();
      if (!list.length) return "";
      const cards = list.map((g) => {
        const ml = g.m.game_moneyline, tot = g.m.game_total;
        const mlTxt = ml && ml.covered && ml.recommendation
          ? `${esc(ml.recommendation === "home" ? g.home : g.away)} ${this.pct(ml.modelProb)}`
          : "—";
        const totTxt = tot && tot.covered && tot.predictedValue != null
          ? `${Number(tot.predictedValue).toFixed(1)} runs${tot.line != null ? ` · ${esc(PH.OUTCOME_LABEL[tot.recommendation] || tot.recommendation || "")} ${tot.line}` : ""}`
          : "—";
        const probables = [g.probables && g.probables.away, g.probables && g.probables.home]
          .filter(Boolean).map((n) => this.shortName(n)).join(" vs ");
        return `<div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};padding:11px 13px;display:flex;flex-direction:column;gap:7px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:13.5px;font-weight:800;">${esc(g.label)}</span>
            <span style="margin-left:auto;">${this.covPill(g)}</span>
          </div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.faint};">${esc(this.firstPitch(g.startTs))}</div>
          ${probables ? `<div style="font-size:11.5px;color:${C.mut};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(probables)}</div>` : ""}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:1px;">
            <span style="font-size:11px;color:${C.dim};background:${C.chip};padding:3px 7px;border-radius:6px;">ML ${mlTxt}</span>
            <span style="font-size:11px;color:${C.dim};background:${C.chip};padding:3px 7px;border-radius:6px;">Total ${totTxt}</span>
          </div>
        </div>`;
      }).join("");
      return this.sectionHead("Today · upcoming", `${list.length} game${list.length === 1 ? "" : "s"} · predictions ready before first pitch`) +
        `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:9px;">${cards}</div>`;
    }

    // ── Live Board · today's finished games ───────────────────────────────
    finalsHtml() {
      const C = this.C;
      const list = this.finalGames();
      if (!list.length) return "";
      const rows = list.map((g) => `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid ${C.bd};font-size:12.5px;">
        <span style="font-weight:700;">${esc(g.label)}</span>
        <span style="font-family:'IBM Plex Mono',monospace;color:${C.mut};">${esc(g.score.away)}–${esc(g.score.home)}</span>
        <span style="margin-left:auto;">${this.covPill(g)}</span>
      </div>`).join("");
      return this.sectionHead("Today · final", `${list.length}`) +
        `<div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel2};overflow:hidden;">${rows}</div>`;
    }

    // ══ LIVE BOARD (1b mobile · 1c desktop) ══════════════════════════════
    liveHtml() {
      const C = this.C;
      const g = this.focused();
      const mobile = this.mob();
      // Recap + upcoming + finals always render. They are what makes the board
      // non-empty before first pitch, and they stay below the live panel once
      // games start.
      const dayBlocks = this.recapHtml() + this.upcomingHtml() + this.finalsHtml();

      if (!g) {
        return `<div style="padding:0 14px 28px;">
          <div style="margin:18px 0 12px;">
            <h1 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0;">${esc(COPY.liveTitle)}</h1>
            <p style="margin:.3rem 0 0;color:${C.mut};font-size:.95rem;">${esc(COPY.liveSub)}</p>
          </div>
          ${dayBlocks || `<div style="padding:3.5rem 1rem;text-align:center;background:${C.panel};border:1px solid ${C.bd};border-radius:14px;">
            <div style="font-size:1.05rem;font-weight:700;margin-bottom:.35rem;">No games on the schedule</div>
            <div style="font-size:.9rem;color:${C.mut};">MLB has nothing listed for today. Yesterday's results return here as soon as a slate completes.</div>
          </div>`}
        </div>`;
      }
      const hist = this.paHist[g.gamePk] || [];
      // Everything keyed to "the next pitch" — the green prediction panel, the
      // current-PA pitch log, the zone plot — describes a plate appearance in
      // progress. On a finished or scheduled game there isn't one, and the
      // complete at-bat record below is the whole point of selecting it.
      const live = g.phase === "live";

      if (mobile) {
        return `<div style="display:flex;flex-direction:column;min-height:0;">
          ${this.gameRailHtml(g.gamePk, true)}
          ${this.situationHtml(g, true)}
          <div style="padding:12px 14px 20px;">
            ${live ? this.predPanelHtml(g, true) : ""}
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:7px;">
              <span style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};">${live ? "Pitch log · newest first" : "At-bat record · newest first"}</span>
              <span style="font-size:10.5px;color:${C.faint};">shading = call accuracy</span>
            </div>
            <div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};overflow:hidden;">
              ${live ? this.pitchLogHtml(g, true) : ""}
              ${!hist.length ? `<div style="padding:14px;font-size:12.5px;color:${C.faint};font-style:italic;line-height:1.5;">${esc(this.paEmptyNote(g))}</div>` : ""}
              ${hist.length ? `
              <div style="display:grid;grid-template-columns:1fr 50px 42px 34px;gap:6px;padding:7px 10px;border-top:1px solid ${C.bd};border-bottom:1px solid ${C.bd};background:${C.panel2};font-size:9.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:${C.faint};">
                <span>Earlier at-bats</span><span style="text-align:center;">P·pred</span><span style="text-align:center;">Velo</span><span style="text-align:center;">Picks</span>
              </div>
              ${this.earlierRows(g, true)}` : ""}
            </div>
            <div style="font-size:10.5px;color:${C.faint};padding:8px 2px 0;line-height:1.5;">Velo shading — <span style="color:${this.GRD.good.fg};font-weight:700;">green</span> within 1.5 mph, <span style="color:${this.GRD.amber.fg};font-weight:700;">amber</span> within 3, <span style="color:${this.GRD.bad.fg};font-weight:700;">red</span> beyond. Class calls are green when right, red when wrong.</div>
            ${dayBlocks}
          </div>
        </div>`;
      }

      const nar = this.narrow();
      return `<div style="display:grid;grid-template-columns:${nar ? 216 : 268}px minmax(0,1fr);min-height:calc(100vh - 190px);">
        ${this.gameRailHtml(g.gamePk, false)}
        <div style="padding:18px 24px 28px;min-width:0;">
          <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
            <h1 style="margin:0;font-size:27px;font-weight:800;letter-spacing:-.02em;">${esc(g.label)}</h1>
            <span style="font-size:13px;color:${C.mut};">${esc(g.venue)} · ${esc(g.weather)}</span>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:12px;color:${C.faint};">model ${esc(g.modelVersion || "—")} · ${live ? (g.stale ? "paused (no pitch 30s+)" : "live") : g.phase === "final" ? "final" : "scheduled"}</span>
          </div>
          ${this.situationHtml(g, false)}
          <div style="display:grid;grid-template-columns:${nar || !live ? "minmax(0,1fr)" : "minmax(0,1fr) 380px"};gap:16px;align-items:start;">
            <div style="display:flex;flex-direction:column;gap:12px;min-width:0;">
              ${live ? `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;">
                <span style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">At-bat feed · newest first</span>
                <span style="font-size:11.5px;color:${C.faint};">shading = call accuracy · green ≤1.5 mph · amber ≤3 · red beyond</span>
              </div>
              <div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel};overflow:hidden;">${this.pitchLogHtml(g, false)}</div>` : ""}
              <div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">${live ? "Earlier at-bats" : "At-bat record"}</span>
                <span style="font-size:11.5px;color:${C.faint};">${esc(this.paCountLabel(g))}</span>
              </div>
              <div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel2};overflow:hidden;">
                <div style="display:grid;grid-template-columns:92px 2fr 74px 62px 50px;gap:12px;padding:9px 14px;border-bottom:1px solid ${C.bd};background:${C.panel3};font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.faint};">
                  <span>Batter</span><span>Result · called</span><span style="text-align:center;">P pred/act</span><span style="text-align:center;">Avg velo err</span><span style="text-align:center;">Picks</span>
                </div>
                ${hist.length ? this.earlierRows(g, false) : `<div style="padding:14px;font-size:12.5px;color:${C.faint};font-style:italic;">${esc(this.paEmptyNote(g))}</div>`}
              </div>
            </div>
            ${live ? `<div style="display:flex;flex-direction:column;gap:14px;">
              ${this.predPanelHtml(g, false)}
              ${this.zonePanelHtml(g)}
            </div>` : ""}
          </div>
          ${dayBlocks}
        </div>
      </div>`;
    }

    // ══ GRADED LOG (server-backed) ════════════════════════════════════════
    // Was session-accumulated until 2026-08-08: the Data Feed graded each
    // pitch as /live delivered it and kept the result in an array capped at
    // 400. That meant two people watching the same slate saw different tables,
    // a refresh wiped it, and arriving at 21:00 showed nothing from the 13:00
    // games — even though the server had made and graded every one of those
    // predictions hours earlier.
    //
    // /api/pitches serves them. Everyone sees the same day.
    // Always refetches. There is no cheap way to ask "did a new pitch land"
    // without asking for the rows, and /api/pitches is CDN-cached for 15s
    // against an ~8s poll, so roughly half of these never reach the origin.
    async loadPitchFeed() {
      // A full slate is several thousand prediction rows and the endpoint
      // pages at MAX_LIMIT=1000, so one request is never the whole day.
      //
      // Paging is demand-driven, not exhaustive. This runs on the 8s poll as
      // well as on every chip, so walking a whole slate to the end each time
      // would put a dozen requests on the wire every 8 seconds. Instead it
      // fetches until it holds more display rows than the table is currently
      // revealing (`dfShow`, which the "show more" control raises), plus one
      // page of headroom so the next reveal is instant. Rows come back newest
      // first, so page one is always the part a live viewer is looking at.
      //
      // PAGE_CAP is a backstop, not an expected limit — it stops a server-side
      // cursor bug from spinning the browser forever.
      const PAGE_LIMIT = 1000;
      const PAGE_CAP = 12;
      const want = Math.max(Number(this.state.dfShow) || 60, 60) + PAGE_LIMIT;
      const date = this.state.dfDate;
      const seq = (this._pitchSeq = (this._pitchSeq || 0) + 1);
      try {
        // Every market, not just the two per-pitch ones. The old whitelist here
        // was the reason at-bat and game-level calls — ab_result,
        // ab_pitches_ou, moneyline, total — could not be seen anywhere in the
        // product: they were never requested, so the mapper never saw them.
        // "all" is dropped by loadPitches, which the server reads as no filter.
        const params = {
          game_pk: this.state.dfGame === "all" ? null : this.state.dfGame,
          market: this.state.mkt,
          limit: PAGE_LIMIT,
        };
        // Ungraded rows are included: the at-bat in progress is exactly the one
        // a live viewer is looking at, and a call the model has already made is
        // not something to hide until settle catches up. They are badged
        // "pending" and excluded from every accuracy statistic — see dfStats.
        //
        // Omitted for today so the server applies its own America/New_York
        // date, which is the authority on which slate "today" is.
        if (date) params.date = date;

        let cursor = 0;
        let rows = [];
        let summary = null;
        for (let page = 0; page < PAGE_CAP; page += 1) {
          const res = await PH.loadPitches(
            API_BASE, Object.assign({}, params, cursor ? { cursor } : {}),
          );
          // A newer request started while this one was in flight (the chips
          // refetch, and the poll runs every 8s). Its pages belong to a
          // different filter set, so drop ours rather than interleaving.
          if (seq !== this._pitchSeq) return false;
          // The endpoint's summary counts the page, not the day, so the
          // tallies accumulate across pages. `games` is a property of the
          // slate and is identical on every page.
          const ps = res.summary || {};
          summary = summary
            ? {
              n: summary.n + (ps.n || 0),
              graded: summary.graded + (ps.graded || 0),
              wins: summary.wins + (ps.wins || 0),
              losses: summary.losses + (ps.losses || 0),
              pushes: summary.pushes + (ps.pushes || 0),
              games: summary.games,
              // False once paging stops early, which it does by design.
              complete: false,
            }
            : {
              n: ps.n || 0, graded: ps.graded || 0, wins: ps.wins || 0,
              losses: ps.losses || 0, pushes: ps.pushes || 0,
              games: ps.games || 0, complete: true,
            };
          rows = rows.concat((res.rows || []).map((r) => this.dfRow(r)).filter(Boolean));
          // Paint the first page immediately; the rest stream in behind it.
          if (page === 0) {
            this.state.pitchFeed = { rows, summary, loaded: true, err: false };
            this.render();
          }
          if (!res.next_cursor) { summary.complete = true; break; }
          if (rows.length >= want) { summary.complete = false; break; }
          cursor = res.next_cursor;
        }
        this.state.pitchFeed = { rows, summary, loaded: true, err: false };
        return true;
      } catch (_e) {
        if (seq !== this._pitchSeq) return false;
        // Keep whatever we had and flag it, so the panel says "couldn't reach"
        // rather than implying the model made no predictions.
        this.state.pitchFeed = Object.assign({}, this.state.pitchFeed, {
          loaded: true, err: true,
        });
        return true;
      }
    }

    // One server row -> one display row. The server sends a market and an
    // actual; VELO and CLASS are presentation categories, so the mapping lives
    // here rather than in the API.
    dfRow(r) {
      const matchup = r.pitcher_name && r.batter_name
        ? `${this.shortName(r.pitcher_name)} → ${this.shortName(r.batter_name)}`
        : "—";
      const base = {
        t: r.graded_at || r.created_at, pk: r.game_pk, game: r.game_label || "—",
        // The raw market key, kept alongside the display tag below so the
        // market chips can filter on what the server actually sent rather than
        // on a presentation category that only ever covered two of six.
        market: r.market,
        inning: r.inning, pitcher: r.pitcher_name, batter: r.batter_name, matchup,
        count: r.count || "—", outs: r.outs == null ? "—" : r.outs,
        type: r.actual_pitch_type, model: r.model_version || "—",
        conf: r.confidence,
        // Reconstructed after the fact by backfill-predictions, with whatever
        // models were current at backfill time — not a call anyone could have
        // acted on. Badged in the log; still counted in the record.
        back: r.backfilled_at != null,
      };
      const label = (c) => (c ? PH.OUTCOME_LABEL[c] || c : "—");
      const conf = r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "";

      if (r.market === "pitch_speed_ou") {
        // `error` is computed server-side so every client renders the same
        // number. A missing actual used to drop the row entirely, which is what
        // made every past slate render as nothing before the actuals backfill
        // (20260816000001) — a call with no result yet is still a call, so it
        // renders as pending instead of vanishing.
        if (r.predicted_value == null) return null;
        const err = r.error;
        const pending = r.actual_value == null;
        return Object.assign(base, {
          id: `${r.id}|v`, mkt: "VELO",
          pred: `${r.predicted_value.toFixed(1)} mph`,
          predRaw: r.predicted_value.toFixed(1),
          actual: pending ? "pending" : r.actual_value.toFixed(1),
          actualRaw: pending ? "—" : r.actual_value.toFixed(1),
          speed: pending ? null : r.actual_value,
          err: err == null ? "pending"
            : (err >= 0 ? "+" : "−") + Math.abs(err).toFixed(1),
          errAbs: err == null ? null : Math.abs(err),
          band: this.veloBand(err), hit: err != null && Math.abs(err) <= 1.5,
          pending,
        });
      }
      if (r.market === "pitch_result") {
        const ok = r.result == null ? null : r.result === "win";
        return Object.assign(base, {
          id: `${r.id}|c`, mkt: "CLASS",
          pred: label(r.recommendation),
          predRaw: `${r.recommendation || "—"} ${conf}`.trim(),
          actual: ok == null ? "pending" : label(r.actual_label),
          actualRaw: r.actual_label || "—",
          err: ok == null ? "pending" : ok ? "correct" : "miss",
          band: ok == null ? null : ok ? "good" : "bad", hit: ok === true,
          pending: ok == null,
        });
      }

      // At-bat and game markets. The server settles all of them through the
      // same `result` column, so they render with the per-pitch grammar —
      // called X, actual Y, correct or miss — rather than needing a surface of
      // their own. Nothing requested them until 2026-08-16, so an at-bat call
      // the model made and graded was not visible anywhere in the product.
      const meta = PH.MARKETS[r.market];
      if (!meta) return null;   // unknown market: absent beats mislabelled
      const ou = meta.kind === "ou";
      const proj = r.predicted_value != null ? Number(r.predicted_value).toFixed(1) : null;
      return Object.assign(base, {
        id: `${r.id}|${r.market}`,
        mkt: this.DF_TAG[r.market] || meta.short,
        pred: ou
          ? `${label(r.recommendation)}${r.line != null ? ` ${r.line}` : ""}${proj ? ` · proj ${proj}` : ""}`
          : `${label(r.recommendation)}${conf ? ` ${conf}` : ""}`,
        predRaw: `${r.recommendation || "—"}${r.line != null ? ` ${r.line}` : ""} ${conf}`.trim(),
        actual: r.result == null ? "pending"
          : r.actual_value != null ? String(r.actual_value) : label(r.actual_label),
        actualRaw: r.actual_value != null ? String(r.actual_value) : (r.actual_label || "—"),
        err: r.result == null ? "pending"
          : r.result === "win" ? "correct" : r.result === "push" ? "push" : "miss",
        band: r.result == null ? null
          : r.result === "win" ? "good" : r.result === "push" ? "amber" : "bad",
        hit: r.result === "win",
        pending: r.result == null,
      });
    }
    // Compact column tags for the markets that are not per-pitch. Short enough
    // to sit inline in the Prediction cell without pushing the call out of view.
    DF_TAG = {
      ab_result: "AB", ab_pitches_ou: "AB P",
      game_moneyline: "ML", game_total: "TOT",
    };

    dfRows() {
      // Already scoped server-side by game_pk; the filter stays as a guard for
      // the tick between changing the chip and the fetch landing.
      const scope = this.state.dfGame;
      const rows = (this.state.pitchFeed && this.state.pitchFeed.rows) || [];
      return scope === "all" ? rows : rows.filter((r) => r.pk === scope);
    }
    dfStats(rows) {
      // Graded only, and now explicitly so: the log carries pending rows since
      // 2026-08-16, and a call with no result has no error to average and no
      // outcome to score. Averaging a null errAbs in would have turned the MAE
      // tile into NaN.
      const velo = rows.filter((r) => r.mkt === "VELO" && r.errAbs != null);
      const cls = rows.filter((r) => r.mkt === "CLASS" && r.band != null);
      const mae = velo.length ? velo.reduce((a, r) => a + r.errAbs, 0) / velo.length : null;
      const within = velo.length ? velo.filter((r) => r.hit).length / velo.length : null;
      const clsHit = cls.length ? cls.filter((r) => r.hit).length / cls.length : null;
      // `n` backs the "Graded" tile, so it counts settled rows across every
      // market — not the row count, which now includes pending ones.
      return {
        velo, cls, mae, within, clsHit,
        n: rows.filter((r) => !r.pending).length,
        pending: rows.filter((r) => r.pending).length,
      };
    }
    fmtTime(t) {
      const d = new Date(t);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    }

    // ══ DATA FEED (1e mobile · 1d desktop) ═══════════════════════════════
    // ══ WAREHOUSE SCOUTING (durable — survives a reload) ══════════════════
    // These panels come from the Phase 4 nightly aggregates in R2 and sit
    // alongside the graded log, which has been server-backed since 2026-08-08
    // (/api/pitches) and is itself durable — the "session-only" caveat that
    // used to live here no longer applies. Everything here degrades to a note:
    // a warehouse outage must never blank the live board.
    scoutSeed() {
      try {
        return JSON.parse(window.localStorage.getItem(SCOUT_KEY) || "null");
      } catch (_e) { return null; }   // private mode / disabled storage
    }
    saveScoutSeed(seed) {
      try { window.localStorage.setItem(SCOUT_KEY, JSON.stringify(seed)); }
      catch (_e) { /* non-fatal: the panels just won't survive this reload */ }
    }

    // Fetch the aggregate panels for one pitcher/batter/game. Only re-fetches
    // when the trio actually changes, so an 8s poll does not become an 8s
    // request storm against five routes.
    async loadScouting(seed) {
      if (!seed || (!seed.pitcherId && !seed.gamePk)) return;
      // Keyed per panel, not per trio. The batter changes every at-bat, so a
      // single combined signature re-fetched the pitcher profile, the fatigue
      // curve and the game context several times an inning for no new data.
      const sigs = {
        ctx: `g:${seed.gamePk}`,
        profile: `p:${seed.pitcherId}`,
        fatigue: `f:${seed.pitcherId}`,
        matchup: `m:${seed.pitcherId}:${seed.batterId}`,
      };
      const prev = this._scoutSigs || (this._scoutSigs = {});
      const stale = Object.keys(sigs).filter((k) => prev[k] !== sigs[k]);
      if (!stale.length && this.state.scout.loaded) return;
      this.saveScoutSeed(seed);

      // fetchJson swallows non-2xx and network errors into null, which is
      // exactly the degradation we want: an unreachable warehouse means an
      // empty panel with a note, never a broken tab.
      const want = (k, path) => {
        if (prev[k] === sigs[k]) return Promise.resolve(this.state.scout[k]);
        return fetchJson(path).then((v) => { prev[k] = sigs[k]; return v; });
      };
      const [ctx, profile, fatigue, matchup] = await Promise.all([
        seed.gamePk ? want("ctx", `/game/${seed.gamePk}/context`) : null,
        seed.pitcherId ? want("profile", `/player/${seed.pitcherId}/profile`) : null,
        seed.pitcherId ? want("fatigue", `/player/${seed.pitcherId}/fatigue`) : null,
        seed.pitcherId && seed.batterId
          ? want("matchup", `/matchup/${seed.pitcherId}/${seed.batterId}`) : null,
      ]);
      this.setState({ scout: { seed, ctx, profile, fatigue, matchup, loaded: true } });
    }

    // Seed from the Data Feed's own game selector when it has one, otherwise
    // from the slate, otherwise from the last session — which is what makes the
    // tab survive a refresh.
    //
    // This followed `state.feedGame` until 2026-08-16: state nothing rendered a
    // control for, which poll() pinned to the first live game. The scouting
    // panels therefore described that game no matter which one the user had
    // actually scoped the tab to.
    syncScouting() {
      const slate = this.slateGames();
      const g = slate.find((x) => x.gamePk === this.state.dfGame) || slate[0];
      if (g && (g.pitcher.id || g.batter.id)) {
        this.loadScouting({
          gamePk: g.gamePk, pitcherId: g.pitcher.id, batterId: g.batter.id,
          pitcherName: g.pitcher.name, batterName: g.batter.name,
          label: g.label || `${g.away} @ ${g.home}`,
        });
      } else if (!this.state.scout.loaded) {
        const seed = this.scoutSeed();
        if (seed) this.loadScouting(seed);
      }
    }

    scoutingHtml() {
      const C = this.C;
      const s = this.state.scout;
      const thinNote = (t) => `<div style="padding:14px;font-size:12.5px;color:${C.faint};font-style:italic;line-height:1.5;">${esc(t)}</div>`;
      const card = (title, body, note) => `<div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel};padding:15px 16px;">
        <div style="font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};margin-bottom:10px;">${esc(title)}</div>
        ${body}
        ${note ? `<div style="margin-top:9px;font-size:11px;color:${C.faint};line-height:1.5;">${esc(note)}</div>` : ""}</div>`;
      const kvRow = (k, v) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12.5px;">
        <span style="color:${C.dim};">${esc(k)}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:${C.txt};">${esc(v)}</span></div>`;
      const pct = (x) => (x == null ? "—" : `${Math.round(Number(x) * 100)}%`);

      if (!s.loaded) return "";
      const seed = s.seed || {};

      // ── pitcher profile: career / season / d30 side by side ──────────
      const prof = s.profile && s.profile.found ? (s.profile.pitcher || []) : [];
      const profBody = prof.length
        ? `<div style="display:grid;grid-template-columns:64px repeat(${prof.length},1fr);gap:6px;font-size:11.5px;align-items:center;">
            <span></span>${prof.map((p) => `<span style="text-align:center;color:${C.faint};font-weight:700;text-transform:uppercase;letter-spacing:.05em;">${esc(p.scope)}</span>`).join("")}
            ${[["K%", "k_rate"], ["BB%", "bb_rate"], ["Whiff", "whiff_rate"], ["Zone", "zone_rate"], ["Chase", "chase_rate"]]
              .map(([label, key]) => `<span style="color:${C.dim};">${label}</span>${prof.map((p) => `<span style="text-align:center;font-family:'IBM Plex Mono',monospace;font-weight:600;">${pct(p[key])}</span>`).join("")}`).join("")}
          </div>`
        : thinNote("No published profile for this pitcher yet. Profiles need 30+ pitches in the window and are rebuilt nightly.");

      // ── fatigue: the TYPICAL curve. The current game's trend stays live,
      //    computed from the hot table — that split is deliberate.
      const buckets = s.fatigue && s.fatigue.found ? (s.fatigue.buckets || []) : [];
      const BUCKET_LABEL = ["0–24", "25–49", "50–74", "75–99", "100+"];
      const fatBody = buckets.length
        ? `<div style="display:flex;flex-direction:column;gap:5px;">
            ${buckets.map((b) => {
              const d = b.velo_delta_vs_bucket0;
              const col = d == null ? C.faint : d <= -0.8 ? this.GRD.bad.fg : d <= -0.3 ? this.GRD.amber.fg : this.GRD.good.fg;
              return `<div style="display:grid;grid-template-columns:54px minmax(0,1fr) 118px;gap:9px;align-items:center;font-size:12px;">
                <span style="font-family:'IBM Plex Mono',monospace;color:${C.dim};">${BUCKET_LABEL[b.pitch_bucket] || b.pitch_bucket}</span>
                <span style="height:7px;background:${C.chip};border-radius:999px;overflow:hidden;display:block;"><span style="display:block;height:100%;border-radius:999px;background:${col};width:${Math.max(4, Math.min(100, Math.round(((b.mean_velo || 0) / 100) * 100)))}%;"></span></span>
                <span style="text-align:right;font-family:'IBM Plex Mono',monospace;"><b style="font-weight:600;">${b.mean_velo == null ? "—" : Number(b.mean_velo).toFixed(1)}</b><span style="color:${col};"> ${d == null ? "" : (d > 0 ? "+" : "") + Number(d).toFixed(2)}</span></span>
              </div>`;
            }).join("")}
          </div>`
        : thinNote("No published fatigue curve for this pitcher yet.");

      // ── head-to-head ─────────────────────────────────────────────────
      const mu = s.matchup;
      const muBody = mu && mu.found
        ? `${kvRow("Plate appearances", mu.pa_count)}${kvRow("Strikeouts", mu.so_count)}${kvRow("Walks", mu.bb_count)}${kvRow("Hits", mu.h_count)}${kvRow("Home runs", mu.hr_count == null ? "—" : mu.hr_count)}${kvRow("Last faced", mu.last_faced || "—")}`
        : thinNote("Fewer than three career meetings — the published table applies a 3-PA floor, so there is no meaningful history here.");

      // ── game context ─────────────────────────────────────────────────
      const c = s.ctx;
      const ctxBody = c && c.found
        ? `${kvRow("Venue", c.venue_name || "—")}${kvRow("Home-plate umpire", c.hp_umpire || "—")}${kvRow("Weather", c.weather_condition || "—")}${kvRow("Temperature", c.temp_f == null ? "—" : `${c.temp_f}°F`)}${kvRow("Wind", c.wind_mph == null ? "—" : `${c.wind_mph} mph ${c.wind_direction || ""}`.trim())}${kvRow("Attendance", c.attendance == null ? "—" : Number(c.attendance).toLocaleString())}`
        : thinNote("No published context for this game yet — game context is written by the nightly warehouse publish, so today's games appear tomorrow.");

      const stale = !s.profile && !s.fatigue && !s.ctx && !s.matchup;
      return `<div style="margin-bottom:18px;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
          <span style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">Scouting context · from the warehouse</span>
          <span style="font-size:11px;color:${C.faint};">${esc(seed.label || "")}${seed.pitcherName ? " · " + esc(seed.pitcherName) : ""}${seed.batterName ? " vs " + esc(seed.batterName) : ""}</span>
        </div>
        ${stale ? thinNote("The warehouse aggregates are unreachable right now. The live board above is unaffected — these panels are display-only and will fill in on the next successful load.") : `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;">
          ${card("Pitcher profile", profBody, "Career here means the published three-season window, not all history.")}
          ${card("Typical fatigue curve", fatBody, "Mean velocity by in-game pitch count, with the change from his first bucket. The current game's trend is computed live above — this is the baseline it moves against.")}
          ${card("Head to head", muBody, null)}
          ${card("Game context", ctxBody, null)}
        </div>`}
      </div>`;
    }

    // ── Data Feed · durable 30-day history ────────────────────────────────
    // Server-backed, so it survives a reload and a fresh browser. The session
    // graded log further down is now an overlay for pitches arriving in this
    // tab, not the only record that exists.
    // `bare` drops the outer padding for when this is embedded inside a tab
    // that already has its own.
    feedHtml(bare) {
      const C = this.C;
      const mobile = this.mob();
      const f = this.state.feedF;
      const fd = this.state.feed;

      const chip = (act, arg, label, on) =>
        `<button data-act="${act}" data-arg="${esc(arg)}" style="border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.chip};color:${on ? C.grn : C.dim};font-family:inherit;font-weight:600;font-size:${mobile ? 11 : 11.5}px;padding:${mobile ? "4px 9px" : "5px 11px"};border-radius:999px;cursor:pointer;">${esc(label)}</button>`;

      const dayChips = [[1, "Today"], [7, "7 days"], [30, "30 days"]]
        .map(([d, l]) => chip("feedDays", d, l, Number(f.days) === d)).join("");
      const phaseChips = [["all", "Both"], ["pregame", "Pregame"], ["live", "Live"]]
        .map(([k, l]) => chip("feedPhase", k, l, (f.phase || "all") === k)).join("");
      const mktChips = [["all", "All markets"], ["game_moneyline", "Moneyline"], ["game_total", "Total"],
        ["pitch_speed_ou", "Pitch velo"], ["pitch_result", "Pitch result"],
        ["ab_result", "AB result"], ["ab_pitches_ou", "AB pitches"]]
        .map(([k, l]) => chip("feedMarket", k, l, f.market === k)).join("");

      const input = (key, ph, val) =>
        `<input data-feedfilter="${key}" value="${esc(val || "")}" placeholder="${esc(ph)}" style="border:1px solid ${C.bd};background:${C.panel};color:${C.txt};font-family:inherit;font-size:11.5px;padding:5px 9px;border-radius:8px;width:${mobile ? 96 : 118}px;" />`;

      const anyFilter = f.market !== "all" || (f.phase || "all") !== "all" || f.team
        || f.pitcher_id || f.batter_id || Number(f.days) !== 30;

      const filters = `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:9px;">
        ${dayChips}
        <span style="width:1px;height:16px;background:${C.bd2};"></span>
        ${input("team", "Team (NYM)", f.team)}
        ${input("pitcher_id", "Pitcher id", f.pitcher_id)}
        ${input("batter_id", "Batter id", f.batter_id)}
        ${anyFilter ? chip("feedClear", "", "Clear", false) : ""}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        ${mktChips}
        <span style="width:1px;height:16px;background:${C.bd2};"></span>
        <span style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};">Phase</span>
        ${phaseChips}
      </div>`;

      let body;
      if (!fd.loaded) {
        body = `<div style="padding:16px 14px;font-size:12.5px;color:${C.faint};font-style:italic;">Loading prediction history…</div>`;
      } else if (fd.err) {
        body = `<div style="padding:16px 14px;font-size:12.5px;color:${C.faint};">Couldn't reach the history feed — a connection problem, not an empty record. Retrying on the next refresh.</div>`;
      } else if (!fd.rows.length && !fd.players.length) {
        body = `<div style="padding:16px 14px;font-size:12.5px;color:${C.faint};">No stored predictions match these filters in the selected window.</div>`;
      } else {
        const head = `<div style="display:grid;grid-template-columns:${mobile ? "1fr 74px 54px" : "88px 1fr 128px 96px 74px 62px"};gap:${mobile ? 8 : 12}px;padding:9px 13px;border-bottom:1px solid ${C.bd};background:${C.panel3};font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.faint};">
          ${mobile ? "<span>Game · market</span><span style='text-align:center;'>Call</span><span style='text-align:center;'>Result</span>"
            : "<span>Date</span><span>Game</span><span>Market</span><span>Call</span><span style='text-align:center;'>Actual</span><span style='text-align:center;'>Result</span>"}
        </div>`;
        const tone = (r) => r.result === "win" ? this.GRD.good.fg
          : r.result === "loss" ? this.GRD.bad.fg
          : r.result ? C.dim : C.faint;
        const feedShown = Math.max(Number(this.state.feedShow) || 120, 120);
        const rows = fd.rows.slice(0, feedShown).map((r) => {
          const meta = PH.MARKETS[r.market] || { short: r.market };
          const game = `${r.away_abbr || "AWY"} @ ${r.home_abbr || "HOM"}`;
          const call = r.recommendation
            ? `${PH.OUTCOME_LABEL[r.recommendation] || r.recommendation}${r.line != null ? ` ${r.line}` : ""}`
            : "—";
          const actual = r.actual_value != null ? String(r.actual_value) : "—";
          const res = r.result ? r.result : "pending";
          if (mobile) {
            return `<div style="display:grid;grid-template-columns:1fr 74px 54px;gap:8px;padding:8px 13px;border-top:1px solid ${C.bd};font-size:11.5px;align-items:center;">
              <span style="min-width:0;"><span style="font-weight:700;">${esc(game)}</span><br/><span style="color:${C.faint};font-size:10.5px;">${esc(r.official_date)} · ${esc(meta.short)}</span></span>
              <span style="text-align:center;font-family:'IBM Plex Mono',monospace;font-size:10.5px;">${esc(call)}</span>
              <span style="text-align:center;font-weight:700;color:${tone(r)};font-size:10.5px;">${esc(res)}</span>
            </div>`;
          }
          return `<div style="display:grid;grid-template-columns:88px 1fr 128px 96px 74px 62px;gap:12px;padding:8px 13px;border-top:1px solid ${C.bd};font-size:12px;align-items:center;">
            <span style="font-family:'IBM Plex Mono',monospace;color:${C.faint};">${esc(r.official_date)}</span>
            <span style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(game)}</span>
            <span style="color:${C.mut};">${esc(meta.short)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;">${esc(call)}</span>
            <span style="text-align:center;font-family:'IBM Plex Mono',monospace;color:${C.mut};">${esc(actual)}</span>
            <span style="text-align:center;font-weight:700;color:${tone(r)};">${esc(res)}</span>
          </div>`;
        }).join("");
        const more = fd.rows.length > feedShown
          ? `<div style="padding:8px 13px;border-top:1px solid ${C.bd};font-size:11.5px;color:${C.faint};display:flex;align-items:center;gap:10px;flex-wrap:wrap;">Showing ${feedShown} of ${fd.rows.length} rows${chip("feedMore", "", "Show 240 more", false)}</div>`
          : "";
        body = head + rows + more;
      }

      const s = fd.summary || {};
      const units = Number(s.profit_units || 0);
      const stat = (label, value, tone) => `<div style="flex:1;min-width:92px;padding:9px 11px;border:1px solid ${C.bd};border-radius:11px;background:${C.panel};">
        <div style="font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};margin-bottom:3px;">${esc(label)}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:700;color:${tone || C.txt};">${esc(value)}</div>
      </div>`;
      const summary = fd.loaded && !fd.err ? `<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px;">
        ${stat("Predictions", String(s.n || 0))}
        ${stat("Graded", String(s.n_graded || 0))}
        ${stat("Hit rate", s.win_rate != null ? `${Math.round(s.win_rate * 100)}%` : "—")}
        ${stat("Net units", (units >= 0 ? "+" : "−") + Math.abs(units).toFixed(2), units >= 0 ? C.grn : "#ff7b6b")}
      </div>` : "";

      return `<div style="padding:${bare ? "0 0 18px" : (mobile ? "14px 14px 4px" : "18px 24px 6px")};">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px;">
          <span style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">Prediction history</span>
          <span style="font-size:11.5px;color:${C.faint};">stored server-side · survives reload</span>
        </div>
        ${filters}
        ${summary}
        <div style="border:1px solid ${C.bd};border-radius:13px;background:${C.panel2};overflow:hidden;">${body}</div>
      </div>`;
    }

    dataHtml() {
      const C = this.C;
      const mobile = this.mob();
      // The whole slate, not just what is live. The log is server-backed and
      // complete for the day, but its game panels were gated on
      // phase === "live", so the moment a game ended its record became
      // unreachable — every finished game on the board at 02:00 could be read
      // only in aggregate.
      const slate = this.slateGames();
      const rows = this.dfRows();
      const st = this.dfStats(rows);
      const scopeLabel = this.state.dfGame === "all"
        ? "all games today"
        : slate.find((x) => x.gamePk === this.state.dfGame)?.label
          || "all games today";

      // ── game panels ────────────────────────────────────────────────────
      const allOn = this.state.dfGame === "all";
      const allChip = `<button data-act="dfGame" data-arg="all" style="border:1px solid ${allOn ? C.acc : C.bd};background:${allOn ? "#12301f" : C.chip};color:${allOn ? C.grn : C.dim};font-family:inherit;font-weight:600;font-size:${mobile ? 11.5 : 12}px;padding:${mobile ? "4px 11px" : "5px 12px"};border-radius:999px;cursor:pointer;">All${mobile ? "" : " games"}</button>`;
      const panels = slate.map((g) => {
        const on = g.gamePk === this.state.dfGame;
        const isLive = g.phase === "live";
        const nc = this.nextCall(g);
        const state = isLive
          ? `${g.score.away}–${g.score.home} ${g.half}${g.inning}`
          : g.phase === "final" ? `${g.score.away}–${g.score.home} F`
            : (this.firstPitch(g.startTs) || "TBD");
        return `<button data-act="dfGame" data-arg="${g.gamePk}" style="${mobile ? "flex:none;width:158px;" : ""}display:flex;flex-direction:column;gap:6px;text-align:left;border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.panel};border-radius:12px;padding:${mobile ? "9px 10px" : "10px 11px"};font-family:inherit;color:${C.txt};cursor:pointer;opacity:${g.stale ? 0.7 : 1};">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:${mobile ? 12 : 12.5}px;font-weight:800;color:${on ? C.grn : C.txt};">${esc(g.label)}</span>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 10.5 : 11}px;font-weight:600;color:${on ? C.gsub : C.dim};">${esc(state)}</span>
          </div>
          ${isLive ? `<div style="display:flex;align-items:center;gap:7px;font-size:${mobile ? 11 : 11.5}px;color:${C.mut};min-width:0;">
            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(this.shortName(g.batter.name))}</span>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;color:${C.dim};">${esc(g.count)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:${mobile ? 9.5 : 10}px;font-weight:800;letter-spacing:.03em;color:${on ? C.grn : C.dim};background:${on ? "rgba(74,222,128,.16)" : C.chip};padding:2px ${mobile ? 5 : 6}px;border-radius:5px;white-space:nowrap;">${esc(nc.label)} ${esc(nc.pct)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 10 : 10.5}px;color:${C.faint};">${esc(nc.velo)}</span>
          </div>` : `<div style="font-size:${mobile ? 10 : 10.5}px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${C.faint};">${g.phase === "final" ? "Final · full record" : "Scheduled"}</div>`}
        </button>`;
      }).join("");

      // ── KPI tiles ──────────────────────────────────────────────────────
      const kpiDefs = [
        { label: "Velo MAE", value: st.mae == null ? "—" : st.mae.toFixed(2), unit: "mph", c: st.mae == null ? C.dim : this.grd(this.veloBand(st.mae)).fg, sub: `mean |called − actual| · n=${st.velo.length}` },
        { label: "Velo within 1.5", value: st.within == null ? "—" : Math.round(st.within * 100) + "%", c: st.within == null ? C.dim : st.within >= 0.5 ? this.GRD.good.fg : this.GRD.amber.fg, sub: `green band share · n=${st.velo.length}` },
        { label: "Class hit rate", value: st.clsHit == null ? "—" : Math.round(st.clsHit * 100) + "%", c: st.clsHit == null ? C.dim : st.clsHit >= 0.5 ? this.GRD.good.fg : this.GRD.amber.fg, sub: `strike/ball/in-play · n=${st.cls.length}` },
        { label: "Graded", value: String(st.n), c: C.txt, sub: `${scopeLabel}${st.pending ? ` · ${st.pending} pending` : ""} · server record` },
      ];
      const kpis = kpiDefs.map((k) => mobile
        ? `<div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};padding:11px 12px;">
            <div style="font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:${C.faint};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(k.label)}</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:700;margin-top:5px;color:${k.c};">${esc(k.value)}</div>
            <div style="font-size:10.5px;color:${C.faint};">${esc(k.sub)}</div>
          </div>`
        : `<div style="border:1px solid ${C.bd};border-radius:13px;background:${C.panel};padding:13px 15px;">
            <div style="font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};">${esc(k.label)}</div>
            <div style="display:flex;align-items:baseline;gap:8px;margin-top:7px;">
              <span style="font-family:'IBM Plex Mono',monospace;font-size:27px;font-weight:700;line-height:1;color:${k.c};">${esc(k.value)}</span>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:${C.mut};">${esc(k.unit || "")}</span>
            </div>
            <div style="font-size:11.5px;color:${C.faint};margin-top:5px;">${esc(k.sub)}</div>
          </div>`).join("");

      // ── graded log ─────────────────────────────────────────────────────
      const mkt = this.state.mkt;
      // Filters on the raw market key, not the display tag: the old VELO/CLASS
      // categories could only ever name two of the six markets the model prices.
      const logRows = rows.filter((r) => mkt === "all" || r.market === mkt);
      const mktChips = [
        ["all", "All"],
        ["pitch_speed_ou", "Pitch velo"], ["pitch_result", "Pitch result"],
        ["ab_result", "AB result"], ["ab_pitches_ou", "AB pitches"],
        ["game_moneyline", "Moneyline"], ["game_total", "Total"],
      ].map(([k, label]) => {
        const on = mkt === k;
        return `<button data-act="mkt" data-arg="${k}" style="border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.chip};color:${on ? C.grn : C.dim};font-family:inherit;font-weight:600;font-size:12px;padding:6px 12px;border-radius:999px;cursor:pointer;">${label}</button>`;
      }).join("");
      // Which slate the log is showing. `dfDate` is an America/New_York date
      // so it lines up with games.official_date, which is what the server
      // filters on — a UTC-derived date is a different day all evening.
      const today = PH.mlbDate(0);
      const yesterday = PH.mlbDate(-1);
      const dfDate = this.state.dfDate;
      const dayChips = [["today", "Today", today], ["yesterday", "Yesterday", yesterday]]
        .map(([k, label, d]) => {
          const on = k === "today" ? dfDate == null : dfDate === d;
          const arg = k === "today" ? "today" : d;
          return `<button data-act="dfDate" data-arg="${esc(arg)}" style="border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.chip};color:${on ? C.grn : C.dim};font-family:inherit;font-weight:600;font-size:12px;padding:6px 12px;border-radius:999px;cursor:pointer;">${label}</button>`;
        }).join("");

      // Two chips only ever reached two of the twenty-one days that survive in
      // `predictions`, so the rest of the retained window was stored but
      // unreachable. The stepper walks it a day at a time. It emits the same
      // dfDate action the chips do — that handler already accepts an arbitrary
      // YYYY-MM-DD — so nothing new is needed on the state side.
      //
      // Movement is by offset from today rather than by date arithmetic on the
      // string: PH.mlbDate resolves through America/New_York, and adding 86400s
      // to a naive date crosses the wrong boundary on DST days.
      const DF_RETAIN_DAYS = 20;
      const curDate = dfDate || today;
      const dayOff = Math.round(
        (Date.parse(today + "T00:00:00Z") - Date.parse(curDate + "T00:00:00Z")) / 86400000,
      );
      const stepBtn = (target, glyph, title) => {
        const live = target != null;
        return `<button ${live ? `data-act="dfDate" data-arg="${esc(target)}"` : "disabled"} title="${title}" style="border:1px solid ${C.bd};background:${C.chip};color:${live ? C.dim : C.faint};font-family:inherit;font-weight:700;font-size:12px;padding:6px 10px;border-radius:999px;cursor:${live ? "pointer" : "default"};opacity:${live ? 1 : .45};">${glyph}</button>`;
      };
      // Older is further back, so it clamps at the retention edge; newer clamps
      // at today, where the "Today" chip takes over as the live view.
      const olderArg = dayOff < DF_RETAIN_DAYS ? PH.mlbDate(-(dayOff + 1)) : null;
      const newerArg = dayOff > 0
        ? (dayOff === 1 ? "today" : PH.mlbDate(-(dayOff - 1)))
        : null;
      const dayStepper = `${stepBtn(olderArg, "◀", "Older slate")}<span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.mut};min-width:74px;text-align:center;">${esc(curDate)}</span>${stepBtn(newerArg, "▶", "Newer slate")}`;

      // Reveal in pages rather than truncating at a fixed cap. A full slate
      // runs to thousands of rows and the old hard slice (60 desktop / 40
      // mobile) put yesterday's out of reach entirely.
      const shown = Math.max(Number(this.state.dfShow) || 60, 60);
      const moreCount = Math.max(logRows.length - shown, 0);
      const moreBtn = moreCount
        ? `<div style="padding:11px 14px;border-top:1px solid ${C.row};text-align:center;"><button data-act="dfMore" style="border:1px solid ${C.bd};background:${C.chip};color:${C.dim};font-family:inherit;font-weight:600;font-size:11.5px;padding:6px 14px;border-radius:999px;cursor:pointer;">Show 120 more · ${moreCount} remaining</button></div>`
        : "";

      // One tint per market family so the six of them stay tellable apart at a
      // glance in a mixed log: pitch-level cool, at-bat warm, game-level neutral.
      const MKT_TINT = {
        VELO: ["rgba(106,162,255,.16)", "#6aa2ff"],
        CLASS: ["rgba(164,123,255,.16)", "#a37bff"],
        AB: ["rgba(224,168,58,.16)", "#e0a83a"],
        "AB P": ["rgba(79,184,119,.16)", "#4fb877"],
        ML: ["rgba(255,123,107,.16)", "#ff7b6b"],
        TOT: ["rgba(132,147,170,.20)", "#aebdd2"],
      };
      const mktTag = (m) => {
        const t = MKT_TINT[m] || MKT_TINT.TOT;
        return `background:${t[0]};color:${t[1]};`;
      };

      // Reconstructed rows sit in the same table as live ones and count the
      // same way, so the only thing separating them is this mark. Muted rather
      // than alarming — the call is real, it just wasn't made at the time.
      const backTag = (on) => on
        ? `<span title="Reconstructed after the fact — not a live call" style="font-size:9.5px;font-weight:800;letter-spacing:.04em;background:rgba(160,160,160,.16);color:${C.mut};padding:2px 5px;border-radius:4px;margin-right:6px;">BF</span>`
        : "";

      const logCols = "66px 92px minmax(0,1.25fr) 44px minmax(0,1.15fr) minmax(0,1.35fr)";
      const desktopLog = logRows.slice(0, shown).map((r) => {
        const gr = this.grd(r.band);
        return `<div style="display:grid;grid-template-columns:${logCols};gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid ${C.row};font-size:12.5px;">
          <span style="font-family:'IBM Plex Mono',monospace;color:${C.faint};">${esc(this.fmtTime(r.t))}</span>
          <span style="font-weight:700;font-size:12px;">${esc(r.game)}</span>
          <span style="color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.matchup)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;color:${C.mut};">${esc(r.count)}</span>
          <span style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="font-size:9.5px;font-weight:800;letter-spacing:.04em;${mktTag(r.mkt)}padding:2px 5px;border-radius:4px;margin-right:6px;">${r.mkt}</span>${backTag(r.back)}<b style="font-family:'IBM Plex Mono',monospace;font-weight:600;">${esc(r.pred)}</b></span>
          <span style="display:flex;align-items:baseline;gap:9px;border-radius:8px;background:${gr.bg};padding:5px 10px;min-width:0;">
            <b style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:${gr.fg};white-space:nowrap;">${esc(r.actual)}</b>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.mut};white-space:nowrap;">${esc(r.err)}</span>
          </span>
        </div>`;
      }).join("");

      const mobileLog = logRows.slice(0, shown).map((r) => {
        const gr = this.grd(r.band);
        const open = this.state.openLog === r.id;
        const kv = (k, v) => `<div style="display:flex;justify-content:space-between;gap:10px;"><span style="color:${C.faint};">${k}</span><span>${esc(v)}</span></div>`;
        return `<div style="border-bottom:1px solid ${C.row};">
          <div data-act="logRow" data-arg="${esc(r.id)}" style="display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;align-items:center;padding:10px 12px;cursor:pointer;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">${esc(this.fmtTime(r.t))}</span>
            <span style="min-width:0;">
              <span style="display:block;font-size:12.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.game)} · ${r.mkt}${r.back ? ` <span style="font-weight:800;font-size:9.5px;letter-spacing:.04em;color:${C.mut};">BF</span>` : ""}</span>
              <span style="display:block;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.mut};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">called ${esc(r.pred)}</span>
            </span>
            <span style="display:block;border-radius:7px;background:${gr.bg};padding:4px 8px;text-align:right;">
              <span style="display:block;font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${gr.fg};white-space:nowrap;">${esc(r.actual)}</span>
              <span style="display:block;font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.mut};white-space:nowrap;">${esc(r.err)}</span>
            </span>
          </div>
          ${open ? `<div style="padding:0 12px 12px;display:flex;flex-direction:column;gap:6px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};">
            ${kv("matchup", r.matchup)}${kv("count · outs", `${r.count} · ${r.outs}`)}${kv("predicted", r.predRaw)}${kv("actual", r.actualRaw)}${kv("error", r.err)}${kv("model", r.model)}${kv("graded", this.fmtTime(r.t))}${r.back ? kv("source", "reconstructed") : ""}
          </div>` : ""}
        </div>`;
      }).join("");

      const logEmpty = `<div style="padding:16px 14px;font-size:12.5px;color:${C.faint};font-style:italic;line-height:1.55;">${dfDate
        ? `No predictions stored for ${esc(dfDate)}${mkt === "all" ? "" : " in this market"}. Raw predictions are kept for 21 days; older slates survive only as the game-level history above.`
        : `No predictions yet today${mkt === "all" ? "" : " in this market"} — a row lands as soon as one is made. Switch to Yesterday for the last completed slate.`}</div>`;

      // ── analytics modules (computed from the session log) ───────────────
      const modCard = (title, body, note, right) => `<div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel};padding:15px 16px;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px;">
          <span style="font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">${title}</span>
          ${right || ""}
        </div>
        ${body}
        ${note ? `<div style="font-size:11.5px;color:${C.faint};margin-top:10px;padding-top:9px;border-top:1px solid ${C.row};line-height:1.5;">${note}</div>` : ""}
      </div>`;
      const thin = (msg) => `<div style="font-size:12.5px;color:${C.faint};font-style:italic;line-height:1.55;">${msg}</div>`;

      // calibration by market, with a naive baseline tick
      const clsBase = (() => {
        const counts = {};
        st.cls.forEach((r) => { counts[r.actualRaw] = (counts[r.actualRaw] || 0) + 1; });
        const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        return st.cls.length && top ? counts[top] / st.cls.length : null;
      })();
      const veloBase = (() => {
        if (st.velo.length < 6) return null;
        const mean = st.velo.reduce((a, r) => a + r.speed, 0) / st.velo.length;
        return st.velo.filter((r) => Math.abs(mean - r.speed) <= 1.5).length / st.velo.length;
      })();
      const calibRows = [
        { label: "Pitch velo · within 1.5 mph", hit: st.within, n: st.velo.length, base: veloBase, note: "vs always calling the session mean velo" },
        { label: "Pitch result · class correct", hit: st.clsHit, n: st.cls.length, base: clsBase, note: "vs always calling the most common class" },
      ].filter((r) => r.n > 0);
      const calib = modCard("Calibration by market · today",
        calibRows.length ? calibRows.map((r) => {
          const c = r.hit >= 0.6 ? this.GRD.good.fg : r.hit >= 0.45 ? this.GRD.amber.fg : this.GRD.bad.fg;
          return `<div style="margin-bottom:11px;">
            <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12.5px;">
              <span style="color:${C.dim};">${esc(r.label)}</span>
              <span><b style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:${c};">${Math.round(r.hit * 100)}%</b> <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">n=${r.n}</span></span>
            </div>
            <div style="position:relative;height:7px;background:${C.chip};border-radius:999px;margin-top:6px;">
              <span style="position:absolute;left:0;top:0;height:100%;border-radius:999px;width:${Math.round(r.hit * 100)}%;background:${c};display:block;"></span>
              ${r.base == null ? "" : `<span style="position:absolute;top:-3px;left:${Math.round(r.base * 100)}%;width:2px;height:13px;background:${C.faint};display:block;"></span>`}
            </div>
            <div style="font-size:11px;color:${C.faint};margin-top:4px;">${esc(r.note)}</div>
          </div>`;
        }).join("") : thin("Fills in once graded pitches land."),
        `Grey tick = naive baseline. Session-scoped: a per-day graded endpoint would let this cover the whole slate.`);

      // velo trend by inning for the scoped pitcher(s)
      const trend = (() => {
        // `inning` is null on every row whose pitch could not be joined
        // server-side (see the pitch_number=0 note in pitchfeed.ts) — on
        // 2026-08-16 that was 1,199 of 1,994 rows. Bucketing into a plain object
        // stored those under the key "null", Number() turned it into NaN, and
        // the lookup that followed was undefined: the whole Data Feed threw
        // before it could paint, so the tab read as a dead button. Filtering
        // first and keying a Map on the number cannot express that state.
        const byInn = new Map();
        st.velo.forEach((r) => {
          const inn = Number(r.inning);
          if (r.speed == null || !Number.isFinite(inn)) return;
          const bucket = byInn.get(inn) || [];
          bucket.push(r.speed);
          byInn.set(inn, bucket);
        });
        if (byInn.size < 2) return null;
        const bars = [...byInn.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([inn, vals]) => ({ inn, v: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length }));
        const lo = Math.min.apply(null, bars.map((b) => b.v)), hi = Math.max.apply(null, bars.map((b) => b.v));
        const drop = bars[bars.length - 1].v - bars[0].v;
        return { bars, lo, hi, drop };
      })();
      const veloTrend = modCard("Velo trend by inning",
        trend ? `<div style="display:flex;align-items:flex-end;gap:6px;">${trend.bars.map((b) => {
          const h = trend.hi === trend.lo ? 40 : 16 + Math.round(((b.v - trend.lo) / (trend.hi - trend.lo)) * 46);
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.mut};">${b.v.toFixed(1)}</span>
            <span style="width:100%;border-radius:4px 4px 0 0;background:${this.veloColor(b.v)};height:${h}px;display:block;"></span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.faint};">${b.inn}</span>
          </div>`;
        }).join("")}</div>` : thin("Needs pitches from two or more innings today."),
        trend ? `Average actual velocity per inning across ${esc(scopeLabel)}.` : null,
        trend ? `<span style="font-size:12px;font-weight:700;">${trend.drop >= 0 ? "+" : "−"}<span style="font-family:'IBM Plex Mono',monospace;color:${trend.drop < -1 ? C.red : C.dim};font-weight:600;">${Math.abs(trend.drop).toFixed(1)} mph</span></span>` : "");

      // pitch mix by count bucket
      const mix = (() => {
        // Same missing-situation rows as the trend above. An unknown count
        // arrives as the em-dash placeholder, which split to NaN and then fell
        // through every comparison into "even" — a real bucket, silently
        // inflated by rows that belong in none of them.
        const cnt = (c) => {
          const m = /^(\d+)-(\d+)$/.exec(String(c == null ? "" : c));
          return m ? [Number(m[1]), Number(m[2])] : null;
        };
        const src = rows.filter((r) => r.mkt === "VELO" && r.type && cnt(r.count));
        if (src.length < 8) return null;
        const bucket = (c) => {
          const [b, s] = cnt(c);
          if (b === 0 && s === 0) return "0-0";
          if (s > b) return "ahead";
          if (b > s) return "behind";
          return "even";
        };
        const cols = ["0-0", "ahead", "even", "behind"];
        const tally = {}, totals = {};
        src.forEach((r) => {
          const bk = bucket(r.count);
          tally[r.type] = tally[r.type] || {};
          tally[r.type][bk] = (tally[r.type][bk] || 0) + 1;
          totals[bk] = (totals[bk] || 0) + 1;
        });
        const types = Object.keys(tally).sort((a, b) => {
          const sa = cols.reduce((x, c) => x + (tally[a][c] || 0), 0), sb = cols.reduce((x, c) => x + (tally[b][c] || 0), 0);
          return sb - sa;
        }).slice(0, 5);
        return { cols, types, tally, totals, n: src.length };
      })();
      const mixCard = modCard("Pitch mix by count",
        mix ? `<div style="display:grid;grid-template-columns:56px repeat(4,1fr);gap:5px;font-size:11px;">
          <span></span>${mix.cols.map((c) => `<span style="font-family:'IBM Plex Mono',monospace;color:${C.faint};text-align:center;">${c}</span>`).join("")}
          ${mix.types.map((t) => `<span style="font-weight:800;color:${this.pitchColor(t)};align-self:center;">${esc(t)}</span>${mix.cols.map((c) => {
            const n = (mix.tally[t][c] || 0), tot = mix.totals[c] || 0;
            const p = tot ? Math.round((n / tot) * 100) : null;
            const a = p == null ? 0 : Math.min(0.34, (p / 100) * 0.42);
            return `<span style="font-family:'IBM Plex Mono',monospace;text-align:center;padding:7px 0;border-radius:6px;background:rgba(34,165,102,${a.toFixed(2)});color:${p == null ? C.faint : C.txt};font-weight:600;">${p == null ? "—" : p + "%"}</span>`;
          }).join("")}`).join("")}
        </div>` : thin("Needs at least 8 graded pitches today."),
        mix ? `Share of pitches by type within each count state · n=${mix.n}.` : null);

      // confidence vs accuracy
      const conf = (() => {
        const src = st.cls.filter((r) => r.conf != null);
        if (src.length < 4) return null;
        const buckets = [["<50%", 0, 0.5], ["50–60%", 0.5, 0.6], ["60–70%", 0.6, 0.7], ["70%+", 0.7, 1.01]];
        return buckets.map(([label, lo, hi]) => {
          const b = src.filter((r) => r.conf >= lo && r.conf < hi);
          return { label, n: b.length, hit: b.length ? b.filter((r) => r.hit).length / b.length : null };
        }).filter((b) => b.n > 0);
      })();
      const confCard = modCard("Confidence vs accuracy",
        conf ? conf.map((b) => {
          const c = b.hit >= 0.6 ? this.GRD.good.fg : b.hit >= 0.45 ? this.GRD.amber.fg : this.GRD.bad.fg;
          return `<div style="display:grid;grid-template-columns:66px minmax(0,1fr) 92px;gap:10px;align-items:center;padding:4px 0;font-size:12.5px;">
            <span style="font-family:'IBM Plex Mono',monospace;color:${C.dim};">${b.label}</span>
            <span style="height:7px;background:${C.chip};border-radius:999px;overflow:hidden;display:block;"><span style="display:block;height:100%;border-radius:999px;width:${Math.round(b.hit * 100)}%;background:${c};"></span></span>
            <span style="font-family:'IBM Plex Mono',monospace;text-align:right;"><b style="font-weight:600;color:${c};">${Math.round(b.hit * 100)}%</b> <span style="font-size:11px;color:${C.faint};">n=${b.n}</span></span>
          </div>`;
        }).join("") : thin("Needs at least 4 graded class calls today."),
        "A calibrated model's hit rate should track its stated confidence.");

      // mobile digest — only claims the session data actually supports
      const digest = (() => {
        const out = [];
        if (st.velo.length >= 6) {
          out.push({
            c: st.mae <= 1.5 ? this.GRD.good.fg : st.mae <= 3 ? this.GRD.amber.fg : this.GRD.bad.fg,
            kicker: "Velocity", head: `Calling velo to ${st.mae.toFixed(2)} mph on average`,
            body: st.mae <= 1.5 ? "Inside the green band — the model is reading this pitcher's velocity well." : "Outside the green band; treat the velo line as soft here.",
            stat1: `${Math.round(st.within * 100)}% within 1.5`, stat2: `n=${st.velo.length}`,
          });
        }
        if (st.cls.length >= 6) {
          out.push({
            c: st.clsHit >= 0.5 ? this.GRD.good.fg : this.GRD.amber.fg,
            kicker: "Pitch result", head: `${Math.round(st.clsHit * 100)}% of class calls landed`,
            body: "Strike/foul, ball and in-play calls graded against what actually happened.",
            stat1: `${st.cls.filter((r) => r.hit).length}/${st.cls.length} correct`, stat2: `${scopeLabel}`,
          });
        }
        if (trend && Math.abs(trend.drop) >= 1) {
          out.push({
            c: trend.drop < 0 ? this.GRD.bad.fg : this.GRD.good.fg,
            kicker: "Fatigue", head: `Velocity ${trend.drop < 0 ? "down" : "up"} ${Math.abs(trend.drop).toFixed(1)} mph since the first inning seen`,
            body: "Averaged per inning across every pitch graded today.",
            stat1: `${trend.bars[0].v.toFixed(1)} → ${trend.bars[trend.bars.length - 1].v.toFixed(1)}`, stat2: `${trend.bars.length} innings`,
          });
        }
        return out;
      })();

      // ── assemble ───────────────────────────────────────────────────────
      if (mobile) {
        return `<div style="padding:14px 14px 20px;">
          <h1 style="margin:0;font-size:23px;font-weight:800;letter-spacing:-.02em;">${esc(COPY.dataTitle)}</h1>
          <p style="margin:4px 0 14px;font-size:13px;color:${C.mut};">${esc(COPY.dataSub)}</p>

          ${this.feedHtml(true)}

          <div style="display:flex;align-items:center;gap:9px;margin-bottom:8px;">
            <span style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};">Live games</span>
            ${allChip}
            <span style="margin-left:auto;font-size:10.5px;color:${C.faint};">${esc(scopeLabel)}</span>
          </div>
          <div class="phv-sc" style="display:flex;gap:8px;overflow-x:auto;margin:0 -14px 14px;padding:0 14px 2px;">${panels}</div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:14px;">${kpis}</div>

          ${digest.length ? `
          <div style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};margin-bottom:8px;">Today's read</div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
            ${digest.map((d) => `<div style="border:1px solid ${C.bd};border-left:3px solid ${d.c};border-radius:12px;background:${C.panel};padding:11px 13px;">
              <div style="font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:${d.c};">${esc(d.kicker)}</div>
              <div style="font-size:14.5px;font-weight:700;margin-top:4px;line-height:1.35;">${esc(d.head)}</div>
              <div style="font-size:12.5px;color:${C.mut};margin-top:5px;line-height:1.45;">${esc(d.body)}</div>
              <div style="display:flex;gap:12px;margin-top:8px;padding-top:8px;border-top:1px solid ${C.row};font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};">
                <span>${esc(d.stat1)}</span><span style="color:${C.vs};">·</span><span>${esc(d.stat2)}</span>
              </div>
            </div>`).join("")}
          </div>` : ""}

          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;">
            <span style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};">Graded log</span>
            <span style="font-size:11px;color:${C.faint};">tap a row for raw values</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">${dayChips}</div>
          <div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};overflow:hidden;margin-bottom:16px;">${mobileLog || logEmpty}${moreBtn}</div>

          <div style="display:flex;flex-direction:column;gap:12px;">${calib}${veloTrend}${confCard}</div>
        </div>`;
      }

      return `<div style="padding:20px 24px 28px;">
        <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:14px;">
          <h1 style="margin:0;font-size:27px;font-weight:800;letter-spacing:-.02em;">${esc(COPY.dataTitle)}</h1>
          <p style="margin:0;font-size:13.5px;color:${C.mut};">${esc(COPY.dataSub)}</p>
          <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.faint};">30-day stored history · today and yesterday graded per pitch</span>
        </div>

        ${this.feedHtml(true)}

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px;">
          <span style="font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};">Live games</span>
          ${allChip}
          <span style="margin-left:auto;font-size:11.5px;color:${C.faint};">Showing <b style="color:${C.dim};font-weight:600;">${esc(scopeLabel)}</b> — pick a panel to scope the log and modules</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:9px;margin-bottom:16px;">${panels}</div>

        ${this.scoutingHtml()}

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:16px;">${kpis}</div>

        <div style="display:grid;grid-template-columns:${this.narrow() ? "minmax(0,1fr)" : "minmax(0,1fr) 400px"};gap:16px;align-items:start;">
          <div style="min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
              <span style="font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};margin-right:2px;">Day</span>
              ${dayChips}
              <span style="display:inline-flex;align-items:center;gap:5px;">${dayStepper}</span>
              <span style="width:1px;height:16px;background:${C.bd2};"></span>
              <span style="font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};margin-right:2px;">Market</span>
              ${mktChips}
              <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.faint};">${logRows.length} rows</span>
            </div>
            <div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel};overflow:hidden;">
              <div style="display:grid;grid-template-columns:${logCols};gap:10px;padding:10px 14px;border-bottom:1px solid ${C.bd};background:${C.panel2};font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.faint};">
                <span>Time</span><span>Game</span><span>Matchup</span><span>Cnt</span><span>Prediction</span><span>Actual · error</span>
              </div>
              ${desktopLog || logEmpty}
              ${moreBtn}
              ${desktopLog ? `<div style="padding:11px 14px;font-size:11.5px;color:${C.faint};line-height:1.5;">Every call the model made on this slate — pitch, at-bat and game level. Errors are signed: called minus actual. Shading grades the call — green within 1.5 mph, amber ≤3, red beyond; class and outcome calls green when right, red when wrong.${logRows.some((r) => r.pending) ? ` <b style="color:${C.mut};">pending</b> marks a call the game has not settled yet; it is shown but counts toward nothing.` : ""}${logRows.some((r) => r.back) ? ` <b style="color:${C.mut};">BF</b> marks a call reconstructed after the fact, with the models current at backfill time rather than at the pitch — it counts in the record, but nobody could have acted on it.` : ""}</div>` : ""}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px;">${calib}${veloTrend}${mixCard}${confCard}</div>
        </div>
      </div>`;
    }

    // Shown in place of a view that threw. Deliberately plain and honest: this
    // is a bug in the board, not an empty schedule or a backend outage, and
    // saying so is what stops it being reported as missing data.
    viewErrorHtml(view, err) {
      const C = this.C;
      const label = (COPY.tabs.find(([k]) => k === view) || [view, view])[1];
      return `<div style="padding:32px 24px;">
        <div style="max-width:640px;margin:0 auto;border:1px solid ${C.bd};border-left:3px solid ${C.red};border-radius:14px;background:${C.panel};padding:18px 20px;">
          <div style="font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.red};">Display error</div>
          <div style="font-size:15px;font-weight:700;margin-top:6px;">${esc(label)} couldn't be drawn</div>
          <p style="font-size:12.5px;color:${C.mut};line-height:1.55;margin:8px 0 0;">${esc(COPY.viewError)}</p>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};margin-top:10px;padding-top:9px;border-top:1px solid ${C.row};word-break:break-word;">${esc(String((err && err.message) || err))}</div>
        </div>
      </div>`;
    }

    render() {
      // The whole UI is rebuilt with innerHTML, which destroys focus and
      // selection. Skip a render while the user is typing in a feed filter —
      // otherwise the 8s poll yanks the cursor out of the box mid-word. The
      // pending state is picked up by the next render after blur.
      const ae = document.activeElement;
      if (ae && ae.hasAttribute && ae.hasAttribute("data-feedfilter") && this.root.contains(ae)) {
        this._renderDeferred = true;
        return;
      }
      this._renderDeferred = false;
      this.root.setAttribute("data-theme", this.dk() ? "dark" : "light");
      const view = this.state.view;
      // A view is built to a string BEFORE it is assigned, so anything that
      // throws in here used to leave the previous tab's DOM in place — the tab
      // button looked broken rather than the render looking broken, which is
      // how a null `inning` cost the Data Feed a day in production. The
      // fallback keeps the chrome (header, nav, footer) so the user can still
      // leave the tab, and says what happened rather than rendering blank.
      let main;
      try {
        if (view === "home") main = this.homeHtml();
        else if (view === "live") main = this.liveHtml();
        else main = this.dataHtml();
      } catch (e) {
        console.error(`[pitchhawk] ${view} view failed to render`, e);
        main = this.viewErrorHtml(view, e);
      }
      this._bindMq();
      const wide = view !== "home";
      this.root.innerHTML = `
        ${this.headerHtml()}
        <main class="ph-main${wide ? " phv-wide" : ""}">${main}</main>
        ${wide ? "" : this.footerHtml()}`;
    }

    // ── data lifecycle ────────────────────────────────────────────────────
    // /live now serves the whole slate with an explicit `phase` per game, so
    // the client no longer has to reconcile a stale live_state against the
    // schedule to work out which games are over — the server does it, from
    // games.status. The old _withoutFinals() filter is gone with it; dropping
    // finals here would now delete a section the board is meant to render.
    // ── durable prediction history ────────────────────────────────────────
    // Signature-gated so the 8s poll does not re-request an unchanged window.
    async syncFeed(force) {
      const f = this.state.feedF;
      const sig = JSON.stringify(f);
      if (!force && sig === this._feedSig) return;
      this._feedSig = sig;
      // The window is expressed in America/New_York because the server filters
      // on games.official_date, which is an Eastern date. Deriving it from
      // toISOString() (UTC) asked for tomorrow's slate from 20:00 ET onward —
      // so the "Today" chip went blank during exactly the hours games are
      // being played, and every window was shifted a day forward.
      const to = PH.mlbDate(0);
      const from = PH.mlbDate(-(Number(f.days) - 1));
      const PAGE_LIMIT = 1000;
      const PAGE_CAP = 8;
      try {
        // `next_cursor` was previously returned and ignored, which capped the
        // panel at one page. A 30-day window runs to thousands of rows.
        let cursor = 0;
        let games = [];
        let players = [];
        let summary = null;
        for (let page = 0; page < PAGE_CAP; page += 1) {
          const res = await PH.loadFeed(API_BASE, Object.assign({
            from, to, limit: PAGE_LIMIT,
            market: f.market, phase: f.phase, team: f.team,
            pitcher_id: f.pitcher_id, batter_id: f.batter_id,
          }, cursor ? { cursor } : {}));
          if (summary == null) summary = res.summary || null;
          // Player rollups are not cursor-paged — they come back whole on the
          // first request and repeat identically after it.
          if (page === 0) players = res.players || [];
          games = games.concat(res.games || []);
          if (!res.next_cursor) break;
          cursor = res.next_cursor;
        }
        this.state.feed = {
          rows: games, players, summary, loaded: true, err: false,
        };
      } catch (_e) {
        // Keep whatever we had; flag it so the panel says "couldn't reach"
        // rather than implying there is no history.
        this.state.feed = Object.assign({}, this.state.feed, { loaded: true, err: true });
      }
      this.render();
    }

    liveGames() { return (PH.games || []).filter((g) => g.phase === "live"); }
    upcomingGames() { return (PH.games || []).filter((g) => g.phase === "pregame"); }
    finalGames() { return (PH.games || []).filter((g) => g.phase === "final"); }

    async poll() {
      try {
        await fetchSlate().catch(() => {});
        // Refreshed on its own 5-minute cadence inside fetchRecap; calling it
        // every tick is a no-op until then.
        fetchRecap().then((changed) => { if (changed) this.render(); }).catch(() => {});
        const games = await PH.loadLive(API_BASE);
        if (Array.isArray(games)) {
          PH.games = games;
          // Not awaited: the board must never wait on at-bat history. It
          // re-renders itself when the rows land, and no-ops unless the PA
          // actually turned over.
          this.syncPaHistory()
            .then((changed) => { if (changed) this.render(); })
            .catch(() => {});
          // Not awaited: the board must never wait on the graded feed. It
          // re-renders itself when the rows land.
          this.loadPitchFeed()
            .then((changed) => { if (changed) this.render(); })
            .catch(() => {});
          this.render();
          // Deliberately not awaited: the live board must not wait on the
          // warehouse. syncScouting no-ops unless the pitcher/batter/game
          // actually changed, and every fetch inside it degrades to null.
          this.syncScouting();
        }
        // loadLive throws on network error → keep last-good board.
      } catch (_e) { console.warn("[pitchhawk] live poll failed; keeping last data"); }
    }
    async hydrate() {
      try {
        const changed = await fetchSlate();
        if (changed) this.render();
      } catch (_e) { /* keep last-good schedule */ }
    }
    // ±20% jitter so 1000 clients don't stampede the origin in lockstep.
    _jitter(ms) { return Math.round(ms * (0.8 + Math.random() * 0.4)); }
    _scheduleNextPoll() {
      clearTimeout(this._pollTo);
      this._pollTo = setTimeout(() => this._pollTick(), this._jitter(POLL_MS));
    }
    async _pollTick() {
      // Pause network work while the tab is backgrounded.
      if (!document.hidden) { await this.poll(); await this.hydrate(); await this.checkHealth(); }
      this._scheduleNextPoll();
    }
    // Show a "data delayed" banner when /health reports live-poll is >2m stale
    // WHILE games are on the board. Outside game windows the poller sleeps by
    // design, so an idle board is never flagged as stale.
    async checkHealth() {
      const h = await fetchJson("/health");
      // Must be LIVE games, not slate games. PH.games now carries the whole
      // slate, so `PH.games.length > 0` would flag the poller as stale every
      // morning — while it is correctly asleep before first pitch, which is
      // exactly the case the banner is documented not to fire in.
      this._setStaleBanner(!!(h && h.data_fresh === false) && this.liveGames().length > 0, h);
    }
    _setStaleBanner(stale, h) {
      let el = document.getElementById("ph-stale");
      if (!stale) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement("div");
        el.id = "ph-stale";
        el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#b9541b;" +
          "color:#fff;text-align:center;font-size:.85rem;padding:.4rem;font-family:inherit;";
        document.body.appendChild(el);
      }
      const age = h && h.jobs && h.jobs["live-poll"] ? h.jobs["live-poll"].age_seconds : null;
      el.textContent = "⚠ Live data delayed" +
        (age != null ? ` (updated ~${Math.round(age / 60)}m ago)` : "") +
        " — showing the last data received.";
    }
    start() {
      this.render();
      this.hydrate();
      this.poll();
      // Both are durable, server-side and independent of what is live right
      // now — they are what the board and feed show before first pitch, so
      // they are fetched on boot rather than waiting for a game to start.
      fetchRecap(true).then(() => this.render()).catch(() => {});
      this.syncFeed(true);
      // The day's graded predictions, on boot. This is the difference between
      // "the log starts filling once you arrive" and "the log is already
      // complete when you arrive" — the whole point of moving it server-side.
      this.loadPitchFeed()
        .then((changed) => { if (changed) this.render(); })
        .catch(() => {});
      this.checkHealth();
      this._scheduleNextPoll();
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) { clearTimeout(this._pollTo); this._pollTick(); }
      });
    }
  }

  function boot() {
    const root = document.getElementById("ph-root");
    if (!window.PITCHHAWK) {
      root.innerHTML = `<div style="padding:4.5rem 0;text-align:center;color:#7a879c;font-size:.95rem;">Loading Pitch Hawk…</div>`;
      return;
    }
    const board = new Board(root);
    board.start();
    // Restore the Data Feed's warehouse panels immediately, before the first
    // poll returns. With no live games this is the only thing that puts
    // content in the tab, and it is what makes it survive a refresh.
    board.syncScouting();
    window.__npBoard = board;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
