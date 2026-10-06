// ════════════════════════════════════════════════════════════════════════
// pitchhawk.js — Pitch Hawk single-page app.
//
// One page, four tabs: Home / Predictions / Live / Data Feed (the 2026-09
// redesign, spec in design/redesign/). No framework: every view
// is a method returning an HTML string, render() replaces the whole tree with
// innerHTML on each 8s poll, and interactivity is `data-act` / `data-arg`
// delegation from two listeners on the root. Nothing may hold state in the DOM,
// because the DOM does not survive a poll.
//
// The two feed tabs are the same three-level drill-down — game, at-bat, pitch —
// over one shape built by buildGameModels(). The Live Feed puts the model's
// most confident open call on top of it; the Data Feed puts KPI tiles and four
// charts on top of it and walks the retained window one slate at a time.
//
// Data layer, all through window.PITCHHAWK:
//   • Home     — today's schedule from GET /games.
//   • Both feeds — GET /pitches for the slate (loadDayRows), GET /board for its
//     scores (loadDayMeta), GET /live for the hero's open call and the current
//     at-bat, GET /accuracy for the trend chart. Live games are re-pulled
//     narrowly by refreshLiveRows() rather than re-paging the whole day.
//   • Wagering surfaces are off: no odds are fetched and none are rendered.
// ════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  const API_BASE = window.PITCH_EDGE_API || "http://localhost:8080";
  const POLL_MS = 8000;   // backend polls MLB every ~8s (POLL_INTERVAL_SECONDS)
  // ★ Watching pins, `g:<game_pk>` and `b:<batter id>`, under the key the
  // redesign handoff names.
  const PINS_KEY = "ph-watch";
  const PROJ_TTL_MS = 60000; // /projections is CDN-cached for 60s
  // Every clock on the board is Eastern: the slate is an Eastern date
  // (games.official_date) and the header says "all times ET".
  const ET = "America/New_York";

  const PH = window.PITCHHAWK;
  const COPY = window.PH_COPY;
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
  //
  // On an off day /games answers with the NEXT slate and is_today=false, so
  // Home says "Next slate · Sat, Oct 3" instead of "no games". SLATE_DATE is
  // that slate's America/New_York date; null until /games has answered, and
  // read as today. The bare-array shape is the pre-2026-10-02 API, still
  // accepted so this file can ship before the edge function does.
  let SLATE = null;
  let SLATE_AT = 0;
  let SLATE_DATE = null;
  let SLATE_IS_TODAY = true;
  async function fetchSlate() {
    if (SLATE !== null && Date.now() - SLATE_AT < 60000) return false;
    const body = await fetchJson("/games");
    const rows = Array.isArray(body) ? body : (body && Array.isArray(body.games) ? body.games : null);
    if (!rows) return false;
    SLATE_AT = Date.now();
    const date = Array.isArray(body) ? null : (body.date || null);
    const isToday = Array.isArray(body) ? true : body.is_today !== false;
    const changed = JSON.stringify(rows) !== JSON.stringify(SLATE)
      || date !== SLATE_DATE || isToday !== SLATE_IS_TODAY;
    SLATE = rows;
    SLATE_DATE = date;
    SLATE_IS_TODAY = isToday;
    return changed;
  }
  // The date the Home and Predictions tabs are about.
  const slateDate = () => SLATE_DATE || PH.mlbDate(0);

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
        // GET /game/{pk}/context per game, fetched once on a Home pill's first
        // expand rather than on every poll.
        gameCtx: {},
        // Which game the Live tab describes. "top" is the most confident open
        // call across every live game; a gamePk pins the view to that game.
        liveSel: "top",
        // Every micro-market prediction for a slate, and the slate itself, keyed
        // by America/New_York date. Home and Live read today's for each game's
        // at-bat and pitch record.
        days: {}, dayMeta: {},
        // Per-day, per-market accuracy from /accuracy. Never pruned, so this is
        // the one series that outlives the raw predictions.
        accuracy: { days: [], markets: [], loaded: false, err: false },
        // Starter profiles + fatigue per player_id (loadEntityProfile), used by
        // the Starters tables and the Live rail.
        entityProfile: {},
        dark: initialDark(), t: 0,

        // ── 2026-09 redesign shell ──
        // Pinned games and batters, persisted to localStorage[PINS_KEY].
        pins: this.loadPins(),
        // Fetch health of /live. `down` is the last poll failing outright —
        // a connection problem, never to be drawn as an empty slate.
        // `lastGood` is when /live last answered; `updatedAt` feeds the
        // "updated hh:mm:ss" clocks.
        api: { down: false, lastGood: null, updatedAt: null },
        // Home / Predictions ranking mode. null = automatic: Live whenever a
        // game is live, otherwise Pregame (see effectiveMode()).
        mode: null,
        // Home pill expansion and side tab, keyed by game_pk. Written by
        // openPill() from anywhere on the board; read by the Home pills.
        open: {}, tab: {}, psort: {},
        // Phone layout (mob()): which cards are expanded, plus the collapsed
        // filter panels, keyed by mCardHtml's key. Held here, not in the DOM,
        // because render() replaces the tree on every poll.
        mOpen: {},
        // Head-to-head per "pitcherId:batterId" from GET /matchup. Absent =
        // not asked yet; { pending } in flight; otherwise the route's body.
        h2h: {},
        // Predictions filters (see PRED_DEFAULTS) and the trust tiles.
        ...this.PRED_DEFAULTS,
        trust: null,
        // Data Feed: the master filters (see D_DEFAULTS), the paged feed, the
        // aggregates and the stadium list.
        ...this.D_DEFAULTS,
        graded: { rows: [], total: 0, next: null, loaded: false, err: false },
        gsum: { data: null, source: null, err: false },
        venues: [],
        // Today's batter projections (GET /projections), both markets.
        // `rows` is null until the first fetch settles.
        proj: { rows: null, err: false },
      };
      this._projAt = 0;
      // Freshness stamps already flashed, so a re-render does not replay it.
      this._seen = {};
      this._pollIv = null;
      // Per-date fetch gates and built-model caches. Plain objects rather than
      // a single signature, because two tabs can want two different days.
      this._dayRowsSig = {};
      this._dayRowsSeq = {};
      this._models = {};
      this.root.addEventListener("click", (e) => this._onClick(e));
      // `change` rather than `input`: it fires on blur/Enter, so a re-render
      // never lands mid-keystroke. Combined with the focus guard in render(),
      // typing in a filter box survives the 8s poll.
      this.root.addEventListener("change", (e) => this._onFilterChange(e));
    }

    _onFilterChange(e) {
      // Predictions: team select and the MIN LIFT slider.
      const pf = e.target && e.target.closest ? e.target.closest("[data-pfilter]") : null;
      if (pf) {
        const key = pf.getAttribute("data-pfilter");
        // Data Feed selects reset the feed and re-ask for the scenario.
        if (key === "dTeam" || key === "dPark") {
          if (pf.blur) pf.blur();
          return this.dSet({ [key]: pf.value || "" });
        }
        const val = key === "pMin" ? Number(pf.value) : (pf.value || "");
        if (pf.blur) pf.blur();
        return this.setState({ [key]: val, pAll: false });
      }
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
    // colour per pitch type (shared by zone plot + feed Type column)
    pitchColor(type) {
      const map = { FF: "#e0392f", FA: "#e0392f", SI: "#e8863a", FT: "#e8863a", FC: "#d6a11e", SL: "#2f8fd6", ST: "#2f8fd6", CB: "#8a5cf0", CU: "#8a5cf0", KC: "#8a5cf0", CH: "#26a269", SP: "#12a594", FS: "#12a594" };
      return map[type] || (this.dk() ? "#8493aa" : "#7a879c");
    }
    // ── prediction grading → cell shading ────────────────────────────────
    // The verdict rides on the cell background instead of a ✓/✗ mark, so a
    // dense log reads at a glance and spends no width on notation.
    //   velo  · |called − actual| ≤1.0 green · ≤2.5 amber · beyond red
    //   class · right green · wrong red · ungraded (pending/unknowable) neutral
    //
    // The velo bands were ≤1.5 / ≤3.0 until the feed redesign. 1.5 mph is most
    // of a pitch type's spread, so the old green band scored calls as close
    // that a reader would not have called close.
    veloBand(delta) {
      if (delta == null || !isFinite(delta)) return null;
      const a = Math.abs(delta);
      return a <= 1 ? "good" : a <= 2.5 ? "amber" : "bad";
    }

    // ── click delegation ─────────────────────────────────────────────────
    _onClick(e) {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      const act = el.getAttribute("data-act");
      const arg = el.getAttribute("data-arg");
      switch (act) {
        case "view": {
          this.setState({ view: arg });
          // Each tab owns its own date, so arriving at one loads that date if
          // it is not already cached. Cached days are a no-op. Predictions
          // reads the slate and /projections only, never the pitch rows.
          if (arg === "live") this.syncDay(false, arg);
          return;
        }
        // ★ toggle anywhere on the board; arg is the pin key (g:pk / b:id).
        case "pin": return this.togglePin(arg);
        // A Watching pill's body. A pinned live game goes to its live view; a
        // game that is not live, or any batter, opens its Home pill.
        case "watchGo": {
          const w = this.resolvePin(arg);
          if (arg.startsWith("g:") && w.game && w.game.phase === "live") {
            this.setState({ view: "live", liveSel: String(w.game.gamePk) });
            this.syncDay(false, "live");
            return;
          }
          if (w.pk) this.openPill(w.pk, w.side);
          return;
        }
        // arg is "pk" or "pk|side" (side = away / home / starters).
        case "openPill": {
          const [pk, side] = String(arg).split("|");
          return this.openPill(pk, side || null);
        }
        // ── Data Feed ──
        case "dTf": return this.dSet({ dTf: arg === "today" ? "today" : Number(arg) });
        case "dMk": return this.dSet({ dMk: arg });
        case "dHand": return this.dSet({ dHand: arg });
        case "dSide": return this.dSet({ dSide: arg });
        case "dClear": return this.dClear();
        // The market table and team grid are filters too: click to set,
        // click the same row again to clear.
        case "dMkRow": return this.dSet({ dMk: this.state.dMk === arg ? "all" : arg });
        case "dTeamTile": return this.dSet({ dTeam: this.state.dTeam === arg ? "" : arg });
        case "dMore": { this.loadGraded(true); return; }
        // ── Predictions ──
        case "pMarket": return this.setState({ pMarket: arg, pAll: false });
        case "pStatus": return this.setState({ pStatus: arg, pAll: false });
        case "pConfOnly": return this.setState({ pConfOnly: !this.state.pConfOnly, pAll: false });
        // Same header flips direction; a new one starts from its natural order
        // (strongest first for numbers, A→Z and soonest first otherwise).
        case "pSort": {
          const same = this.state.pSort === arg;
          const dir = same ? -this.state.pDir : (arg === "name" || arg === "time" ? 1 : -1);
          return this.setState({ pSort: arg, pDir: dir });
        }
        case "pAll": return this.setState({ pAll: !this.state.pAll });
        case "pClear": { this.predClear(); return this.render(); }
        // A Predictions row: its Home pill, on the right side tab.
        case "predRow": {
          const [pk, side] = String(arg).split("|");
          return this.openPill(pk, side || null);
        }
        case "mode": return this.setState({ mode: arg === "live" || arg === "pregame" ? arg : null });
        case "goHome": return this.setState({ view: "home" });
        case "goLive": return this.setState({ view: "live" });
        case "liveSel": return this.setState({ liveSel: arg });
        // A decision card or pin about a live game: the Live tab on that game.
        case "liveGo": {
          this.setState({ view: "live", liveSel: String(arg) });
          this.syncDay(false, "live");
          return;
        }
        // Home pill: expand / collapse. Context is fetched on first expand
        // and cached, so re-opening costs nothing and the poll never asks.
        case "pillToggle": {
          const o = Object.assign({}, this.state.open);
          o[arg] = !o[arg];
          this.setState({ open: o });
          if (o[arg]) this.loadGameContext(arg);
          return;
        }
        // Phone: pick one item of a set (a chart bar, a view) — arg "key|value";
        // picking the selected value again clears it.
        case "mSel": {
          const i = String(arg).indexOf("|");
          const k = arg.slice(0, i), v = arg.slice(i + 1);
          return this.setState({ mOpen: Object.assign({}, this.state.mOpen, { [k]: this.state.mOpen[k] === v ? null : v }) });
        }
        // Phone card / filter panel: expand or collapse.
        case "mToggle":
          return this.setState({ mOpen: Object.assign({}, this.state.mOpen, { [arg]: !this.state.mOpen[arg] }) });
        // arg "pk|away" / "pk|home" / "pk|sp"
        case "pillTab": {
          const [pk, t] = String(arg).split("|");
          return this.setState({ tab: Object.assign({}, this.state.tab, { [pk]: t }) });
        }
        // arg "pk|lift" / "pk|order"
        case "pillSort": {
          const [pk, s] = String(arg).split("|");
          return this.setState({ psort: Object.assign({}, this.state.psort, { [pk]: s }) });
        }
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
        ? COPY.liveCount.replace("{n}", `<span class="ph-mono">${liveCount}</span>`)
          .replace("{s}", liveCount === 1 ? "" : "s")
        : esc(COPY.noLive);
      return `
      <header class="ph-header">
        <div class="ph-header-inner ph-shell">
          <div data-act="goHome" class="ph-brand">
            <span class="ph-brand-mark">◆</span>
            <span>Pitch<span class="ph-brand-hawk">Hawk</span></span>
          </div>
          <div class="ph-livecount">
            <span class="ph-dot${liveCount ? " is-live" : ""}"></span>
            <span>${liveText}</span>
          </div>
          <nav class="ph-nav">${tabs}</nav>
        </div>
      </header>`;
    }
    footerHtml() {
      return `
      <footer class="ph-footer">
        <div class="ph-footer-inner">
          <div data-act="goHome" class="ph-footer-brand"><span>◆</span> Pitch<span>Hawk</span></div>
          <p class="ph-footer-note">${esc(COPY.footerDisclaimer)}</p>
        </div>
      </footer>`;
    }

    // ══ SHELL (2026-09 redesign) ═════════════════════════════════════════
    // ── clocks ───────────────────────────────────────────────────────────
    clockSec(ts) {
      return ts == null ? null
        : new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: ET });
    }

    // Escaped text with every run of digits set in the data face, for mixed
    // strings like "BOS @ NYY · 3–2" or "O 8.5". Every number a reader
    // compares is Plex Mono, including the ones inside a sentence.
    numHtml(s) {
      // Match on the RAW text and escape each piece. Escaping first turned an
      // apostrophe into "&#39;", whose "39" was then wrapped as a number,
      // breaking the entity ("the starter&#39;s" on screen).
      // A unit glued to the number ("7D", "30d") stays with it.
      const str = String(s == null ? "" : s);
      const re = /\d[\d:.,–\-%]*(?:[A-Za-z]{1,2}\b)?(?:\s?[AP]M)?/g;
      let out = "", last = 0, m;
      while ((m = re.exec(str))) {
        out += esc(str.slice(last, m.index)) + `<span class="ph-mono">${esc(m[0])}</span>`;
        last = m.index + m[0].length;
      }
      return out + esc(str.slice(last));
    }

    // ── missing values ───────────────────────────────────────────────────
    // A value the product does not have renders as a dash with the reason
    // beside it — never 0, never a guess. One primitive so every tab says it
    // the same way.
    MISSING = {
      notserved: "Not served", notmodeled: "Not modeled", needsroute: "Needs route",
    };
    tagHtml(kind) {
      const label = this.MISSING[kind];
      return label ? `<span class="ph-tag ph-tag--${kind}">${esc(label)}</span>` : "";
    }
    missingHtml(kind) {
      return `<span class="ph-missing"><span class="ph-missing-dash">—</span>${this.tagHtml(kind)}</span>`;
    }

    // ── freshness flash ──────────────────────────────────────────────────
    // `ph-flash` for exactly one render after `stamp` changes under `key`.
    // The first sighting does not flash: that is a load, not an update.
    flashIf(key, stamp) {
      if (stamp == null) return "";
      const prev = this._seen[key];
      if (prev === stamp) return "";
      this._seen[key] = stamp;
      return prev === undefined ? "" : "ph-flash";
    }

    // ── mode ─────────────────────────────────────────────────────────────
    effectiveMode() {
      return this.state.mode || (this.liveGames().length ? "live" : "pregame");
    }

    // ── pins ─────────────────────────────────────────────────────────────
    // Storage can throw (private windows, blocked site data) or hold junk;
    // either way the board starts with no pins rather than failing to boot.
    loadPins() {
      try {
        const p = JSON.parse(window.localStorage.getItem(PINS_KEY) || "[]");
        return Array.isArray(p) ? p.filter((k) => /^[gb]:\S+$/.test(k)) : [];
      } catch (_e) { return []; }
    }
    savePins(pins) {
      try { window.localStorage.setItem(PINS_KEY, JSON.stringify(pins)); } catch (_e) { /* session only */ }
      this.setState({ pins });
    }
    togglePin(key) {
      if (!key || !/^[gb]:\S+$/.test(key)) return;
      const pins = this.state.pins.slice();
      const i = pins.indexOf(key);
      if (i >= 0) pins.splice(i, 1); else pins.push(key);
      this.savePins(pins);
    }
    isPinned(key) { return this.state.pins.indexOf(key) >= 0; }

    // What a pin points at on today's board: the game, the Home pill to open,
    // and for a batter the side tab his row sits under. Either may be absent.
    resolvePin(key) {
      const id = key.slice(2);
      const games = PH.games || [];
      if (key.startsWith("g:")) {
        const game = games.find((g) => String(g.gamePk) === id) || null;
        return { game, pk: game ? String(game.gamePk) : null, side: null };
      }
      const rows = (this.state.proj.rows || []).filter((r) => String(r.player_id) === id);
      if (!rows.length) return { game: null, pk: null, side: null, rows };
      const pk = String(rows[0].game_pk);
      const game = games.find((g) => String(g.gamePk) === pk) || null;
      return { game, pk, side: rows[0].is_home ? "home" : "away", rows };
    }

    // ── ★ WATCHING row ───────────────────────────────────────────────────
    watchRowHtml() {
      const pins = this.state.pins;
      if (!pins.length) return "";
      const pills = pins.map((key) => {
        const w = this.resolvePin(key);
        let label, sub;
        if (key.startsWith("g:")) {
          const g = w.game;
          if (g) {
            const wp = this.gameWp(g);
            const wpTxt = wp.val === "—" ? "—" : `${esc(wp.team)} ${esc(wp.val)}`;
            const dTxt = wp.delta == null || wp.delta === 0 ? ""
              : ` ${wp.delta > 0 ? "▲" : "▼"}${Math.abs(wp.delta)}`;
            label = `${esc(g.away)} @ ${esc(g.home)}`;
            sub = g.phase === "pregame"
              ? `${esc(this.clockOf(g.startTs) || "TBD")} · ${wpTxt}`
              : `${esc(g.score.away)}–${esc(g.score.home)} · ${wpTxt}${dTxt}`;
          }
        } else if (w.rows && w.rows.length) {
          // The batter's stronger read, relative to the league rate at his
          // own xPA — the same ranking the pill's "strongest read" uses.
          const b = (this.batters() || []).find((x) => x.id === key.slice(2) && x.pk === w.pk);
          const hit = b && this.probCell(b, "hit"), hr = b && this.probCell(b, "hr");
          const m = hr && hr.rel != null && (!hit || hit.rel == null || hr.rel > hit.rel) ? "hr" : "hit";
          const c = m === "hr" ? hr : hit;
          label = esc(this.shortName(w.rows[0].player));
          sub = c && c.p != null
            ? `${m === "hr" ? "1+ HR" : "1+ Hit"} ${this.pct(c.p)}${c.lift ? ` ${c.lift}` : ""}`
            : "—";
        }
        const known = label != null;
        return `<span class="ph-watch-pill">
          <button class="ph-watch-go" ${known ? `data-act="watchGo" data-arg="${esc(key)}"` : "disabled"}>
            <b>${known ? label : esc(key.startsWith("g:") ? "Game " + key.slice(2) : "Batter " + key.slice(2))}</b>
            <span class="ph-mono ph-watch-sub">${known ? sub : esc(COPY.watchUnresolved)}</span>
          </button>
          <button class="ph-watch-unpin" data-act="pin" data-arg="${esc(key)}" title="${esc(COPY.watchUnpin)}" aria-label="${esc(COPY.watchUnpin)}">★</button>
        </span>`;
      }).join("");
      return `<div class="ph-watch"><span class="ph-kicker">${esc(COPY.watchingLabel)}</span>${pills}</div>`;
    }

    // ── API unreachable ──────────────────────────────────────────────────
    apiBannerHtml() {
      const api = this.state.api;
      if (!api.down) return "";
      const when = api.lastGood
        ? `${esc(COPY.apiDownLastGood)} <span class="ph-mono">${esc(this.clockSec(api.lastGood))}</span>`
        : esc(COPY.apiDownNever);
      return `<div class="ph-banner-err" role="alert">
        <span class="ph-kicker">${esc(COPY.apiDownTitle)}</span>
        <span class="ph-banner-err-body">${esc(COPY.apiDownBody)}</span>
        <span class="ph-banner-err-when">${when}</span>
      </div>`;
    }

    // ── Home pill navigation ─────────────────────────────────────────────
    // Opening a pill from anywhere (a card, a Predictions row, a Watching
    // pill) lands on Home with that pill expanded on the right side tab.
    openPill(pk, side) {
      pk = String(pk);
      const patch = {
        view: "home",
        open: Object.assign({}, this.state.open, { [pk]: true }),
      };
      if (side) patch.tab = Object.assign({}, this.state.tab, { [pk]: side });
      this.setState(patch);
      this.scrollToPill(pk);
    }

    // ── Predictions (phase 3) ────────────────────────────────────────────
    // Every probability on today's slate in one table, switchable by market.
    // Filters live in state (p*), never in the DOM, so they survive the poll.
    PRED_MARKETS = [["hit", "1+ Hit"], ["hr", "1+ HR"], ["wp", "Win prob"], ["tot", "Totals"], ["sp", "Starters"]];
    PRED_DEFAULTS = { pMarket: "hit", pTeam: "", pStatus: "all", pConfOnly: false, pMin: -10, pSort: "lift", pDir: -1, pAll: false };
    PRED_PAGE = 25;

    predHtml() {
      this.loadTrust();
      const mk = this.state.pMarket;
      let table, count;
      if (mk === "hit" || mk === "hr") {
        const rows = this.predBatterRows();
        count = rows.length;
        table = count ? this.predBatterTableHtml(rows, mk) : "";
      } else if (mk === "sp") {
        const rows = this.predStarterRows();
        count = rows.length;
        table = count ? this.predStarterTableHtml(rows) : "";
      } else {
        const rows = this.predGameRows();
        count = rows.length;
        table = count ? this.predGameTableHtml(rows) : "";
      }
      const live = this.effectiveMode() === "live";
      const sub = mk === "hit" || mk === "hr" ? (live ? COPY.predSubBatLive : COPY.predSubBatPre)
        : mk === "sp" ? COPY.predSubSp
          : live && mk === "wp" ? COPY.predSubWpLive : COPY.predSubGame;
      return `<div class="ph-titlerow">
          <h1 class="ph-h1">${esc(COPY.predTitle)}</h1>
          <span class="ph-strip-sub">${esc(SLATE_IS_TODAY ? COPY.predSub : COPY.predSubNext)}</span>
        </div>
        ${this.predFilterBarHtml(count)}
        ${this.trustTilesHtml()}
        <div class="ph-strip-head">
          <span class="ph-table-title">${esc(COPY.predTableTitle[mk])}</span>
          <span class="ph-strip-sub">${esc(sub)}</span>
        </div>
        ${count ? table : this.predEmptyHtml()}`;
    }

    // ── filters ──────────────────────────────────────────────────────────
    predClear() {
      // Mode is shared with Home and is not a filter; the market is what the
      // page is about. Everything else goes back to its default.
      const d = this.PRED_DEFAULTS;
      Object.assign(this.state, {
        pTeam: d.pTeam, pStatus: d.pStatus, pConfOnly: d.pConfOnly, pMin: d.pMin, pAll: false,
      });
    }
    predStatusOk(g) {
      const s = this.state.pStatus;
      return s === "all" || (s === "upcoming" ? g.phase === "pregame" : g.phase === s);
    }
    predTeamOk(...teams) { return !this.state.pTeam || teams.includes(this.state.pTeam); }
    predFilterBarHtml(count) {
      const s = this.state;
      const anyLive = this.todayGames().some((g) => g.phase === "live");
      const teams = [...new Set(this.todayGames().flatMap((g) => [g.away, g.home]))].sort();
      const chip = (act, k, label, on) =>
        `<button class="ph-chip${on ? " is-on" : ""}" data-act="${act}" data-arg="${esc(k)}">${esc(label)}</button>`;
      const minLabel = s.pMin <= -10 ? "any" : `${s.pMin >= 0 ? "+" : "−"}${Math.abs(s.pMin)} pts`;
      const batter = s.pMarket === "hit" || s.pMarket === "hr";
      const teamSel = `<select class="ph-select" data-pfilter="pTeam" aria-label="Team">
          <option value="">All teams</option>
          ${teams.map((t) => `<option value="${esc(t)}"${s.pTeam === t ? " selected" : ""}>${esc(t)}</option>`).join("")}
        </select>`;
      const statusChips = `<span class="ph-fgroup">${[["all", "All"], ["live", "Live"], ["upcoming", "Upcoming"], ["final", "Final"]].map(([k, l]) => chip("pStatus", k, l, s.pStatus === k)).join("")}</span>`;
      const batterCtl = batter ? `${chip("pConfOnly", "1", `${s.pConfOnly ? "✓ " : ""}Lineup confirmed only`, s.pConfOnly)}
        <label class="ph-range">MIN LIFT
          <input type="range" min="-10" max="15" step="1" value="${s.pMin}" data-pfilter="pMin" aria-label="Minimum lift in points">
          <span class="ph-mono ph-range-val">${esc(minLabel)}</span>
        </label>` : "";
      const countHtml = `<span class="ph-mono ph-fbar-count"><b>${count}</b> result${count === 1 ? "" : "s"}</span>`;
      // Phone: mode and market always in view; the rest behind "Filters".
      if (this.mob()) {
        const open = !!s.mOpen["f:pred"];
        const n = (s.pTeam ? 1 : 0) + (s.pStatus !== "all" ? 1 : 0)
          + (batter && s.pConfOnly ? 1 : 0) + (batter && s.pMin > -10 ? 1 : 0);
        return `<div class="ph-fbar">
          <div class="ph-fbar-line">
            ${this.segHtml("mode", this.effectiveMode(), [["pregame", "Pregame"], ["live", "Live"]], anyLive)}
            <button class="ph-chip${n ? " is-on" : ""}" data-act="mToggle" data-arg="f:pred" aria-expanded="${open}">Filters${n ? ` <span class="ph-mono">${n}</span>` : ""} ${open ? "▴" : "▾"}</button>
            ${countHtml}
          </div>
          <div class="ph-fscroll">${this.PRED_MARKETS.map(([k, l]) => chip("pMarket", k, l, s.pMarket === k)).join("")}</div>
          ${open ? `<div class="ph-fbar-line ph-fbar-more">${teamSel}${statusChips}${batterCtl}<button class="ph-link" data-act="pClear">Clear</button></div>` : ""}
        </div>`;
      }
      return `<div class="ph-fbar">
        ${this.segHtml("mode", this.effectiveMode(), [["pregame", "Pregame"], ["live", "Live"]], anyLive)}
        <span class="ph-vrule"></span>
        <span class="ph-fgroup">${this.PRED_MARKETS.map(([k, l]) => chip("pMarket", k, l, s.pMarket === k)).join("")}</span>
        <span class="ph-vrule"></span>
        ${teamSel}
        ${statusChips}
        ${batterCtl}
        <button class="ph-link" data-act="pClear">Clear</button>
        ${countHtml}
      </div>`;
    }

    // ── rows ─────────────────────────────────────────────────────────────
    predBatterRows() {
      const s = this.state, m = s.pMarket;
      const rows = (this.batters() || []).map((b) => ({ b, g: this.gameByPk(b.pk), c: this.probCell(b, m) }))
        .filter((r) => r.g && r.c.p != null
          && this.predStatusOk(r.g)
          && this.predTeamOk(this.teamOf(r.b))
          && (!s.pConfOnly || r.b.slot)
          && (s.pMin <= -10 || (r.c.pts != null && r.c.pts >= s.pMin)));
      const key = {
        lift: (r) => (r.c.pts == null ? -Infinity : r.c.pts),
        prob: (r) => r.c.p,
        time: (r) => Date.parse(r.g.startTs || 0) || 0,
      }[s.pSort];
      rows.sort((a, z) => s.pSort === "name"
        ? String(a.b.name || "").localeCompare(String(z.b.name || "")) * s.pDir
        : (key(a) - key(z)) * s.pDir);
      // Live mode: in-progress games first, the chosen sort within each half.
      if (this.effectiveMode() === "live") {
        rows.sort((a, z) => (z.g.phase === "live") - (a.g.phase === "live"));
      }
      return rows;
    }
    predGameRows() {
      const pre = (g) => this.gameWp(Object.assign({}, g, { phase: "pregame" }));
      const rows = this.todayGames().filter((g) => this.predStatusOk(g) && this.predTeamOk(g.away, g.home))
        .map((g) => ({ g, w: this.gameWp(g), pw: pre(g), t: this.gameTotal(g) }));
      const strength = (r) => (r.pw.prob == null ? -1 : r.pw.prob);
      if (this.state.pMarket === "tot") {
        rows.sort((a, z) => (z.t.proj == null ? -1 : z.t.proj) - (a.t.proj == null ? -1 : a.t.proj));
      } else if (this.effectiveMode() === "live") {
        rows.sort((a, z) => z.w.swing - a.w.swing || strength(z) - strength(a));
      } else {
        rows.sort((a, z) => strength(z) - strength(a));
      }
      return rows;
    }
    predStarterRows() {
      const rows = [];
      this.todayGames().filter((g) => this.predStatusOk(g)).forEach((g) => {
        [["away", g.probables.away, g.probables.awayId, g.away, g.home],
          ["home", g.probables.home, g.probables.homeId, g.home, g.away]].forEach(([side, name, id, team, opp]) => {
          if (!name || !this.predTeamOk(team)) return;
          rows.push({ g, side, name, id, team, opp, k: this.starterStats(id).k });
        });
      });
      return rows.sort((a, z) => (z.k == null ? -1 : z.k) - (a.k == null ? -1 : a.k));
    }

    // A finished game's grade for the win-prob and total reads. Live games
    // are pending — never a miss — and a game not yet started has no grade.
    gameResult(g, market) {
      if (g.phase === "pregame") return { r: null, pending: false };
      if (g.phase === "live") return { r: null, pending: true };
      const a = Number(g.score.away), h = Number(g.score.home);
      if (!isFinite(a) || !isFinite(h)) return { r: null, pending: false };
      if (market === "wp") {
        const pw = this.gameWp(Object.assign({}, g, { phase: "pregame" }));
        if (pw.prob == null || a === h) return { r: null, pending: false };
        return { r: pw.team === (h > a ? g.home : g.away) ? "hit" : "miss" };
      }
      const pre = g.mPre && g.mPre.game_total && g.mPre.game_total.covered ? g.mPre.game_total : g.m && g.m.game_total;
      const rec = pre && pre.recommendation, line = pre && pre.line != null ? Number(pre.line) : null;
      if (!rec || line == null || a + h === line) return { r: null, pending: false };  // push: not graded
      return { r: (a + h > line) === (rec === "over") ? "hit" : "miss" };
    }
    gameResultChipHtml(res) {
      if (res.pending) return `<span class="ph-res ph-res--pending">pending</span>`;
      if (res.r === "hit") return `<span class="ph-res ph-res--good">HIT</span>`;
      if (res.r === "miss") return `<span class="ph-res ph-res--bad">MISS</span>`;
      return `<span class="ph-missing-dash">—</span>`;
    }

    // ── tables ───────────────────────────────────────────────────────────
    sortHeadHtml(key, label) {
      const s = this.state, on = s.pSort === key;
      return `<button class="ph-sorth${on ? " is-on" : ""}" data-act="pSort" data-arg="${key}">${esc(label)}${on ? ` ${s.pDir < 0 ? "▼" : "▲"}` : ""}</button>`;
    }
    predBatterTableHtml(all, m) {
      const s = this.state;
      const rows = s.pAll ? all : all.slice(0, this.PRED_PAGE);
      const ph = (g) => g.phase === "live" ? ["pre", "PREGAME · GAME LIVE"] : g.phase === "final" ? ["final", "FINAL"] : ["pre", "PREGAME"];
      const when = (g) => g.phase === "pregame" ? this.clockOf(g.startTs) || "TBD"
        : g.phase === "live" ? `${g.half}${g.inning == null ? "" : g.inning}` : "F";
      const more = all.length > this.PRED_PAGE
        ? `<button class="ph-more" data-act="pAll">${s.pAll ? "Show top 25" : `Show all <span class="ph-mono">${all.length}</span> ▾`}</button>` : "";
      if (this.mob()) {
        const cards = rows.map((r, i) => {
          const { b, g, c } = r;
          const w = this.whyLines(b, m);
          const [pk, pt] = ph(g);
          const live = g.phase === "live" ? this.rogOf(g, b.id) : null;
          const rogP = live ? live[m] : null;
          const rec = b[m];
          return this.mCardHtml({
            key: `pr:${m}:${b.key}`,
            head: `<span class="ph-mono ph-dim ph-mcard-slot">${i + 1}</span>
              ${this.pinBtnHtml("b:" + b.id, "Watch this batter")}
              <button class="ph-rowlink" data-act="predRow" data-arg="${esc(b.pk)}|${b.side}">
                <span class="ph-rowlink-top"><b class="ph-ellip">${esc(b.name || "—")}</b><span class="ph-mono">${esc(this.teamOf(b))} · #${b.slot || "—"}</span></span>
                <span class="ph-ellip">${this.numHtml(`vs ${b.spName || "TBD"} · ${g.away} @ ${g.home} ${when(g)}`)}</span>
              </button>
              ${this.resultChipHtml(rec ? rec.result : null, g)}`,
            stats: `${this.mPairHtml(m === "hit" ? "P(1+ HIT)" : "P(1+ HR)", this.probCellHtml(b, m, true))}
              ${this.mPairHtml("LIFT", `<span class="ph-stack"><span class="ph-mono ph-lift ph-lift--${c.band || "avg"}">${esc(c.lift || "—")}</span><span class="ph-mono ph-small ph-mut">${c.rel == null ? "" : `${c.rel.toFixed(2)}× league`}</span></span>`)}`,
            more: `${this.mPairHtml("PHASE", this.phaseChip(pk, pt))}
              ${this.mPairHtml("LINEUP", `<span class="ph-status ph-status--${b.slot ? "solid" : "dashed"} ph-status--left">${b.slot ? "LINEUP ✓" : "LINEUP PENDING"}</span>`)}
              ${this.mPairHtml("REST OF GAME", rogP != null ? this.baseCellHtml(this.pct(rogP), `${Number(live.remaining_pa).toFixed(1)} PA left`) : `<span class="ph-missing-dash">—</span>`)}
              ${this.mPairHtml("FRESH", `<span class="ph-mono ph-small">${esc(g.phase === "final" ? "graded" : `updated ${this.clockOf(b.updatedAt) || "—"}`)}</span>`)}
              <span class="ph-meta ph-mcard-wide"><span class="ph-meta-k">WHY</span><span class="ph-card-why ph-mono"><span>${w[0]}</span><span class="ph-card-why2">${w[1]}</span></span></span>`,
          });
        }).join("");
        const sorts = [["lift", "Lift"], ["prob", "Prob"], ["time", "Time"], ["name", "Name"]]
          .map(([k, l]) => this.sortHeadHtml(k, l)).join("");
        return `<div class="ph-msort"><span class="ph-kicker ph-kicker--mut">Sort</span>${sorts}</div>
          <div class="ph-mlist">${cards}${more}</div>`;
      }
      const body = rows.map((r, i) => {
        const { b, g, c } = r;
        const w = this.whyLines(b, m);
        const [pk, pt] = ph(g);
        const fresh = g.phase === "final" ? "graded" : `updated ${this.clockOf(b.updatedAt) || "—"}`;
        const live = g.phase === "live" ? this.rogOf(g, b.id) : null;
        const rogP = live ? live[m] : null;
        const rog = rogP != null
          ? this.baseCellHtml(this.pct(rogP), `${Number(live.remaining_pa).toFixed(1)} PA left`)
          : `<span class="ph-missing-dash">—</span>`;
        const rec = b[m];
        return `<div class="ph-ptable-row ph-ptable-bat">
          <span class="ph-mono ph-dim">${i + 1}</span>
          ${this.pinBtnHtml("b:" + b.id, "Watch this batter")}
          <button class="ph-rowlink" data-act="predRow" data-arg="${esc(b.pk)}|${b.side}">
            <span class="ph-rowlink-top"><b class="ph-ellip">${esc(b.name || "—")}</b><span class="ph-mono">${esc(this.teamOf(b))} · #${b.slot || "—"}</span></span>
            <span class="ph-ellip">${this.numHtml(`vs ${b.spName || "TBD"} · ${g.away} @ ${g.home} ${when(g)}`)}</span>
          </button>
          <span class="ph-stack">
            ${this.phaseChip(pk, pt)}
            <span class="ph-mono ph-card-fresh ph-small ${this.flashIf(`pred:${b.key}`, b.updatedAt)}">${esc(fresh)}</span>
          </span>
          <span class="ph-status ph-status--${b.slot ? "solid" : "dashed"} ph-status--left">${b.slot ? "LINEUP ✓" : "LINEUP PENDING"}</span>
          ${this.probCellHtml(b, m, true)}
          <span class="ph-stack">
            <span class="ph-mono ph-lift ph-lift--${c.band || "avg"}">${esc(c.lift || "—")}</span>
            <span class="ph-mono ph-small ph-mut">${c.rel == null ? "" : `${c.rel.toFixed(2)}×`}</span>
          </span>
          <span class="ph-card-why ph-mono"><span>${w[0]}</span><span class="ph-card-why2">${w[1]}</span></span>
          ${rog}
          ${this.resultChipHtml(rec ? rec.result : null, g)}
        </div>`;
      }).join("");
      return `<div class="ph-ptable">
        <div class="ph-ptable-row ph-ptable-bat ph-ptable-head">
          <span>#</span><span></span>
          ${this.sortHeadHtml("name", "PLAYER · TEAM · SLOT")}
          ${this.sortHeadHtml("time", "PHASE · FRESH")}
          <span>LINEUP</span>
          ${this.sortHeadHtml("prob", m === "hit" ? "P(1+ HIT)" : "P(1+ HR)")}
          ${this.sortHeadHtml("lift", "LIFT")}
          <span>WHY</span><span>REST OF GAME</span><span>RESULT</span>
        </div>
        ${body}${more}
      </div>`;
    }
    predGameTableHtml(rows) {
      if (this.mob()) {
        return `<div class="ph-mlist">${rows.map(({ g, w, pw, t }) => {
          const pk = String(g.gamePk);
          const score = g.phase === "pregame" ? "" : `${g.score.away}–${g.score.home}`;
          const now = g.phase === "pregame" ? "—" : `${w.team} ${w.val}`;
          const cap = g.phase === "pregame" ? ["is-pre", "PREGAME · log5_v1"]
            : g.phase === "live" ? ["is-live", "● LIVE · mlb_winprob_v1"] : ["", "AT FINAL"];
          return this.mCardHtml({
            key: `pg:${pk}`,
            head: `${this.pinBtnHtml("g:" + pk, "Watch this game")}
              ${this.slateChipHtml(g, true)}
              <button class="ph-rowlink" data-act="predRow" data-arg="${esc(pk)}">
                <span class="ph-rowlink-top"><b>${esc(g.away)} @ ${esc(g.home)}</b><span class="ph-mono ph-rowlink-score">${esc(score)}</span></span>
              </button>`,
            stats: `${this.mPairHtml("WIN PROB · PREGAME → NOW", `<span class="ph-stack"><span class="ph-gpill-line ph-mono">
                  <span class="ph-dim">${pw.prob == null ? "—" : esc(`${pw.team} ${pw.val}`)}</span><span class="ph-mut">→</span>
                  <b class="ph-gpill-num">${esc(now)}</b>${this.deltaHtml(w.delta)}</span><span class="ph-cap ${cap[0]}">${cap[1]}</span></span>`)}
              ${this.mPairHtml("TOTAL · PREGAME", `<span class="ph-gpill-line"><b>${this.numHtml(t.pick)}</b><span class="ph-mono ph-gpill-num is-dim">${this.pct(t.prob)}</span></span>`)}`,
            more: `${this.mPairHtml("STARTERS", `<span class="ph-meta-v">${esc(this.startersLine(g))}</span>`)}
              ${this.mPairHtml("PROJ RUNS", `<span class="ph-mono">${t.proj == null ? "—" : t.proj.toFixed(1)}</span>`)}
              ${this.mPairHtml("LIVE TOTAL", g.liveModels && g.liveModels.total
                ? this.baseCellHtml(Number(g.liveModels.total.projected).toFixed(1), `O ${g.liveModels.total.line} · ${this.pct(g.liveModels.total.p_over)}`)
                : `<span class="ph-missing-dash">—</span>`)}
              ${this.mPairHtml("RESULT", `<span class="ph-res2">
                <span><span class="ph-res-k ph-res-k--w">WP</span>${this.gameResultChipHtml(this.gameResult(g, "wp"))}</span>
                <span><span class="ph-res-k ph-res-k--w">TOT</span>${this.gameResultChipHtml(this.gameResult(g, "tot"))}</span></span>`)}
              ${this.mPairHtml("WIN-PROB SPARKLINE", this.tagHtml("needsroute"))}`,
          });
        }).join("")}</div>`;
      }
      const body = rows.map(({ g, w, pw, t }) => {
        const pk = String(g.gamePk);
        const score = g.phase === "pregame" ? "" : `${g.score.away}–${g.score.home}`;
        const now = g.phase === "pregame" ? "—" : g.phase === "final" ? `${w.team} ${w.val}` : `${w.team} ${w.val}`;
        const cap = g.phase === "pregame" ? ["is-pre", "PREGAME · log5_v1"]
          : g.phase === "live" ? ["is-live", "● LIVE · mlb_winprob_v1"] : ["", "AT FINAL"];
        return `<div class="ph-ptable-row ph-ptable-game">
          ${this.pinBtnHtml("g:" + pk, "Watch this game")}
          ${this.slateChipHtml(g, false)}
          <button class="ph-rowlink" data-act="predRow" data-arg="${esc(pk)}">
            <span class="ph-rowlink-top"><b>${esc(g.away)} @ ${esc(g.home)}</b><span class="ph-mono ph-rowlink-score">${esc(score)}</span></span>
            <span class="ph-ellip">${esc(this.startersLine(g))}</span>
          </button>
          <span class="ph-stack">
            <span class="ph-gpill-line ph-mono">
              <span class="ph-dim">${pw.prob == null ? "—" : esc(`${pw.team} ${pw.val}`)}</span><span class="ph-mut">→</span>
              <b class="ph-gpill-num">${esc(now)}</b>${this.deltaHtml(w.delta)}
            </span>
            <span class="ph-cap ${cap[0]}">${cap[1]}</span>
          </span>
          <span class="ph-mono">${t.proj == null ? "—" : t.proj.toFixed(1)}</span>
          <span class="ph-gpill-line"><b>${this.numHtml(t.pick)}</b><span class="ph-mono ph-gpill-num is-dim">${this.pct(t.prob)}</span></span>
          ${g.liveModels && g.liveModels.total
            ? this.baseCellHtml(Number(g.liveModels.total.projected).toFixed(1),
              `O ${g.liveModels.total.line} · ${this.pct(g.liveModels.total.p_over)}`)
            : `<span class="ph-missing-dash">—</span>`}
          <span class="ph-res2">
            <span><span class="ph-res-k ph-res-k--w">WP</span>${this.gameResultChipHtml(this.gameResult(g, "wp"))}</span>
            <span><span class="ph-res-k ph-res-k--w">TOT</span>${this.gameResultChipHtml(this.gameResult(g, "tot"))}</span>
          </span>
        </div>`;
      }).join("");
      return `<div class="ph-ptable">
        <div class="ph-ptable-row ph-ptable-game ph-ptable-head">
          <span></span><span>STATUS</span><span>MATCHUP · STARTERS</span>
          <span class="ph-headtag">WIN PROB · PREGAME → NOW ${this.tagHtml("needsroute")}<span class="ph-mut">sparkline</span></span>
          <span>PROJ RUNS</span><span>TOTAL · PREGAME</span><span>LIVE TOTAL</span><span>RESULT</span>
        </div>
        ${body}
      </div>`;
    }
    predStarterTableHtml(rows) {
      if (this.mob()) {
        return `<div class="ph-mlist">${rows.map((r) => this.starterCardHtml(`pp:${r.g.gamePk}:${r.side}`,
          `<button class="ph-rowlink" data-act="predRow" data-arg="${esc(String(r.g.gamePk))}|sp">
            <span class="ph-spname"><span class="ph-sp-tag">SP</span><b class="ph-ellip">${esc(r.name)}</b></span>
            <span class="ph-ellip">${this.numHtml(`${r.team} vs ${r.opp} · ${this.clockOf(r.g.startTs) || "TBD"}`)}</span>
          </button>`, r.id, r.g.gamePk, this.slateChipHtml(r.g, true))).join("")}
          <div class="ph-btable-foot"><span>${this.numHtml(COPY.startersNote)}</span></div>
        </div>`;
      }
      const body = rows.map((r) => `<div class="ph-ptable-row ph-ptable-sp">
          <button class="ph-rowlink" data-act="predRow" data-arg="${esc(String(r.g.gamePk))}|sp">
            <span class="ph-spname"><span class="ph-sp-tag">SP</span><b class="ph-ellip">${esc(r.name)}</b></span>
            <span class="ph-ellip">${this.numHtml(`${r.team} vs ${r.opp} · ${this.clockOf(r.g.startTs) || "TBD"}`)}</span>
          </button>
          ${this.slateChipHtml(r.g, false)}
          ${this.starterCellsHtml(r.id, r.g.gamePk)}
        </div>`).join("");
      const hd = ["STARTER · MATCHUP", "STATUS", "STRIKEOUTS", "OUTS REC.", "HITS ALLOWED", "EARNED RUNS", "WALKS", "30D K%", "WHIFF", "HR/PA", "FB VELO", "FATIGUE"];
      return `<div class="ph-ptable">
        <div class="ph-ptable-row ph-ptable-sp ph-ptable-head">${hd.map((h) => `<span>${h}</span>`).join("")}</div>
        ${body}
        <div class="ph-btable-foot ph-ptable-foot"><span>${this.numHtml(COPY.startersNote)}</span></div>
      </div>`;
    }
    // Probables are only on the payload before first pitch; after that the
    // honest answer is a dash, not "TBD".
    startersLine(g) {
      const none = g.phase === "pregame" ? "TBD" : "—";
      if (!g.probables.away && !g.probables.home && none === "—") return "starters —";
      return `${g.probables.away || none} vs ${g.probables.home || none}`;
    }
    predEmptyHtml() {
      const has = this.todayGames().length > 0;
      return `<div class="ph-empty ph-empty--dash">
        <b>${esc(has ? COPY.predEmptyTitle : (SLATE_IS_TODAY ? COPY.predNoneTitle : COPY.predNoneTitleNext))}</b>
        <span>${esc(has ? COPY.predEmptyBody : COPY.predNoneBody)}</span>
        ${has ? `<button class="ph-chip is-on" data-act="pClear">Clear filters</button>` : ""}
      </div>`;
    }

    // ── trust tiles ──────────────────────────────────────────────────────
    // How the model has done lately, so a reader can weigh the table below.
    // Seven days, America/New_York dates. Voids and pushes are out of every
    // denominator; an ungraded read is not evidence either way.
    TRUST_DAYS = 7;
    TRUST_TTL_MS = 300000;
    async loadTrust(force) {
      if (!force && this._trustAt && Date.now() - this._trustAt < this.TRUST_TTL_MS) return;
      this._trustAt = Date.now();
      const to = PH.mlbDate(0), from = PH.mlbDate(-(this.TRUST_DAYS - 1));
      const dates = [];
      for (let i = this.TRUST_DAYS - 1; i >= 0; i -= 1) dates.push(PH.mlbDate(-i));
      const [projDays, feed] = await Promise.all([
        Promise.all(dates.map((d) => fetchJson(`/projections?date=${d}`))),
        PH.loadFeed(API_BASE, { from, to, market: "game_moneyline", phase: "pregame", limit: 1000 }).catch(() => null),
      ]);
      // Calibration, per market: the same sums as projection_calibration().
      const calib = { batter_hit: null, batter_hr: null };
      let served = null, failed = false;
      projDays.forEach((res) => {
        if (!res) { failed = true; return; }
        (res.rows || []).forEach((r) => {
          if (served === null) served = Object.prototype.hasOwnProperty.call(r, "result");
          const c = calib[r.market] || (calib[r.market] = { n: 0, sumP: 0, hits: 0, voids: 0, version: null });
          if (r.model_version) c.version = r.model_version;
          if (r.result === "void") { c.voids += 1; return; }
          if (r.result !== "hit" && r.result !== "miss") return;
          c.n += 1; c.sumP += Number(r.probability); if (r.result === "hit") c.hits += 1;
        });
      });
      let wp = null;
      if (feed) {
        wp = { w: 0, l: 0 };
        (feed.games || []).forEach((r) => {
          if (r.result === "win") wp.w += 1; else if (r.result === "loss") wp.l += 1;
        });
      }
      this.setState({ trust: { from, to, calib, served, failed, wp, loaded: true } });
    }
    // At-bat calls and velo error, from the accuracy rollup already held for
    // the Data Feed — no second request.
    trustRollup(market) {
      const t = this.state.trust;
      const acc = this.state.accuracy;
      if (!acc.loaded || !t) return null;
      let w = 0, l = 0, mae = 0, maeN = 0, served = false;
      const versions = new Set();
      (acc.days || []).filter((d) => d.market === market && d.day >= t.from && d.day <= t.to).forEach((d) => {
        w += d.wins || 0; l += d.losses || 0;
        (d.versions || []).forEach((v) => versions.add(v));
        if (Object.prototype.hasOwnProperty.call(d, "mean_abs_error")) served = true;
        if (d.mean_abs_error != null && d.mae_n) { mae += d.mean_abs_error * d.mae_n; maeN += d.mae_n; }
      });
      return { w, l, mae: maeN ? mae / maeN : null, maeServed: served, versions: [...versions] };
    }
    trustTilesHtml() {
      const t = this.state.trust;
      const tile = (label, valHtml, sub, tone) => `<div class="ph-kpi">
          <span class="ph-kpi-k">${esc(label)}</span>
          <b class="ph-mono ph-kpi-v ${tone ? `ph-tone-${tone}` : ""}">${valHtml}</b>
          <span class="ph-kpi-sub">${sub}</span>
        </div>`;
      const acc = (w, l) => this.accBand(w + l ? w / (w + l) : null);
      const calTile = (label, key) => {
        if (!t) return tile(label, "—", "loading…");
        if (t.served === false) return tile(label, this.missingHtml("notserved"), "graded result not in /projections yet");
        const c = t.calib[key];
        if (!c || !c.n) return tile(label, "—", this.numHtml(`0 graded · ${key}${c && c.version ? " " + c.version : ""}`));
        const exp = c.sumP / c.n, act = c.hits / c.n, gap = Math.abs(act - exp) * 100;
        return tile(label, this.numHtml(`${this.pct(act)} / ${this.pct(exp)}`),
          this.numHtml(`landed / predicted · ${c.n} graded${c.voids ? ` · ${c.voids} DNP` : ""}`),
          gap < 2 ? "good" : gap < 4 ? "amber" : "bad");
      };
      const wp = t && t.wp;
      const ab = this.trustRollup("ab_result");
      const velo = this.trustRollup("pitch_speed_ou");
      return `<div class="ph-kpis">
        ${calTile("1+ HIT CALIBRATION · 7 DAYS", "batter_hit")}
        ${calTile("1+ HR CALIBRATION · 7 DAYS", "batter_hr")}
        ${!wp ? tile("WIN PROB · 7 DAYS", "—", t ? "couldn't load" : "loading…")
          : tile("WIN PROB · 7 DAYS", this.numHtml(this.ratioPct(wp.w, wp.l + wp.w)), wp.w + wp.l ? "pregame favourite won" : "0 graded", acc(wp.w, wp.l))}
        ${!ab ? tile("AT-BAT CALLS · 7 DAYS", "—", "loading…")
          : tile("AT-BAT CALLS · 7 DAYS", this.numHtml(this.ratioPct(ab.w, ab.w + ab.l)), this.numHtml(`${ab.w + ab.l ? "" : "0 graded · "}ab_result ${ab.versions.join(", ")}`), acc(ab.w, ab.l))}
        ${!velo ? tile("VELO MAE · 7 DAYS", "—", "loading…")
          : !velo.maeServed ? tile("VELO MAE · 7 DAYS", this.missingHtml("notserved"), "mean_abs_error not in /accuracy yet")
            : tile("VELO MAE · 7 DAYS", velo.mae == null ? "—" : this.numHtml(`${velo.mae.toFixed(1)} mph`), this.numHtml("pitch_speed_ou · σ 5.4"))}
      </div>`;
    }

    // ── today's batter projections ───────────────────────────────────────
    // Both markets in two requests, at most once per route TTL. A failed
    // fetch keeps the last rows and flags `err`, so a blip does not blank
    // every cell that reads them.
    async loadProjections(force) {
      if (!force && Date.now() - this._projAt < PROJ_TTL_MS) return false;
      this._projAt = Date.now();
      const date = slateDate();
      // One request per batter market (a slate is ~270 rows each) plus all
      // starter props at once: the route pages at 1,000 rows, and a whole
      // slate across every market is more than that.
      const reqs = this.BATTER_MARKETS.map((m) => `/projections?date=${date}&market=${m}`)
        .concat([`/projections?date=${date}&role=pitcher`]);
      const res = await Promise.all(reqs.map((u) => fetchJson(u)));
      // 1+ Hit and 1+ HR are the trained markets; without them the batter
      // surface has nothing to rank, so their failure is the error state.
      if (!res[0] || !res[1]) {
        this.state.proj = Object.assign({}, this.state.proj, { err: true });
        return false;
      }
      const rows = [].concat(...res.map((r) => (r && r.rows) || []));
      const changed = JSON.stringify(rows) !== JSON.stringify(this.state.proj.rows);
      this.state.proj = { rows, err: false };
      return changed;
    }

    // ══ HOME ═════════════════════════════════════════════════════════════
    // Title row, status bar, the four decision cards, then every game on the
    // slate as a pill grouped Live / Upcoming / Final. Each pill expands to
    // the player game markets for that game.
    homeHtml() {
      const games = this.todayGames();
      const head = this.homeTitleHtml() + this.statusBarHtml();
      if (!games.length) return head + this.homeEmptyHtml();
      return head + this.decisionStripHtml() + this.homeGroupsHtml();
    }

    // ── league baselines ─────────────────────────────────────────────────
    // Per-PA rates, mirrored from LEAGUE in supabase/functions/_shared/
    // model.ts. They must agree: a lift measured against a different centre
    // than the model's is a lift the model did not claim.
    LEAGUE_PA = { hit: 0.239, hr: 0.032 };
    LEAGUE_PITCH = { strike_foul: 0.455, ball: 0.352, in_play: 0.193 };
    LEAGUE_AB = { strikeout: 0.221, walk: 0.087, hit: 0.239, out: 0.453 };

    // The league chance of 1+ hit (or HR) for a batter getting `xpa` plate
    // appearances. Per batter rather than one constant, so a leadoff hitter
    // is not flattered by batting more often than the ninth.
    leagueBase(m, xpa) {
      if (xpa == null || !isFinite(xpa)) return null;
      return 1 - Math.pow(1 - this.LEAGUE_PA[m], xpa);
    }

    // ── slate data ───────────────────────────────────────────────────────
    todayGames() { return PH.games || []; }
    gameByPk(pk) {
      return this.todayGames().find((g) => String(g.gamePk) === String(pk)) || null;
    }
    lastName(n) {
      const parts = String(n || "").trim().split(/\s+/);
      return parts.length ? parts[parts.length - 1] || "—" : "—";
    }
    r3(v) { return v == null ? "—" : Number(v).toFixed(3).replace(/^0/, ""); }
    pct1(v) { return v == null ? "—" : (Number(v) * 100).toFixed(1) + "%"; }

    // Today's /projections rows folded to one record per batter per game,
    // holding both markets. Memoised on the rows array, which only changes
    // when a fetch returns something different.
    // Projection markets served by /projections, and the key each batter
    // market folds into on a batter record. batter_hit / batter_hr are trained
    // models; the rest are base models (supabase/functions/_shared/basemodels.ts).
    BATTER_MARKETS = ["batter_hit", "batter_hr", "batter_tb15", "batter_hrr"];
    BATTER_KEY = { batter_hit: "hit", batter_hr: "hr", batter_tb15: "tb15", batter_hrr: "hrr" };
    STARTER_MARKETS = [
      ["pitcher_k", "Ks"], ["pitcher_outs", "Outs"], ["pitcher_hits", "Hits"],
      ["pitcher_er", "ER"], ["pitcher_bb", "BB"],
    ];

    batters() {
      const rows = this.state.proj.rows;
      if (!rows) return null;
      if (this._batMemo && this._batMemo.rows === rows) return this._batMemo.list;
      const by = new Map();
      rows.forEach((r) => {
        if (r.role === "pitcher") return;
        const mk = this.BATTER_KEY[r.market];
        if (!mk) return;
        const key = `${r.game_pk}:${r.player_id}`;
        let b = by.get(key);
        if (!b) {
          b = {
            key, id: String(r.player_id), name: r.player || null, pk: String(r.game_pk),
            side: r.is_home ? "home" : "away", slot: null, xpa: null,
            spId: r.opposing_pitcher_id == null ? null : String(r.opposing_pitcher_id),
            spName: r.opposing_pitcher || null, updatedAt: null,
            hit: null, hr: null, tb15: null, hrr: null,
          };
          by.set(key, b);
        }
        b[mk] = r;
        if (b.slot == null && r.lineup_slot != null) b.slot = Number(r.lineup_slot);
        if (b.xpa == null && r.expected_pa != null) b.xpa = Number(r.expected_pa);
        if (r.updated_at && (!b.updatedAt || r.updated_at > b.updatedAt)) b.updatedAt = r.updated_at;
      });
      const list = [...by.values()];
      this._batMemo = { rows, list };
      return list;
    }
    battersOf(pk) { return (this.batters() || []).filter((b) => b.pk === String(pk)); }
    // Starter props, keyed "gamePk:pitcherId" -> { market: row }. Memoised on
    // the rows array like batters().
    starterProps(pk, pitcherId) {
      const rows = this.state.proj.rows;
      if (!rows || pitcherId == null) return null;
      if (!this._spMemo || this._spMemo.rows !== rows) {
        const by = {};
        rows.forEach((r) => {
          if (r.role !== "pitcher") return;
          const k = `${r.game_pk}:${r.player_id}`;
          (by[k] = by[k] || {})[r.market] = r;
        });
        this._spMemo = { rows, by };
      }
      return this._spMemo.by[`${pk}:${pitcherId}`] || null;
    }
    teamOf(b) {
      const g = this.gameByPk(b.pk);
      return g ? (b.side === "home" ? g.home : g.away) : "—";
    }

    // ── the probability cell ─────────────────────────────────────────────
    // Port of the prototype's cell(). `m` is "hit" or "hr". Band is relative
    // to the league rate at the batter's own xPA: ≥1.10× good, <0.95× low.
    // The HR bar is drawn on a 40% scale, or every HR bar would be a sliver.
    probCell(b, m) {
      const r = b && b[m];
      const p = r && r.probability != null ? Number(r.probability) : null;
      const xpa = r && r.expected_pa != null ? Number(r.expected_pa) : b ? b.xpa : null;
      const base = this.leagueBase(m, xpa);
      if (p == null || base == null) return { p, base, xpa, rel: null, band: null, pts: null };
      const pts = (p - base) * 100;
      const rel = p / base;
      const sc = m === "hr" ? 0.4 : 1;
      return {
        p, base, xpa, rel, pts,
        band: rel >= 1.10 ? "good" : rel < 0.95 ? "low" : "avg",
        lift: `${pts >= 0 ? "+" : "−"}${Math.abs(pts).toFixed(m === "hr" ? 1 : 0)} pts`,
        w: Math.min(100, (p / sc) * 100),
        tick: Math.min(100, (base / sc) * 100),
        ppa: r.per_pa_probability == null ? null : Number(r.per_pa_probability),
      };
    }
    // noLift: the Predictions table gives lift its own sortable column.
    probCellHtml(b, m, noLift) {
      const c = this.probCell(b, m);
      if (c.p == null) return `<span class="ph-pc"><span class="ph-missing-dash">—</span></span>`;
      if (c.band == null) {
        return `<span class="ph-pc"><b class="ph-mono ph-pc-val">${this.pct(c.p)}</b></span>`;
      }
      const ppa = m === "hit" ? this.r3(c.ppa) : this.pct1(c.ppa);
      return `<span class="ph-pc">
        <span class="ph-pc-top">
          <b class="ph-mono ph-pc-val ph-band-${c.band}">${this.pct(c.p)}</b>
          ${noLift ? "" : `<span class="ph-mono ph-lift ph-lift--${c.band}">${c.lift}</span>`}
          <span class="ph-mono ph-pc-base">league ${this.pct(c.base)}</span>
        </span>
        ${this.barHtml(c.w, c.tick, `ph-band-bg-${c.band}`)}
        <span class="ph-mono ph-pc-foot">per-PA ${ppa} · ${c.xpa.toFixed(2)} xPA</span>
      </span>`;
    }
    barHtml(w, tick, cls) {
      return `<span class="ph-bar"><span class="ph-bar-fill ${cls || ""}" style="width:${w.toFixed(1)}%"></span>${tick == null ? "" : `<span class="ph-bar-tick" style="left:${tick.toFixed(1)}%"></span>`}</span>`;
    }

    // The two "why" lines under a batter read (port of why()). Rolling 30-day
    // rates are not routed per slate, so those parts are a dash with a tag;
    // H2H, slot and xPA are real. Returns HTML.
    whyLines(b, m) {
      const sp = esc(this.lastName(b.spName));
      const h = this.h2hOf(b);
      const slot = b.slot ? `slot ${b.slot}` : "slot pending";
      const xpa = b.xpa == null ? "—" : b.xpa.toFixed(2);
      const ns = this.tagHtml("notserved");
      let h2h;
      if (!h || h.pending) h2h = "—";
      else if (!h.found) h2h = "— (&lt;3 PA)";
      else h2h = m === "hit" ? `${h.h_count}-${h.pa_count}` : `${h.hr_count} HR in ${h.pa_count} PA`;
      return m === "hit"
        ? [`30d H/PA — · ${sp} H/PA — ${ns}`, `H2H ${h2h} · ${slot} → ${xpa} xPA`]
        : [`30d HR/PA — · ${sp} HR/PA — ${ns}`, `H2H ${h2h} · ${slot} → ${xpa} xPA`];
    }

    // ── head-to-head (lazy) ──────────────────────────────────────────────
    // Views ask for a pair while they render; the asks are flushed once per
    // render, as one batch, so a nine-batter table is one repaint, not nine.
    h2hOf(b) {
      if (!b.spId) return null;
      const k = `${b.spId}:${b.id}`;
      const v = this.state.h2h[k];
      // A failed lookup is retried after a minute, not on the next render —
      // the failure's own repaint would otherwise re-ask in a tight loop.
      const stale = v && v.err && Date.now() - v.at > 60000;
      if (!v || stale) (this._wantH2H || (this._wantH2H = new Set())).add(k);
      return v && !v.err ? v : null;
    }
    // Starter profile + fatigue, through loadEntityProfile's per-player cache.
    starterOf(id) {
      if (!id) return null;
      const v = this.state.entityProfile[String(id)];
      if (!v) (this._wantSP || (this._wantSP = new Set())).add(String(id));
      return v || null;
    }
    _flushWants() {
      const pairs = this._wantH2H ? [...this._wantH2H] : [];
      const sps = this._wantSP ? [...this._wantSP] : [];
      this._wantH2H = null; this._wantSP = null;
      sps.forEach((id) => this.loadEntityProfile(id, "PITCHER"));
      if (!pairs.length) return;
      const pend = {};
      pairs.forEach((k) => { pend[k] = { pending: true }; });
      this.state.h2h = Object.assign({}, this.state.h2h, pend);
      Promise.all(pairs.map((k) => {
        const [p, b] = k.split(":");
        return fetchJson(`/matchup/${p}/${b}`).then((row) => [k, row]);
      })).then((res) => {
        const next = Object.assign({}, this.state.h2h);
        res.forEach(([k, row]) => { next[k] = row || { err: true, at: Date.now() }; });
        this.setState({ h2h: next });
      });
    }

    // ── game-level reads ─────────────────────────────────────────────────
    // Port of wp(). The favourite and its win probability, the move since
    // first pitch, and the caption saying which number this is. A finished
    // game reports who won and what the model opened with.
    gameWp(g) {
      const homeP = (mk) => {
        if (!mk || !mk.probs) return null;
        if (mk.probs.home != null) return Number(mk.probs.home);
        return mk.probs.away != null ? 1 - Number(mk.probs.away) : null;
      };
      const nowMk = g.m && g.m.game_moneyline;
      const preMk = g.mPre && g.mPre.game_moneyline;
      const h0 = homeP(preMk) != null ? homeP(preMk) : g.phase === "pregame" ? homeP(nowMk) : null;
      if (g.phase === "final") {
        const a = Number(g.score.away), h = Number(g.score.home);
        const done = isFinite(a) && isFinite(h) && a !== h;
        const pick = h0 == null ? null : h0 >= 0.5 ? g.home : g.away;
        return {
          team: done ? (h > a ? g.home : g.away) : "—", val: done ? "won" : "—", prob: null, delta: null,
          from: h0 == null ? "" : `pregame ${pick} ${this.pct(Math.max(h0, 1 - h0))}`,
          caption: "WIN PROB · AT FINAL", capCls: "is-final", swing: 0,
        };
      }
      const h1 = g.phase === "pregame" ? h0 : homeP(nowMk);
      const caption = g.phase === "live" ? "● WIN PROB · LIVE" : "WIN PROB · PREGAME";
      const capCls = g.phase === "live" ? "is-live" : "is-pre";
      if (h1 == null) return { team: "—", val: "—", prob: null, delta: null, from: "", caption, capCls, swing: 0 };
      const favHome = h1 >= 0.5;
      const p = favHome ? h1 : 1 - h1;
      const p0 = h0 == null ? null : favHome ? h0 : 1 - h0;
      const delta = g.phase === "live" && p0 != null ? Math.round((p - p0) * 100) : null;
      return {
        team: favHome ? g.home : g.away, val: this.pct(p), prob: p, pre: p0, delta,
        from: g.phase === "live" && p0 != null ? `from ${this.pct(p0)}` : "",
        caption, capCls, swing: delta == null ? 0 : Math.abs(delta),
      };
    }
    deltaHtml(d) {
      if (d == null) return "";
      const cls = d > 0 ? "is-up" : d < 0 ? "is-down" : "";
      const t = d === 0 ? "±0" : d > 0 ? `▲ ${d}` : `▼ ${Math.abs(d)}`;
      return `<span class="ph-mono ph-delta ${cls}">${t}</span>`;
    }
    // The frozen pregame total. game_total is written once by game-predict,
    // so the pregame row is the only row.
    gameTotal(g) {
      const pre = g.mPre && g.mPre.game_total;
      const mk = pre && pre.covered ? pre : g.m && g.m.game_total;
      const pick = this.totPickOf(mk);
      const proj = mk && mk.predictedValue != null ? Number(mk.predictedValue) : null;
      return { pick: pick.pick, prob: pick.prob, proj };
    }
    // The pill's "strongest read": the batter-market pair furthest above its
    // league rate, relative (p ÷ league) so HR reads can compete with hits.
    strongestRead(pk) {
      let best = null;
      this.battersOf(pk).forEach((b) => ["hit", "hr"].forEach((m) => {
        const c = this.probCell(b, m);
        if (c.rel != null && (!best || c.rel > best.c.rel)) best = { b, m, c };
      }));
      return best;
    }
    // Port of topCall(): the more confident of the live next-pitch and
    // at-bat-result calls, with its league rate.
    topCallOf(g) {
      const pick = (mk, lg, label) => {
        const probs = mk && mk.probs;
        if (!probs) return null;
        const k = Object.keys(probs).reduce((a, b) => (probs[a] >= probs[b] ? a : b), Object.keys(probs)[0]);
        return k == null || lg[k] == null ? null : { k, p: Number(probs[k]), lg: lg[k], mkt: label };
      };
      const a = pick(g.m && g.m.pitch_result, this.LEAGUE_PITCH, "Next pitch");
      const b = pick(g.m && g.m.ab_result, this.LEAGUE_AB, "At-bat result");
      if (!a) return b;
      if (!b) return a;
      return a.p >= b.p ? a : b;
    }
    // "game at-bat calls 14/19 · 74%" from today's graded rows, if loaded.
    gameAbRecord(pk) {
      const m = this.models().find((x) => String(x.pk) === String(pk));
      if (!m) return "—";
      const s = this.gameStats(m.abs);
      return this.ratioPct(s.abC, s.abN);
    }
    // The strongest HR read among the next three batters due up in each live
    // game. /live does not serve the upcoming order, so it is derived from
    // the current batter's lineup slot.
    dueUp() {
      let due = null;
      this.todayGames().filter((g) => g.phase === "live").forEach((g) => {
        const side = g.half === "▲" ? "away" : "home";
        const bs = this.battersOf(g.gamePk).filter((b) => b.side === side);
        const cur = g.batter && g.batter.id != null ? bs.find((b) => b.id === String(g.batter.id)) : null;
        if (!cur || !cur.slot) return;
        [1, 2, 3].forEach((k) => {
          const slot = ((cur.slot - 1 + k) % 9) + 1;
          const b = bs.find((x) => x.slot === slot);
          const c = b && this.probCell(b, "hr");
          if (c && c.rel != null && (!due || c.rel > due.c.rel)) due = { b, c, k, g };
        });
      });
      return due;
    }
    lineupsConfirmed() {
      const games = this.todayGames();
      if (!this.batters()) return null;
      const ok = games.filter((g) => ["away", "home"].every((s) => {
        const bs = this.battersOf(g.gamePk).filter((b) => b.side === s);
        return bs.length && bs.every((b) => b.slot);
      })).length;
      return { ok, n: games.length };
    }

    // ── title row + status bar ───────────────────────────────────────────
    segHtml(act, cur, items, withLiveDot) {
      return `<div class="ph-seg">${items.map(([k, label]) => `<button class="ph-seg-btn${cur === k ? " is-on" : ""}" data-act="${act}" data-arg="${esc(k)}">${withLiveDot && k === "live" ? `<span class="ph-dot is-live ph-dot-sm"></span>` : ""}${this.numHtml(label)}</button>`).join("")}</div>`;
    }
    homeTitleHtml() {
      // The slate's own date, not the clock's: on an off day this is the next
      // slate. Noon UTC of an ET calendar date is the same date in ET.
      const date = new Date(`${slateDate()}T12:00:00Z`)
        .toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: ET });
      const anyLive = this.todayGames().some((g) => g.phase === "live");
      const next = !SLATE_IS_TODAY;
      return `<div class="ph-titlerow">
        <h1 class="ph-h1">${esc(next ? COPY.homeTitleNext : COPY.homeTitle)}</h1>
        <span class="ph-mono ph-titlerow-date">${esc(date)} · all times ET${next ? ` · ${esc(COPY.homeNextSub)}` : ""}</span>
        <div class="ph-titlerow-right">
          <span class="ph-kicker ph-kicker--mut">Rank reads for</span>
          ${this.segHtml("mode", this.effectiveMode(), [["pregame", "Pregame"], ["live", "Live"]], anyLive)}
        </div>
      </div>`;
    }
    statusBarHtml() {
      const games = this.todayGames();
      const n = (p) => games.filter((g) => g.phase === p).length;
      const lu = this.lineupsConfirmed();
      const upd = this.clockSec(this.state.api.updatedAt);
      return `<div class="ph-statusbar ph-mono">
        <span><b>${games.length || "—"}</b> games</span>
        <span class="ph-statusbar-live"><span class="ph-dot${n("live") ? " is-live" : ""} ph-dot-sm"></span><b>${n("live")}</b> live</span>
        <span class="ph-statusbar-up"><b>${n("pregame")}</b> upcoming</span>
        <span><b>${n("final")}</b> final</span>
        <span>lineups confirmed <b>${lu && lu.n ? `${lu.ok}/${lu.n}` : "—"}</b></span>
        <span class="ph-statusbar-upd">updated <b class="${this.flashIf("statusbar", upd)}">${esc(upd || "—")}</b> · polls every 8s</span>
      </div>`;
    }
    homeEmptyHtml() {
      // Before anything has loaded the board says so; a failed load is the
      // API banner's job, and must never read as a quiet day.
      const msg = this.state.api.down ? COPY.homeUnreachable
        : this.state.api.lastGood == null ? COPY.homeLoading : COPY.homeNoGames;
      return `<div class="ph-empty">${esc(msg)}</div>`;
    }

    // ── decision strip ───────────────────────────────────────────────────
    decisionStripHtml() {
      const live = this.effectiveMode() === "live";
      const cards = (live ? this.liveCards() : this.pregameCards()).filter(Boolean);
      const notFinal = this.todayGames().filter((g) => g.phase !== "final").length;
      const sub = live ? COPY.stripSubLive
        : COPY.stripSubPre.replace("{n}", String(notFinal));
      const body = cards.length
        ? `<div class="ph-cards">${cards.map((c) => this.decisionCardHtml(c)).join("")}</div>`
        : `<div class="ph-empty ph-empty--sm">${esc(live ? COPY.stripEmptyLive : COPY.stripEmptyPre)}</div>`;
      return `<div class="ph-strip-head">
          <span class="ph-kicker ${live ? "is-live" : "is-pre"}">${live ? "● Live decisions" : "Pregame decisions"}</span>
          <span class="ph-strip-sub">${this.numHtml(sub)}</span>
        </div>${body}`;
    }
    phaseChip(kind, text) { return `<span class="ph-phase ph-phase--${kind}">${this.numHtml(text)}</span>`; }
    decisionCardHtml(c) {
      const viz = c.spark ? `<span class="ph-card-spark">${this.missingHtml("needsroute")}<span class="ph-card-spark-note">win-prob sparkline</span></span>`
        : c.bar ? this.barHtml(c.bar.w, c.bar.tick, c.bar.cls) : "";
      return `<button class="ph-card${c.live ? " is-live" : ""}" data-act="${c.act}" data-arg="${esc(c.arg)}">
        <span class="ph-card-head">
          <span class="ph-kicker${c.live ? " is-live" : ""}">${esc(c.kicker)}</span>
          ${this.phaseChip(c.phaseKind, c.phase)}
        </span>
        <span class="ph-card-id">
          <b class="ph-card-title">${this.numHtml(c.title)}</b>
          <span class="ph-card-sub">${this.numHtml(c.sub)}</span>
        </span>
        <span class="ph-card-val">
          <b class="ph-mono ${c.valCls || ""}">${esc(c.val)}</b>
          ${c.lift ? `<span class="ph-mono ph-lift ph-lift--${c.liftBand || "avg"}">${esc(c.lift)}</span>` : ""}
          <span class="ph-mono ph-card-base">${esc(c.base || "")}</span>
        </span>
        ${viz}
        <span class="ph-card-why ph-mono">
          <span>${c.why1}</span>
          <span class="ph-card-why2">${c.why2}</span>
        </span>
        <span class="ph-card-foot">
          <span class="ph-mono ph-card-fresh ${c.flash || ""}">${esc(c.fresh)}</span>
          <span class="ph-status ph-status--${c.statusKind || "solid"}">${this.numHtml(c.status)}</span>
        </span>
      </button>`;
    }
    batterCard(kicker, b, m) {
      if (!b) return null;
      const g = this.gameByPk(b.pk);
      const c = this.probCell(b, m);
      const w = this.whyLines(b, m);
      const upd = this.clockOf(b.updatedAt);
      return {
        kicker, title: b.name || "—",
        sub: `${this.teamOf(b)} · ${b.slot ? "#" + b.slot : "slot —"} · vs ${b.spName || "TBD"}${g ? ` · ${g.away} @ ${g.home}` : ""}`,
        phase: g && g.phase === "live" ? "PREGAME · FROZEN" : "PREGAME", phaseKind: "pre",
        val: this.pct(c.p), valCls: `ph-band-${c.band}`, lift: c.lift, liftBand: c.band,
        base: `league ${this.pct(c.base)}`,
        bar: { w: c.w, tick: c.tick, cls: `ph-band-bg-${c.band}` },
        why1: w[0], why2: w[1],
        fresh: upd ? `updated ${upd}` : "—", flash: this.flashIf(`card:${b.key}:${m}`, b.updatedAt),
        status: b.slot ? "LINEUP ✓" : "LINEUP PENDING", statusKind: b.slot ? "solid" : "dashed",
        act: "openPill", arg: `${b.pk}|${b.side}`,
      };
    }
    pregameCards() {
      const games = this.todayGames().filter((g) => g.phase !== "final");
      const pool = (this.batters() || []).filter((b) => {
        const g = this.gameByPk(b.pk);
        return g && g.phase !== "final";
      });
      const best = (m) => {
        let top = null;
        pool.forEach((b) => {
          const c = this.probCell(b, m);
          if (c.pts != null && (!top || c.pts > top.pts)) top = { b, pts: c.pts };
        });
        return top && top.b;
      };
      const sps = (g) => `${this.lastName(g.probables.away)} vs ${this.lastName(g.probables.home)}`;
      const at = (g) => `${g.away} @ ${g.home}`;
      const start = (g) => this.clockOf(g.startTs) || "TBD";

      let fav = null;
      games.forEach((g) => {
        const w = this.gameWp(Object.assign({}, g, { phase: "pregame" }));
        if (w.prob != null && (!fav || w.prob > fav.w.prob)) fav = { g, w };
      });
      const favCard = fav && {
        kicker: "BIGGEST PREGAME FAVOURITE",
        title: `${fav.w.team} over ${fav.w.team === fav.g.home ? fav.g.away : fav.g.home}`,
        sub: `${at(fav.g)} · ${start(fav.g)} · ${sps(fav.g)}`,
        phase: "PREGAME", phaseKind: "pre",
        val: fav.w.val, lift: `+${Math.round((fav.w.prob - 0.5) * 100)} pts`, base: "vs 50%",
        bar: { w: fav.w.prob * 100, tick: 50, cls: "ph-band-bg-avg" },
        why1: "pregame win prob · log5_v1",
        why2: `starters ${esc(sps(fav.g))}`,
        fresh: fav.g.phase === "live" ? "frozen at first pitch" : "set by game-predict",
        status: fav.g.phase === "live" ? "LIVE NOW" : "PREGAME", statusKind: "solid",
        act: "openPill", arg: String(fav.g.gamePk),
      };

      const tots = games.map((g) => ({ g, t: this.gameTotal(g) })).filter((x) => x.t.proj != null);
      const hi = tots.slice().sort((a, b) => b.t.proj - a.t.proj)[0];
      const avg = tots.length ? tots.reduce((s, x) => s + x.t.proj, 0) / tots.length : null;
      const totCard = hi && {
        kicker: "HIGHEST PROJECTED TOTAL", title: at(hi.g),
        sub: `${hi.g.venue || "—"} · ${start(hi.g)} · ${sps(hi.g)}`,
        phase: "PREGAME", phaseKind: "pre",
        val: hi.t.proj.toFixed(1), lift: `${hi.t.pick} · ${this.pct(hi.t.prob)}`,
        base: avg == null ? "" : `slate avg ${avg.toFixed(1)}`,
        why1: "team run rates · park factor · starter profiles",
        why2: `weather used in the model ${this.tagHtml("notserved")}`,
        fresh: "frozen at first pitch", status: "RUNS", statusKind: "solid",
        act: "openPill", arg: String(hi.g.gamePk),
      };
      return [
        this.batterCard("STRONGEST 1+ HIT", best("hit"), "hit"),
        this.batterCard("STRONGEST 1+ HR", best("hr"), "hr"),
        favCard, totCard,
      ];
    }
    liveCards() {
      const live = this.todayGames().filter((g) => g.phase === "live");
      if (!live.length) return [];
      const updated = `updated ${this.clockSec(this.state.api.updatedAt) || "—"}`;
      const inn = (g) => `${g.half === "▼" ? "Bot" : "Top"} ${g.inning == null ? "—" : g.inning}`;
      const sit = (g) => `${inn(g)} · ${g.count || "—"} · ${g.outs == null ? "—" : g.outs} out`;
      const at = (g) => `${g.away} @ ${g.home} · ${g.score.away}–${g.score.home}`;
      const liveCard = (o) => Object.assign({ live: true, phase: "● LIVE", phaseKind: "live", fresh: updated }, o);

      const wps = live.map((g) => ({ g, w: this.gameWp(g) })).filter((x) => x.w.prob != null);
      const sw = wps.slice().sort((a, b) => b.w.swing - a.w.swing)[0];
      const swing = sw && liveCard({
        kicker: "BIGGEST SWING", title: at(sw.g), sub: `${inn(sw.g)} · ${sw.w.team} win prob since first pitch`,
        val: sw.w.val, lift: sw.w.delta == null ? "" : `${sw.w.delta > 0 ? "+" : sw.w.delta < 0 ? "−" : "±"}${Math.abs(sw.w.delta)} pts`,
        liftBand: sw.w.delta > 0 ? "good" : "avg", base: sw.w.pre == null ? "" : `opened ${this.pct(sw.w.pre)}`,
        spark: true, why1: "live − pregame win prob · mlb_winprob_v1", why2: "win-prob history needs a route",
        flash: this.flashIf("card:swing", `${sw.g.gamePk}:${sw.w.val}`),
        status: "NEEDS ROUTE", statusKind: "route", act: "liveGo", arg: String(sw.g.gamePk),
      });

      const tcs = live.map((g) => ({ g, c: this.topCallOf(g) })).filter((x) => x.c);
      const tc = tcs.sort((a, b) => b.c.p - a.c.p)[0];
      const top = tc && liveCard({
        kicker: "TOP CALL NOW", title: `${this.outLabel(tc.c.k)} · ${tc.c.mkt}`,
        sub: `${tc.g.away} @ ${tc.g.home} · ${this.shortName(tc.g.batter.name)} vs ${this.shortName(tc.g.pitcher.name)}`,
        val: this.pct(tc.c.p), valCls: "ph-band-good",
        lift: `${tc.c.p >= tc.c.lg ? "+" : "−"}${Math.abs(Math.round((tc.c.p - tc.c.lg) * 100))} pts`,
        liftBand: tc.c.p >= tc.c.lg ? "good" : "avg", base: `league ${this.pct(tc.c.lg)}`,
        bar: { w: tc.c.p * 100, tick: tc.c.lg * 100, cls: "ph-band-bg-good" },
        why1: esc(sit(tc.g)), why2: `game at-bat calls ${esc(this.gameAbRecord(tc.g.gamePk))}`,
        flash: this.flashIf("card:top", `${tc.g.gamePk}:${tc.c.k}:${tc.c.p}`),
        status: "LIVE CALL", statusKind: "solid", act: "liveGo", arg: String(tc.g.gamePk),
      });

      const due = this.dueUp();
      const dueCard = due && Object.assign(this.batterCard(
        `DUE UP · ${due.k === 1 ? "ON DECK" : due.k === 2 ? "IN THE HOLE" : "3RD UP"}`, due.b, "hr"), {
        sub: `${this.teamOf(due.b)} #${due.b.slot} · 1+ HR · vs ${due.b.spName || "TBD"} · ${due.g.away} @ ${due.g.home}`,
        why2: "who bats next: derived from lineup slot + current batter",
        status: "DERIVED", statusKind: "dashed",
      });

      const cl = wps.slice().sort((a, b) => a.w.prob - b.w.prob)[0];
      const closest = cl && liveCard({
        kicker: "CLOSEST GAME", title: at(cl.g), sub: sit(cl.g),
        val: cl.w.val, lift: `${Math.round((cl.w.prob - 0.5) * 100)} pts from 50`,
        base: `${cl.w.team}${cl.w.delta == null ? "" : ` · ${cl.w.delta > 0 ? "▲" : cl.w.delta < 0 ? "▼" : "±"}${Math.abs(cl.w.delta)}`}`,
        bar: { w: cl.w.prob * 100, tick: 50, cls: "ph-band-bg-avg" },
        why1: cl.w.pre == null ? "—" : esc(`opened ${cl.w.team} ${this.pct(cl.w.pre)} · now ${cl.w.val}`),
        why2: `game at-bat calls ${esc(this.gameAbRecord(cl.g.gamePk))}`,
        flash: this.flashIf("card:close", `${cl.g.gamePk}:${cl.w.val}`),
        status: "WIN PROB", statusKind: "solid", act: "liveGo", arg: String(cl.g.gamePk),
      });
      return [swing, top, dueCard, closest];
    }

    // ── game groups + pills ──────────────────────────────────────────────
    homeGroupsHtml() {
      const games = this.todayGames();
      const of = (p) => games.filter((g) => g.phase === p);
      const innKey = (g) => (g.inning == null ? -1 : g.inning * 2 + (g.half === "▼" ? 1 : 0));
      const groups = [
        { title: "LIVE NOW", cls: "is-live", hint: "latest inning first", games: of("live").sort((a, b) => innKey(b) - innKey(a)) },
        { title: "UPCOMING", cls: "is-pre", hint: "soonest first", games: of("pregame").sort((a, b) => Date.parse(a.startTs || 0) - Date.parse(b.startTs || 0)) },
        { title: "FINAL", cls: "", hint: "graded", games: of("final") },
      ];
      return groups.filter((grp) => grp.games.length).map((grp) => `
        <div class="ph-group">
          <div class="ph-group-head">
            <span class="ph-kicker ${grp.cls}">${grp.title}</span>
            <span class="ph-mono ph-group-n">${grp.games.length} game${grp.games.length === 1 ? "" : "s"}</span>
            <span class="ph-rule"></span>
            <span class="ph-group-hint">${grp.hint}</span>
          </div>
          <div class="ph-pills">${grp.games.map((g) => this.homePillHtml(g)).join("")}</div>
        </div>`).join("");
    }
    pinBtnHtml(key, title) {
      const on = this.isPinned(key);
      return `<button class="ph-pin${on ? " is-on" : ""}" data-act="pin" data-arg="${esc(key)}" title="${esc(title)}" aria-pressed="${on}">${on ? "★" : "☆"}</button>`;
    }
    homePillHtml(g) {
      const pk = String(g.gamePk);
      const open = !!this.state.open[pk];
      const live = g.phase === "live", final = g.phase === "final";
      const until = g.phase === "pregame" ? this.untilText(g.startTs) : null;
      const sub = [g.venue, until].filter(Boolean).join(" · ") || "—";
      const score = g.phase === "pregame" ? "—" : `${g.score.away} – ${g.score.home}`;
      const scoreSub = live ? `${this.halfWord(g.half).toLowerCase()} ${g.inning == null ? "—" : g.inning}` : final ? "final" : "first pitch";
      const w = this.gameWp(g);
      const t = this.gameTotal(g);
      const sr = this.strongestRead(pk);
      const bs = this.battersOf(pk);
      const pending = bs.length && bs.some((b) => !b.slot);
      const srCap = `STRONGEST READ${bs.length ? ` · ${pending ? "LINEUP PENDING" : "LINEUP ✓"}` : ""}${live ? " · FROZEN" : ""}`;
      const toggle = `data-act="pillToggle" data-arg="${esc(pk)}"`;
      // Phone: the same pill as three stacked lines (handoff "Pill (phone)").
      if (this.mob()) {
        const sit = live ? `${g.count || "—"} · ${g.outs != null ? `${g.outs} out` : "—"}` : scoreSub;
        return `<div class="ph-gpill${live ? " is-live" : ""}" data-ph-pill="${esc(pk)}">
          <div class="ph-gpill-m">
            <div class="ph-gpill-m1">
              ${this.pinBtnHtml("g:" + pk, "Watch this game")}
              ${this.slateChipHtml(g, true)}
              <button class="ph-gpill-match" ${toggle}><b>${esc(g.away)} @ ${esc(g.home)}</b></button>
              <b class="ph-mono ph-gpill-mscore ${live ? "is-live" : final ? "is-final" : "is-pre"}">${esc(score)}</b>
              <button class="ph-chev" ${toggle} aria-expanded="${open}">${open ? "▾" : "▸"}</button>
            </div>
            <div class="ph-gpill-m2">
              ${this.basesHtml(true)}
              <span class="ph-mono">${esc(sit)}</span>
              <span class="ph-mono ph-ellip ph-gpill-mvenue">${esc(sub)}</span>
            </div>
            <div class="ph-gpill-m3">
              <span class="ph-gpill-mcell"><span class="ph-cap ${w.capCls}">ML</span><b>${esc(w.team)}</b><span class="ph-mono ph-gpill-num">${esc(w.val)}</span>${this.deltaHtml(w.delta)}</span>
              <span class="ph-gpill-mcell"><span class="ph-cap">TOT</span><b>${this.numHtml(t.pick)}</b><span class="ph-mono ph-gpill-num is-dim">${this.pct(t.prob)}</span></span>
              ${sr ? `<span class="ph-gpill-mcell ph-gpill-msr"><span class="ph-cap">READ</span><b class="ph-ellip">${esc(this.lastName(sr.b.name))}</b><span class="ph-gpill-mkt">${sr.m === "hit" ? "1+ H" : "1+ HR"}</span><span class="ph-mono ph-gpill-num ph-band-${sr.c.band}">${this.pct(sr.c.p)}</span></span>` : ""}
            </div>
          </div>
          ${open ? this.homePillBodyHtml(g) : ""}
        </div>`;
      }
      return `<div class="ph-gpill${live ? " is-live" : ""}" data-ph-pill="${esc(pk)}">
        <div class="ph-gpill-row">
          ${this.pinBtnHtml("g:" + pk, "Watch this game")}
          ${this.slateChipHtml(g, false)}
          <button class="ph-gpill-match" ${toggle}>
            <b>${esc(g.away)} @ ${esc(g.home)}</b>
            <span class="ph-mono">${esc(sub)}</span>
          </button>
          <span class="ph-gpill-score ph-mono">
            <b class="${live ? "is-live" : final ? "is-final" : "is-pre"}">${esc(score)}</b>
            <span>${esc(scoreSub)}</span>
          </span>
          <span class="ph-gpill-sit">
            ${this.basesHtml(false)}
            <span class="ph-mono"><b>${esc(live ? g.count || "—" : "—")}</b><span>${esc(live && g.outs != null ? `${g.outs} out` : "—")}</span></span>
          </span>
          <span class="ph-gpill-cell">
            <span class="ph-gpill-line">
              <b>${esc(w.team)}</b><span class="ph-mono ph-gpill-num">${esc(w.val)}</span>
              ${this.deltaHtml(w.delta)}
              <span class="ph-mono ph-gpill-from">${esc(w.from)}</span>
            </span>
            <span class="ph-cap ${w.capCls}">${esc(w.caption)}</span>
          </span>
          <span class="ph-gpill-cell">
            <span class="ph-gpill-line"><b>${this.numHtml(t.pick)}</b><span class="ph-mono ph-gpill-num is-dim">${this.pct(t.prob)}</span></span>
            <span class="ph-cap">TOTAL · PREGAME${t.proj == null ? "" : ` · <span class="ph-mono">${t.proj.toFixed(1)}</span> R`}</span>
          </span>
          <span class="ph-gpill-cell">
            ${sr ? `<span class="ph-gpill-line">
                <b class="ph-ellip">${esc(this.shortName(sr.b.name))}</b>
                <span class="ph-gpill-mkt">${sr.m === "hit" ? "1+ Hit" : "1+ HR"}</span>
                <span class="ph-mono ph-gpill-num ph-band-${sr.c.band}">${this.pct(sr.c.p)}</span>
                <span class="ph-mono ph-lift ph-lift--${sr.c.band}">${sr.c.lift}</span>
              </span>` : `<span class="ph-gpill-line"><span class="ph-missing-dash">—</span></span>`}
            <span class="ph-cap">${srCap}</span>
          </span>
          <button class="ph-chev" ${toggle} aria-expanded="${open}">${open ? "▾" : "▸"}</button>
        </div>
        ${open ? this.homePillBodyHtml(g) : ""}
      </div>`;
    }

    // ── the expanded pill ────────────────────────────────────────────────
    homePillBodyHtml(g) {
      const pk = String(g.gamePk);
      const tab = this.state.tab[pk] || "away";
      const srt = this.state.psort[pk] || "lift";
      const tabs = this.segHtml("pillTab", `${pk}|${tab}`, [
        [`${pk}|away`, `${g.away} batters`], [`${pk}|home`, `${g.home} batters`], [`${pk}|sp`, "Starters"],
      ]);
      const sorts = tab === "sp" ? "" : `<span class="ph-sort">
          <span class="ph-kicker ph-kicker--mut">Sort</span>
          ${[["lift", "Lift"], ["order", "Batting order"]].map(([k, l]) => `<button class="ph-chip${srt === k ? " is-on" : ""}" data-act="pillSort" data-arg="${esc(pk)}|${k}">${l}</button>`).join("")}
        </span>`;
      return `<div class="ph-gpill-body">
        ${this.pillMetaGridHtml(g)}
        <div class="ph-gpill-ctrl">
          <span class="ph-kicker">Player game markets</span>
          ${tabs}${sorts}
          <span class="ph-gpill-note">${esc(COPY.marketsNote)}</span>
        </div>
        ${g.phase === "final" ? `<div class="ph-note">${esc(COPY.finalGradedNote)}</div>` : ""}
        ${tab === "sp" ? this.pillStartersTableHtml(g) : this.pillBatterTableHtml(g, tab, srt)}
      </div>`;
    }
    pillMetaGridHtml(g) {
      const c = this.state.gameCtx[String(g.gamePk)] || {};
      const ok = !!c.found;
      const cell = (k, v, kind) => `<span class="ph-meta">
          <span class="ph-meta-k">${k}</span>
          ${v == null ? this.missingHtml(kind || "notserved") : `<span class="ph-mono ph-meta-v">${esc(v)}</span>`}
        </span>`;
      const weather = ok && c.weather_condition
        ? `${c.weather_condition}${c.temp_f == null ? "" : ` · ${c.temp_f}°F`}` : null;
      const wind = ok && c.wind_mph != null ? `${c.wind_mph} mph ${c.wind_direction || ""}`.trim() : null;
      const start = this.clockOf(g.startTs);
      const sps = g.probables.away || g.probables.home
        ? `${this.lastName(g.probables.away)} · ${this.lastName(g.probables.home)}` : null;
      return `<div class="ph-meta-grid">
        ${cell("STADIUM", (ok && c.venue_name) || g.venue || null)}
        ${cell("ROOF", null)}
        ${cell("FIRST PITCH", start ? `${start} ET` : null)}
        ${cell("PROBABLE STARTERS", sps)}
        ${cell("WEATHER", weather)}
        ${cell("WIND", wind)}
        ${cell("HP UMPIRE", ok && c.hp_umpire ? c.hp_umpire : null)}
        ${cell("PARK HR FACTOR", null)}
      </div>`;
    }
    // ── base-model cells ──────────────────────────────────────────────────
    // Values from a base model (supabase/functions/_shared/basemodels.ts:
    // league rates x 30-day form) carry a BASE tag, so a placeholder is never
    // read as a trained model's number. No row renders a plain dash.
    baseTagHtml() { return `<span class="ph-tag ph-tag--base">Base</span>`; }
    baseCellHtml(main, sub) {
      return `<span class="ph-base"><span class="ph-base-top"><b class="ph-mono">${main}</b>${this.baseTagHtml()}</span>${sub ? `<span class="ph-mono ph-base-sub">${sub}</span>` : ""}</span>`;
    }
    // TB 1.5+ ("tb") or H+R+RBI 1+ ("hrr") for one batter.
    baseBatterCellHtml(r, kind) {
      if (!r || r.probability == null) return `<span class="ph-missing-dash">—</span>`;
      const sub = kind === "tb"
        ? (r.expected_value == null ? "" : `exp ${Number(r.expected_value).toFixed(1)} TB`)
        : (r.per_pa_probability == null ? "" : `per-PA ${this.r3(r.per_pa_probability)}`);
      return this.baseCellHtml(this.pct(Number(r.probability)), esc(sub));
    }
    // A starter prop: the line, P(over) and the projected count.
    propCellHtml(r) {
      if (!r || r.line == null) return `<span class="ph-missing-dash">—</span>`;
      return this.baseCellHtml(`O ${Number(r.line)}`,
        `${this.pct(Number(r.probability))} over · exp ${r.expected_value == null ? "—" : Number(r.expected_value).toFixed(1)}`);
    }
    // Rest-of-game entry for a batter in a live game, from /live.
    rogOf(g, playerId) {
      const list = g && g.liveModels && g.liveModels.rest_of_game;
      if (!list || playerId == null) return null;
      return list.find((x) => String(x.player_id) === String(playerId)) || null;
    }
    resultChipHtml(r, g) {
      // `result` absent from the row means the route predates the field;
      // null is pending (never a miss); void is a DNP, excluded from grading.
      if (r === undefined) return this.missingHtml("notserved");
      if (r === null) {
        return g.phase === "pregame" ? `<span class="ph-missing-dash">—</span>`
          : `<span class="ph-res ph-res--pending">pending</span>`;
      }
      if (r === "hit") return `<span class="ph-res ph-res--good">HIT</span>`;
      if (r === "miss") return `<span class="ph-res ph-res--bad">MISS</span>`;
      if (r === "void") return `<span class="ph-res ph-res--dnp">DNP</span>`;
      return `<span class="ph-missing-dash">—</span>`;
    }
    pillBatterTableHtml(g, side, srt) {
      const team = side === "home" ? g.home : g.away;
      let rows = this.battersOf(g.gamePk).filter((b) => b.side === side);
      const pending = !rows.length || rows.every((b) => !b.slot);
      const maxRel = (b) => Math.max(this.probCell(b, "hit").rel || 0, this.probCell(b, "hr").rel || 0);
      rows = srt === "order"
        ? rows.slice().sort((a, b) => (a.slot || 99) - (b.slot || 99))
        : rows.slice().sort((a, b) => maxRel(b) - maxRel(a));
      const pendNote = pending ? `<div class="ph-pending">
          <span class="ph-pending-chip">Lineup pending</span>
          <span>${this.numHtml((rows.length ? COPY.lineupPending : COPY.noProjections).replace("{team}", team))}</span>
        </div>` : "";
      if (!rows.length) return pendNote;
      const res = (b, m) => this.resultChipHtml(b[m] ? b[m].result : null, g);
      const upd = rows.reduce((a, b) => (b.updatedAt && (!a || b.updatedAt > a) ? b.updatedAt : a), null);
      const fresh = g.phase === "pregame"
        ? `PREGAME · updated ${this.clockOf(upd) || "—"} · re-scores until ${pending ? "the lineup locks" : "first pitch"}`
        : g.phase === "live" ? `PREGAME · frozen at first pitch ${this.clockOf(g.startTs) || ""} · rest-of-game not modeled`
          : "FINAL · graded";
      const h2hTxt = (b) => {
        const h = this.h2hOf(b);
        return !h || h.pending ? "—" : h.found ? `${h.h_count}-${h.pa_count}` : "— (&lt;3)";
      };
      const resHtml = (b) => `<span class="ph-res2"><span><span class="ph-res-k">H</span>${res(b, "hit")}</span><span><span class="ph-res-k">HR</span>${res(b, "hr")}</span></span>`;
      if (this.mob()) {
        const cards = rows.map((b) => this.mCardHtml({
          key: `pb:${g.gamePk}:${b.id}`,
          head: `${this.pinBtnHtml("b:" + b.id, "Watch this batter")}
            <span class="ph-mono ph-dim ph-mcard-slot">${b.slot || "—"}</span>
            <span class="ph-bname"><b class="ph-ellip">${esc(b.name || "—")}</b><span class="ph-ellip">vs ${esc(b.spName || "TBD")}</span></span>
            ${g.phase === "pregame" ? "" : resHtml(b)}`,
          stats: `${this.mPairHtml("1+ HIT", this.probCellHtml(b, "hit"))}${this.mPairHtml("1+ HR", this.probCellHtml(b, "hr"))}`,
          more: [
            this.mPairHtml("H+R+RBI 1+", this.baseBatterCellHtml(b.hrr, "hrr")),
            this.mPairHtml("TB 1.5+", this.baseBatterCellHtml(b.tb15, "tb")),
            this.mPairHtml("30D H · HR /PA", this.missingHtml("notserved")),
            this.mPairHtml("H2H", `<span class="ph-mono ph-dim">${h2hTxt(b)}</span>`),
            this.mPairHtml("TODAY", this.missingHtml("notserved")),
          ].join(""),
        })).join("");
        return `${pendNote}<div class="ph-mlist">${cards}
          <div class="ph-btable-foot"><span>${this.numHtml(fresh)}</span><span>${esc(COPY.tickLegend)}</span></div>
        </div>`;
      }
      const hd = ["", "#", "BATTER · VS STARTER", "1+ HIT", "1+ HR", "H+R+RBI 1+", "TB 1.5+", "30D H · HR /PA", "H2H", "TODAY", "RESULT"];
      return `${pendNote}<div class="ph-btable">
        <div class="ph-btable-row ph-btable-head">${hd.map((h) => `<span>${h}</span>`).join("")}</div>
        ${rows.map((b) => {
          const h2h = h2hTxt(b);
          return `<div class="ph-btable-row">
            ${this.pinBtnHtml("b:" + b.id, "Watch this batter")}
            <span class="ph-mono ph-dim">${b.slot || "—"}</span>
            <span class="ph-bname"><b class="ph-ellip">${esc(b.name || "—")}</b><span class="ph-ellip">vs ${esc(b.spName || "TBD")}</span></span>
            ${this.probCellHtml(b, "hit")}
            ${this.probCellHtml(b, "hr")}
            ${this.baseBatterCellHtml(b.hrr, "hrr")}${this.baseBatterCellHtml(b.tb15, "tb")}
            ${this.missingHtml("notserved")}
            <span class="ph-mono ph-dim">${h2h}</span>
            ${this.missingHtml("notserved")}
            ${resHtml(b)}
          </div>`;
        }).join("")}
        <div class="ph-btable-foot"><span>${this.numHtml(fresh)}</span><span>${esc(COPY.tickLegend)}</span></div>
      </div>`;
    }
    // A starter's supporting form: 30-day profile plus the 75–99 pitch
    // fatigue bucket. Every field null until the lazy lookup lands.
    starterStats(id) {
      const v = this.starterOf(id);
      const d30 = v && v.profile && v.profile.found
        ? (v.profile.pitcher || []).find((x) => x.scope === "d30") : null;
      const buckets = (v && v.fatigue && v.fatigue.buckets) || [];
      const b75 = buckets.find((x) => Number(x.pitch_bucket) === 3);
      const num = (x) => (x == null ? null : Number(x));
      return {
        k: num(d30 && d30.k_rate), whiff: num(d30 && d30.whiff_rate),
        velo: num(d30 && d30.avg_fastball_velo),
        fat: num(b75 && b75.velo_delta_vs_bucket0),
      };
    }
    // The ten values after a starter's name, as [label, cell HTML]: five
    // base-model props, then form. The desktop row and the phone card both
    // read this, so they cannot drift apart.
    starterStatPairs(id, pk) {
      const s = this.starterStats(id);
      const props = this.starterProps(pk, id) || {};
      const PROP_LABEL = { pitcher_k: "STRIKEOUTS", pitcher_outs: "OUTS REC.", pitcher_hits: "HITS ALLOWED", pitcher_er: "EARNED RUNS", pitcher_bb: "WALKS" };
      return this.STARTER_MARKETS.map(([m]) => [PROP_LABEL[m], this.propCellHtml(props[m])]).concat([
        ["30D K%", `<span class="ph-mono">${this.pct(s.k)}</span>`],
        ["WHIFF", `<span class="ph-mono">${this.pct(s.whiff)}</span>`],
        ["HR/PA", this.missingHtml("notserved")],
        ["FB VELO", `<span class="ph-mono">${s.velo == null ? "—" : s.velo.toFixed(1)}</span>`],
        ["FATIGUE", `<span class="ph-mono ph-dim">${s.fat == null ? "—" : `${this.signed(s.fat)} mph`}</span>`],
      ]);
    }
    starterCellsHtml(id, pk) {
      return this.starterStatPairs(id, pk).map(([, v]) => v).join("");
    }
    // Phone: a starter as a card — strikeouts and outs up front, the rest of
    // the props and form behind the chevron.
    starterCardHtml(key, nameHtml, id, pk, extra) {
      const pairs = this.starterStatPairs(id, pk);
      return this.mCardHtml({
        key,
        head: `${nameHtml}${extra || ""}`,
        stats: pairs.slice(0, 2).map(([k, v]) => this.mPairHtml(k, v)).join(""),
        more: pairs.slice(2).map(([k, v]) => this.mPairHtml(k, v)).join(""),
      });
    }
    pillStartersTableHtml(g) {
      const start = this.clockOf(g.startTs) || "TBD";
      const sp = (name, id, team, opp) => `<div class="ph-stable-row">
          <span class="ph-bname"><span class="ph-spname"><span class="ph-sp-tag">SP</span><b class="ph-ellip">${esc(name || "TBD")}</b></span><span>${this.numHtml(`${team} vs ${opp} · ${start}`)}</span></span>
          ${this.starterCellsHtml(id, g.gamePk)}
        </div>`;
      if (this.mob()) {
        const card = (side, name, id, team, opp) => this.starterCardHtml(`ps:${g.gamePk}:${side}`,
          `<span class="ph-bname"><span class="ph-spname"><span class="ph-sp-tag">SP</span><b class="ph-ellip">${esc(name || "TBD")}</b></span><span>${this.numHtml(`${team} vs ${opp} · ${start}`)}</span></span>`,
          id, g.gamePk);
        return `<div class="ph-mlist">
          ${card("away", g.probables.away, g.probables.awayId, g.away, g.home)}
          ${card("home", g.probables.home, g.probables.homeId, g.home, g.away)}
          <div class="ph-btable-foot"><span>${this.numHtml(COPY.startersNote)}</span></div>
        </div>`;
      }
      const hd = ["STARTER", "STRIKEOUTS", "OUTS REC.", "HITS ALLOWED", "EARNED RUNS", "WALKS", "30D K%", "WHIFF", "HR/PA", "FB VELO", "FATIGUE"];
      return `<div class="ph-stable">
        <div class="ph-stable-row ph-btable-head">${hd.map((h) => `<span>${h}</span>`).join("")}</div>
        ${sp(g.probables.away, g.probables.awayId, g.away, g.home)}
        ${sp(g.probables.home, g.probables.homeId, g.home, g.away)}
        <div class="ph-btable-foot"><span>${this.numHtml(COPY.startersNote)}</span></div>
      </div>`;
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

    // ── phone cards ──────────────────────────────────────────────────────
    // Under mob() a wide table row becomes a card: a head line, the few
    // numbers a reader compares, and everything else behind a chevron. One
    // shape for every table, so the tabs read alike on a phone.
    mCardHtml({ key, head, stats, more, cls }) {
      const open = !!this.state.mOpen[key];
      const chev = more ? `<button class="ph-chev ph-mcard-chev" data-act="mToggle" data-arg="${esc(key)}" aria-expanded="${open}" aria-label="${open ? "Show less" : "Show more"}">${open ? "▾" : "▸"}</button>` : "";
      return `<div class="ph-mcard${cls ? ` ${cls}` : ""}">
        <div class="ph-mcard-head">${head}${chev}</div>
        ${stats ? `<div class="ph-mcard-stats">${stats}</div>` : ""}
        ${more && open ? `<div class="ph-mcard-more">${more}</div>` : ""}
      </div>`;
    }
    // A label over a value (HTML) — the cells of a card's stat row and of
    // its expanded grid.
    mPairHtml(k, v) { return `<span class="ph-meta"><span class="ph-meta-k">${k}</span>${v}</span>`; }

    // ── small shared pieces ──────────────────────────────────────────────
    shortName(n) {
      const parts = String(n || "").trim().split(/\s+/);
      if (parts.length < 2) return n || "—";
      return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
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









    // Just the clock, and just the countdown — the pill puts them in different
    // cells (chip and sub-line), so firstPitch()'s combined string is no use.
    clockOf(ts) {
      const t = Date.parse(ts || "");
      return isFinite(t)
        ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: ET })
        : null;
    }
    untilText(ts) {
      const t = Date.parse(ts || "");
      if (!isFinite(t)) return null;
      const mins = Math.round((t - Date.now()) / 60000);
      if (mins <= 0) return "starting";
      if (mins < 60) return `in ${mins}m`;
      return `in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
    }
    // /live carries the half as ▲/▼; the pill's status chip spells it.
    halfWord(half) { return half === "▼" ? "BOT" : half === "▲" ? "TOP" : ""; }

    // Status chip: the inning for a live game, FINAL, or the first-pitch clock.
    slateChipHtml(g, mobile) {
      const C = this.C;
      let text, fg, bg;
      if (g.phase === "live") {
        const inn = g.inning == null ? "LIVE" : `${this.halfWord(g.half)} ${g.inning}`.trim();
        text = `● ${inn}`; fg = C.grn; bg = "rgba(74,222,128,.13)";
      } else if (g.phase === "final") {
        text = "FINAL"; fg = C.mut; bg = C.chip;
      } else {
        text = this.clockOf(g.startTs) || "TBD"; fg = C.blue; bg = "#16294a";
      }
      return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:${mobile ? 9.5 : 10}px;font-weight:800;letter-spacing:.05em;padding:${mobile ? "2px 6px" : "3px 7px"};border-radius:${mobile ? 5 : 6}px;justify-self:start;white-space:nowrap;color:${fg};background:${bg};">${this.numHtml(text)}</span>`;
    }

    // The bases diamond. Every base renders empty, and says why: /live carries
    // no runners (pitchhawk-data.js hard-codes all three false), so a filled
    // base would be an invention and an unmarked empty one a false claim.
    basesHtml(mobile) {
      const C = this.C;
      const box = mobile ? { w: 28, h: 21, s: 9, o: 10, l: 18, m: 9 } : { w: 32, h: 24, s: 10, o: 11, l: 21, m: 11 };
      const base = (top, left) =>
        `<span style="position:absolute;top:${top}px;left:${left}px;width:${box.s}px;height:${box.s}px;transform:rotate(45deg);border:1px solid ${C.bd2};border-radius:2px;background:transparent;"></span>`;
      return `<span title="${esc(COPY.runnersNote)}" style="position:relative;width:${box.w}px;height:${box.h}px;flex:none;display:block;">
        ${base(0, box.m)}${base(box.o, mobile ? 0 : 1)}${base(box.o, box.l)}
      </span>`;
    }

    totPickOf(mkt) {
      const rec = mkt && mkt.recommendation;
      if (!rec) return { pick: "—", prob: null };
      const side = rec === "over" ? "O" : rec === "under" ? "U" : this.outLabel(rec) || "—";
      const line = mkt.line == null ? "" : ` ${Number(mkt.line)}`;
      return { pick: `${side}${line}`, prob: mkt.modelProb };
    }
    // ── the metadata tier ────────────────────────────────────────────────
    // Written by the nightly warehouse publish, so today's games legitimately
    // have none. Absent renders as dashes with the note below — never as a
    // spinner, because there is nothing on the way.
    async loadGameContext(pk) {
      const key = String(pk);
      if (this.state.gameCtx[key]) return;   // fetched, or already in flight
      this.state.gameCtx = Object.assign({}, this.state.gameCtx, { [key]: { pending: true } });
      const row = await fetchJson(`/game/${key}/context`);
      this.setState({
        gameCtx: Object.assign({}, this.state.gameCtx, {
          [key]: row ? Object.assign({}, row, { pending: false }) : { pending: false, err: true },
        }),
      });
    }
    // Bring a game's pill into the viewport after jumping to the Live Feed.
    // scrollIntoView is banned here (it hijacks the scroll container and
    // fights the poll's re-render), so the offset is measured and set.
    scrollToPill(pk) {
      requestAnimationFrame(() => {
        // Selector is scoped to <main>: a Watching pill for the same game
        // must not be the one scrolled to. 80px clears the sticky header.
        const el = this.root.querySelector(`main [data-ph-pill="${pk}"]`);
        if (!el) return;
        window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.pageYOffset - 80));
      });
    }




    // ══ LIVE BOARD (1b mobile · 1c desktop) ══════════════════════════════
    // ══ FEED REDESIGN ════════════════════════════════════════════════════
    // Both tabs are the same three-level drill-down — game, at-bat, pitch —
    // over the same shape. The Live Feed puts a hero on top of it and reads
    // today; the Data Feed puts KPIs and charts on top of it and reads one
    // retained day at a time. Everything below is shared.

    // The markets the product prices per pitch and per at-bat. Game-level
    // markets are deliberately absent: they have no at-bat to hang off, and
    // asking the server for them means paging rows the drill-down discards.
    MICRO = ["pitch_speed_ou", "pitch_result", "ab_result", "ab_pitches_ou"];

    // ── row store, keyed by date ─────────────────────────────────────────
    // Every micro-market prediction for one slate, fetched a GAME at a time
    // and cached per date.
    //
    // Per date matters: the Live Feed is always about today, while the Data
    // Feed walks the retained window. Holding one "current day" between them
    // meant stepping the Data Feed back to Friday and returning to the Live
    // Feed showed Friday's games under the heading "Today's games".
    //
    // Per game matters too. Measured on the real 15-game slate of 2026-08-18:
    // paging the whole day as one stream is 15 requests, 14,000 rows and 34
    // seconds; per game at four at a time is 7.3 seconds with the first pill up
    // at 3.2. And because /pitches returns newest-id first, per game is the
    // only one that can paint early *honestly* — a game is spliced in when all
    // of its rows are present, so every pill on screen is right the moment it
    // appears. A half-loaded day-stream holds half of every game and would
    // report an accuracy for each that is simply wrong until the last page.
    DAY_CACHE = 3;
    EMPTY_DAY = { rows: [], loaded: false, err: false, partial: false, pending: 0 };

    // The date a view is about. The Live Feed is today by definition; the Data
    // Feed is wherever its stepper has been left.
    // The date a view's ROW-derived surfaces are about. Both tabs are now
    // today: the Data Feed's history is a window of day pills, each of which
    // owns its own date, and its KPI/chart surfaces say which days they cover
    // rather than silently following a stepper.
    viewDate() { return PH.mlbDate(0); }

    dayState(date) { return this.state.days[date] || this.EMPTY_DAY; }
    setDay(date, patch) {
      const next = Object.assign({}, this.dayState(date), patch);
      const days = Object.assign({}, this.state.days, { [date]: next });
      // A slate is several MB of rows, so old dates are dropped rather than
      // accumulated. Insertion order is date order closely enough.
      const keys = Object.keys(days);
      if (keys.length > this.DAY_CACHE) {
        keys.slice(0, keys.length - this.DAY_CACHE).forEach((k) => {
          if (k === date || k === PH.mlbDate(0)) return;
          delete days[k];
          // The fetch gate and the built models have to go with the rows.
          // Without this an evicted day stayed "already fetched" forever, so
          // re-opening its pill in the history showed an empty slate rather
          // than reloading it.
          delete this._dayRowsSig[k];
          delete this._models[k];
        });
      }
      this.state.days = days;
      return next;
    }

    async loadDayRows(date, force) {
      const want = date || PH.mlbDate(0);
      if (!force && this._dayRowsSig[want]) return false;
      this._dayRowsSig[want] = true;
      // A slow game from a superseded run must not land over a newer one.
      const seq = (this._dayRowsSeq[want] = (this._dayRowsSeq[want] || 0) + 1);
      const stale = () => seq !== this._dayRowsSeq[want];

      // The slate has to be known before its games can be fetched, and known
      // for real — not read half-written while /board is in flight. When the
      // live poll already knows it, though, /board (~2s measured) is kept off
      // the critical path: it only adds scores, which land later.
      let metaOk = true;
      if (this.slateFor(want).length) this.loadDayMeta(want).catch(() => {});
      else metaOk = await this.loadDayMeta(want).catch(() => false);
      if (stale()) return false;

      const slate = this.slateFor(want);
      if (!slate.length) {
        // An empty slate we could not fetch is an outage, not a quiet day.
        this.setDay(want, { rows: [], loaded: true, err: !metaOk, partial: false, pending: 0 });
        delete this._models[want];
        return true;
      }

      // Start from nothing for this date and paint the shell immediately, so
      // the tab shows progress rather than a bare spinner.
      this.setDay(want, {
        rows: [], loaded: true, err: false, partial: false, pending: slate.length,
      });
      delete this._models[want];

      // Live games first: they are what the hero drills into and what a reader
      // opening the tab mid-slate is looking at.
      const rank = (g) => (g.phase === "live" ? 0 : g.phase === "final" ? 1 : 2);
      const queue = slate.slice().sort((a, b) => rank(a) - rank(b));
      const CONCURRENCY = 4;
      let errs = 0;

      const worker = async () => {
        for (;;) {
          const g = queue.shift();
          if (!g || stale()) return;
          try {
            const rows = await PH.loadGamePitches(API_BASE, g.gamePk, want, null, this.MICRO);
            if (stale()) return;
            this.spliceGameRows(want, g.gamePk, rows);
          } catch (_e) {
            errs += 1;
          }
          if (stale()) return;
          this.setDay(want, {
            pending: Math.max(0, (this.dayState(want).pending || 1) - 1),
          });
          this.render();
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
      );
      if (stale()) return false;

      this.setDay(want, {
        pending: 0,
        // Every game failing is an outage; one failing is a gap, and the rest
        // of the slate is still worth showing.
        err: errs === slate.length,
        partial: errs > 0 && errs < slate.length,
      });
      return true;
    }

    // Replace one game's rows wholesale, and drop that date's built models —
    // a game is never half-updated.
    spliceGameRows(date, gamePk, rows) {
      const keep = (this.dayState(date).rows || []).filter((r) => r.game_pk !== gamePk);
      this.setDay(date, { rows: keep.concat(rows || []) });
      delete this._models[date];
    }

    // The slate for a date: today's comes from the live poll, which is fresher;
    // any other date from the /board call in loadDayMeta.
    slateFor(date) {
      if (date === PH.mlbDate(0) && (PH.games || []).length) return this.slateGames();
      const meta = this.state.dayMeta[date];
      return meta || [];
    }

    // Score, status and inning are not on prediction rows, so the pills get
    // them from the slate. Today that is the live poll; a past date has no
    // live slate, so /board is asked for that day's games once.
    async loadDayMeta(date) {
      const want = date || PH.mlbDate(0);
      if (this._dayMetaSig === want && this._dayMetaP) return this._dayMetaP;
      this._dayMetaSig = want;
      // Only one date's /board is ever in flight; a second date supersedes it,
      // which is fine because its games are cached under their own key.
      this._dayMetaP = (async () => {
        try {
          const bd = await PH.loadBoard(API_BASE, null, want);
          this.state.dayMeta = Object.assign({}, this.state.dayMeta, {
            [want]: [].concat(bd.live || [], bd.upcoming || [], bd.final || []),
          });
          return true;
        } catch (_e) {
          this.state.dayMeta = Object.assign({}, this.state.dayMeta, { [want]: [] });
          return false;
        }
      })();
      return this._dayMetaP;
    }

    // Per-day, per-market accuracy for the trend chart. Rolled up nightly and
    // never pruned, so it is the one series that outlives the 21-day
    // raw-prediction horizon everything else on this tab is bounded by.
    // Fetched once for the widest window the server allows, not per window
    // chip. It is one row per (day, market) — a few hundred for four months —
    // so re-requesting it every time the reader changes the window was pure
    // latency, and holding the whole span is what lets the tab tell "nothing
    // was graded in these days" apart from "the nightly rollup has not run for
    // them yet".
    ACC_SPAN_DAYS = 120;
    async loadAccuracy() {
      const to = PH.mlbDate(0);
      const from = PH.mlbDate(-(this.ACC_SPAN_DAYS - 1));
      const sig = `${from}..${to}`;
      if (this._accSig === sig) return false;
      this._accSig = sig;
      try {
        const res = await PH.loadAccuracy(API_BASE, { from, to });
        this.state.accuracy = {
          days: res.days || [], markets: res.markets || [], loaded: true, err: false,
        };
        return true;
      } catch (_e) {
        this.state.accuracy = Object.assign({}, this.state.accuracy, {
          loaded: true, err: true,
        });
        return true;
      }
    }

    // What actually changed about a live game. Without this the poll refetches
    // ~1,200 rows per live game every 8 seconds for no new data.
    gameSig(g) {
      return `${g.inning}:${g.half}:${g.count}:${g.outs}:${g.pitchCountPa}:${g.phase}`;
    }
    // Re-pull only the games that moved and splice them back over the day's
    // rows. Finished and scheduled games never move, and a past date never
    // moves at all.
    async refreshLiveRows() {
      const today = PH.mlbDate(0);
      const dr = this.dayState(today);
      if (!dr.loaded || dr.err) return false;
      const sigs = this._liveRowSig || (this._liveRowSig = {});
      const stale = this.liveGames().filter((g) => sigs[g.gamePk] !== this.gameSig(g));
      if (!stale.length) return false;
      let changed = false;
      for (const g of stale) {
        try {
          const rows = await PH.loadGamePitches(API_BASE, g.gamePk, today, null, this.MICRO);
          sigs[g.gamePk] = this.gameSig(g);
          this.spliceGameRows(today, g.gamePk, rows);
          changed = true;
        } catch (_e) { /* keep this game's last-good rows */ }
      }
      return changed;
    }

    // ── shaping ──────────────────────────────────────────────────────────
    // Rebuilding ~11k rows into a game tree on every render — every poll, every
    // click — is the difference between a board that feels instant and one that
    // stutters. Keyed on the rows array's identity, which every mutation above
    // replaces.
    models(date) {
      const d = date || this.viewDate();
      const rows = this.dayState(d).rows || [];
      const hit = this._models[d];
      if (hit && hit.rows === rows) return hit.models;
      const built = rows.length ? this.buildGameModels(rows) : [];
      this._models[d] = { rows, models: built };
      return built;
    }

    // Server rows -> the game / at-bat / pitch tree both feeds drill through.
    //
    // This is the ONLY place backend field names appear. One prediction row is
    // one (position, market) pair, not one pitch: a thrown pitch produces a
    // `pitch_speed_ou` row AND a `pitch_result` row, and its at-bat adds
    // `ab_result` and `ab_pitches_ou`. `pitch_number` is a POSITION — the row
    // at k is the call made INTO pitch k+1 — which is why the displayed pitch
    // number is k+1 and the pitch count is max(k)+1.
    buildGameModels(rows) {
      const byGame = new Map();
      (rows || []).forEach((r) => {
        if (!r || r.game_pk == null || r.at_bat_index == null) return;
        let g = byGame.get(r.game_pk);
        if (!g) {
          g = { pk: r.game_pk, label: r.game_label || null, abs: new Map() };
          byGame.set(r.game_pk, g);
        }
        if (!g.label && r.game_label) g.label = r.game_label;
        let ab = g.abs.get(r.at_bat_index);
        if (!ab) { ab = { abi: r.at_bat_index, rows: [] }; g.abs.set(r.at_bat_index, ab); }
        ab.rows.push(r);
      });
      return [...byGame.values()]
        .map((g) => this.buildGame(g))
        .sort((a, b) => a.gamePk - b.gamePk);
    }

    buildGame(raw) {
      // `game_label` is "AWAY @ HOME" in abbreviations, and it is the only
      // place a prediction row names the teams. The batting side is derived
      // from it plus `half` — there is no batting_team field on any API row.
      const parts = String(raw.label || "").split(" @ ");
      const away = (parts[0] || "").trim() || "AWY";
      const home = (parts[1] || "").trim() || "HOM";

      const abs = [...raw.abs.values()]
        .sort((a, b) => a.abi - b.abi)
        .map((ab) => this.buildAb(ab, away, home));

      // Cumulative pitcher workload, walking the game in order. Not a server
      // field, and the velo-by-workload chart is plotted against it.
      const pcBy = {};
      abs.forEach((ab) => ab.pitches.forEach((p) => {
        const k = p.pitcherId == null ? "?" : p.pitcherId;
        pcBy[k] = (pcBy[k] || 0) + 1;
        p.pc = pcBy[k];
      }));

      return {
        pk: String(raw.pk), gamePk: raw.pk, away, home,
        label: raw.label || `${away} @ ${home}`, abs,
      };
    }

    buildAb(ab, away, home) {
      const of = (m) => ab.rows.filter((r) => r.market === m);
      const cls = of("pitch_result");
      const velo = of("pitch_speed_ou");
      const abr = of("ab_result")[0] || null;
      const abp = of("ab_pitches_ou")[0] || null;

      // The situation is joined per row, and a row whose pitch could not be
      // joined carries nulls (see the pitch_number=0 note in pitchfeed.ts), so
      // identity and inning are taken from the first row that actually has
      // them rather than from a fixed row that might not.
      const pick = (f) => {
        const hit = ab.rows.find((r) => r[f] != null);
        return hit ? hit[f] : null;
      };

      const clsBy = new Map(cls.map((r) => [r.pitch_number, r]));
      const veloBy = new Map(velo.map((r) => [r.pitch_number, r]));
      const positions = [...new Set(
        cls.concat(velo).map((r) => r.pitch_number).filter((n) => n != null),
      )].sort((a, b) => a - b);

      const pitches = positions.map((k) => {
        const cr = clsBy.get(k) || null;
        const vr = veloBy.get(k) || null;
        const sit = cr || vr || {};
        // `error` is signed predicted − actual, so the delta a reader wants —
        // how far the pitch came in above or below the call — is its negation.
        const err = vr && vr.error != null ? +vr.error : null;
        return {
          n: k + 1,
          count: sit.count || null,
          type: sit.actual_pitch_type || null,
          predVelo: vr && vr.predicted_value != null ? +vr.predicted_value : null,
          velo: vr && vr.actual_value != null ? +vr.actual_value : null,
          delta: err == null ? null : -err,
          err,
          predResult: cr ? cr.recommendation : null,
          predProb: cr && cr.confidence != null ? +cr.confidence : null,
          result: cr ? cr.actual_label : null,
          // null, never false, while unsettled: an ungraded call must not
          // render as a miss.
          ok: cr && cr.result != null ? cr.result === "win" : null,
          back: !!((cr && cr.backfilled_at) || (vr && vr.backfilled_at)),
          pitcherId: sit.pitcher_id != null ? sit.pitcher_id : null,
          pc: null,
        };
      });

      const inning = pick("inning");
      const half = pick("half");
      return {
        abi: ab.abi,
        inning, half,
        inn: inning == null ? "—" : `${half === "▼" ? "B" : "T"}${inning}`,
        // Top of the inning is the away side batting.
        team: half == null ? null : half === "▼" ? home : away,
        batter: pick("batter_name"),
        pitcher: pick("pitcher_name"),
        // Player ids ride along with the names; lookups keyed on player_id
        // (profiles, head-to-head) need them.
        batterId: pick("batter_id"),
        pitcherId: pick("pitcher_id"),
        predLabel: abr ? abr.recommendation : null,
        predProb: abr && abr.confidence != null ? +abr.confidence : null,
        actual: abr ? abr.actual_label : null,
        ok: abr && abr.result != null ? abr.result === "win" : null,
        back: !!(abr && abr.backfilled_at),
        projPitches: abp && abp.predicted_value != null ? +abp.predicted_value : null,
        actPitches: positions.length ? positions[positions.length - 1] + 1 : 0,
        pitches,
      };
    }

    // ── stats ────────────────────────────────────────────────────────────
    // Graded only, on both levels. A call with no result has no outcome to
    // score, and leaving it in the denominator reports the model as wrong for
    // being unsettled.
    abStats(ab) {
      let c = 0, n = 0, es = 0, en = 0;
      (ab.pitches || []).forEach((p) => {
        if (p.ok != null) { n += 1; if (p.ok) c += 1; }
        if (p.err != null) { es += Math.abs(p.err); en += 1; }
      });
      return { c, n, mae: en ? es / en : null, maeN: en };
    }
    gameStats(abs) {
      let abC = 0, abN = 0, pC = 0, pN = 0, es = 0, en = 0;
      (abs || []).forEach((ab) => {
        if (ab.ok != null) { abN += 1; if (ab.ok) abC += 1; }
        const s = this.abStats(ab);
        pC += s.c; pN += s.n;
        es += (s.mae || 0) * s.maeN; en += s.maeN;
      });
      return { abC, abN, pC, pN, mae: en ? es / en : null };
    }

    // ── small formatters ─────────────────────────────────────────────────
    // Every record the board prints carries its own percentage, in the same
    // mono face and the same accuracy colour as the ratio: "14/19 · 74%". One
    // helper, used at every site, so the rounding and the em-dash rule cannot
    // drift between two surfaces. The bare `ratio()` this replaced is gone —
    // a record without its rate made the reader do the division.
    ratioPct(c, n) {
      if (!n) return "—";
      return `${c}/${n} · ${Math.round((c / n) * 100)}%`;
    }
    accBand(r) { return r == null ? null : r >= 0.66 ? "good" : r >= 0.5 ? "amber" : "bad"; }
    outLabel(k) { return k == null ? null : (PH.OUTCOME_LABEL[k] || k); }
    signed(v, d) {
      if (v == null) return "—";
      return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d == null ? 1 : d)}`;
    }











    // ══ LIVE (2026-09 redesign) ══════════════════════════════════════════
    // One live game at a time: the model's read on the next pitch and on how
    // the at-bat ends, the pitch-by-pitch log of this at-bat, a rail for the
    // batter, the pitcher and the game, then every other live game.
    liveHtml() {
      const live = this.liveGames();
      if (!live.length) return this.liveEmptyHtml();
      const sel = this.liveSelGame();
      // Phone: one column, interleaved so what a second-screen reader glances
      // at most (the call, the batter, this at-bat) comes first.
      if (this.mob()) {
        return `${this.showingChipsHtml(live, sel)}
          <div class="ph-live-grid">
            ${this.liveHeroHtml(sel.g, sel.top, live.length)}
            ${this.railPlateHtml(sel.g)}
            ${this.pitchLogHtml(sel.g)}
            ${this.railPitchingHtml(sel.g)}
            ${this.railGameHtml(sel.g)}
          </div>
          ${this.otherLiveHtml(live, sel.g)}`;
      }
      return `${this.showingChipsHtml(live, sel)}
        <div class="ph-live-grid">
          <div class="ph-live-main">
            ${this.liveHeroHtml(sel.g, sel.top, live.length)}
            ${this.pitchLogHtml(sel.g)}
          </div>
          <div class="ph-live-rail">
            ${this.railPlateHtml(sel.g)}
            ${this.railPitchingHtml(sel.g)}
            ${this.railGameHtml(sel.g)}
          </div>
        </div>
        ${this.otherLiveHtml(live, sel.g)}`;
    }

    // "top" is the most confident open call across every live game; a
    // game_pk pins the view to that game. A pinned game that has ended falls
    // back to "top" rather than stranding the reader on a finished game.
    liveSelGame() {
      const live = this.liveGames();
      const sel = this.state.liveSel;
      if (sel && sel !== "top") {
        const g = live.find((x) => String(x.gamePk) === String(sel));
        if (g) return { g, top: false };
      }
      let best = null;
      live.forEach((g) => {
        const c = this.topCallOf(g);
        if (c && (!best || c.p > best.p)) best = { g, p: c.p };
      });
      return { g: best ? best.g : live[0], top: true };
    }

    // ── SHOWING ──────────────────────────────────────────────────────────
    showingChipsHtml(live, sel) {
      const cur = sel.top ? "top" : String(sel.g.gamePk);
      const chip = (arg, label, sub) => `<button class="ph-chip ph-chip--lg${cur === arg ? " is-on" : ""}" data-act="liveSel" data-arg="${esc(arg)}">${this.numHtml(label)}${sub ? ` <span class="ph-mono">${esc(sub)}</span>` : ""}</button>`;
      return `<div class="ph-showing">
        <span class="ph-kicker ph-kicker--mut">Showing</span>
        ${chip("top", "★ Top call now", "")}
        ${live.map((g) => chip(String(g.gamePk), `${g.away} ${g.score.away}–${g.score.home} ${g.home}`,
          `${g.half}${g.inning == null ? "" : g.inning}`)).join("")}
      </div>`;
    }

    // ── hero ─────────────────────────────────────────────────────────────
    // Port of dist(): outcome rows, strongest first, against the league rate.
    distRows(probs, league) {
      const keys = Object.keys(probs || {}).filter((k) => probs[k] != null);
      if (!keys.length) return { rec: null, rows: [] };
      keys.sort((a, b) => probs[b] - probs[a]);
      return {
        rec: keys[0],
        rows: keys.map((k) => ({ k, p: Number(probs[k]), lg: league[k] == null ? null : league[k], rec: k === keys[0] })),
      };
    }
    distHtml(title, d) {
      if (!d.rec) {
        return `<div class="ph-dist"><span class="ph-hero-k">${esc(title)}</span>
          <span class="ph-dist-call"><b>—</b></span>
          <span class="ph-hero-note">${esc(COPY.heroNoCallInGame)}</span></div>`;
      }
      const top = d.rows[0];
      return `<div class="ph-dist">
        <span class="ph-hero-k">${esc(title)}</span>
        <span class="ph-dist-call"><b>${esc(this.outLabel(top.k))}</b><span class="ph-mono">${this.pct(top.p)}</span></span>
        ${d.rows.map((r) => `<div class="ph-dist-row">
            <span>${esc(this.outLabel(r.k))}</span>
            <span class="ph-dist-track"><span class="ph-dist-fill${r.rec ? " is-rec" : ""}" style="width:${(r.p * 100).toFixed(1)}%"></span></span>
            <span class="ph-mono ph-dist-p">${this.pct(r.p)}</span>
            <span class="ph-mono ph-dist-lg">lg ${this.pct(r.lg)}</span>
          </div>`).join("")}
      </div>`;
    }
    // "O 93.5 · 55%" for an over/under market, or a dash.
    ouLine(mk) {
      if (!mk || !mk.recommendation || mk.line == null) return "—";
      const side = mk.recommendation === "over" ? "O" : mk.recommendation === "under" ? "U" : mk.recommendation;
      return `${side} ${Number(mk.line)} · ${this.pct(mk.modelProb)}`;
    }
    gameCallStats(g) {
      const m = this.models().find((x) => String(x.pk) === String(g.gamePk));
      return m ? this.gameStats(m.abs) : null;
    }
    liveHeroHtml(g, top, nLive) {
      const sit = `${g.away} ${g.score.away} @ ${g.home} ${g.score.home} · ${g.half}${g.inning == null ? "—" : g.inning} · ${g.count || "—"} · ${g.outs == null ? "—" : g.outs} out · bases —`;
      const side = g.half === "▲" ? "away" : "home";
      const b = this.battersOf(g.gamePk).find((x) => g.batter && x.id === String(g.batter.id));
      const bMeta = [g.batter.hand ? `(${g.batter.hand})` : null, side === "home" ? g.home : g.away, b && b.slot ? `#${b.slot}` : null].filter(Boolean).join(" · ");
      const spd = g.m && g.m.pitch_speed_ou, abp = g.m && g.m.ab_pitches_ou;
      const st = this.gameCallStats(g);
      const tone = (c, n) => (n ? `ph-tone-${this.accBand(c / n)}` : "");
      const tile = (v, s, l, cls) => `<div class="ph-hero-tile">
          <span class="ph-mono ph-hero-tile-v ${cls || ""}">${v}</span>
          <span class="ph-mono ph-hero-tile-s">${s}</span>
          <span class="ph-hero-k">${esc(l)}</span>
        </div>`;
      const upd = this.clockSec(this.state.api.updatedAt);
      return `<div class="ph-hero">
        <div class="ph-hero-head">
          <span class="ph-hero-badge"><span class="ph-dot is-live ph-dot-sm"></span>${top ? "TOP CALL NOW · ALL GAMES" : "SELECTED GAME"}</span>
          <span class="ph-mono ph-hero-sit">${esc(sit)} ${this.tagHtml("notserved")}</span>
          <span class="ph-mono ph-hero-upd">updated <span class="${this.flashIf(`live:${g.gamePk}`, g.lastPitch)}">${esc(upd || "—")}</span></span>
        </div>
        <div class="ph-hero-who">
          <b class="ph-hero-bat">${esc(g.batter.name)}</b><span class="ph-mono">${this.numHtml(bMeta)}</span>
          <span class="ph-hero-vs">vs</span>
          <b class="ph-hero-pit">${esc(g.pitcher.name)}</b><span class="ph-mono">${g.pitcher.hand ? `(${esc(g.pitcher.hand)})` : ""}</span>
          <span class="ph-hero-note">${top ? this.numHtml(`highest call of ${nLive} live at-bat${nLive === 1 ? "" : "s"}`) : "the open at-bat in this game"}</span>
        </div>
        <div class="ph-hero-dists">
          ${this.distHtml("NEXT PITCH", this.distRows(g.m && g.m.pitch_result && g.m.pitch_result.probs, this.LEAGUE_PITCH))}
          ${this.distHtml("HOW THIS AT-BAT ENDS", this.distRows(g.m && g.m.ab_result && g.m.ab_result.probs, this.LEAGUE_AB))}
        </div>
        <div class="ph-hero-tiles">
          ${tile(spd && spd.predictedValue != null ? `${Number(spd.predictedValue).toFixed(1)} mph` : "—", esc(this.ouLine(spd)), "VELO CALL · NEXT PITCH")}
          ${tile(abp && abp.predictedValue != null ? Number(abp.predictedValue).toFixed(1) : "—", esc(this.ouLine(abp)), "PITCHES IN THIS AT-BAT")}
          ${tile(st ? esc(this.ratioPct(st.abC, st.abN)) : "—", "graded at-bats", "AT-BAT CALLS THIS GAME", st && tone(st.abC, st.abN))}
          ${tile(st ? esc(this.ratioPct(st.pC, st.pN)) : "—", `velo MAE ${st && st.mae != null ? `${st.mae.toFixed(1)} mph` : "—"}`, "PITCH CALLS THIS GAME", st && tone(st.pC, st.pN))}
        </div>
      </div>`;
    }

    // ── pitch-by-pitch ───────────────────────────────────────────────────
    // This at-bat from /live, each pitch paired with the call made before it,
    // then the pending call on the next pitch. The count is walked forward
    // from 0-0 so each row shows the count the pitch was thrown in.
    pitchLog(g) {
      let b = 0, s = 0, called = 0, graded = 0, err = 0, errN = 0;
      const rows = (g.pitches || []).map((pt, i) => {
        const count = `${b}-${s}`;
        if (pt.cat === "ball") b += 1; else if (pt.cat === "strike_foul" && s < 2) s += 1;
        const pr = pt.pred || {};
        const d = pr.speed != null && pt.speed != null ? pt.speed - pr.speed : null;
        if (d != null) { err += Math.abs(d); errN += 1; }
        if (pr.resultOk != null) { graded += 1; if (pr.resultOk) called += 1; }
        return {
          n: i + 1, count, type: pt.type, speed: pt.speed, call: pr.speed, d,
          callCat: pr.resultCat, callP: pr.resultProb, result: pt.cat, ok: pr.resultOk,
        };
      });
      const nx = g.nextPred || {};
      rows.push({
        n: rows.length + 1, count: g.count || `${b}-${s}`, type: null, speed: null, call: nx.speed == null ? null : nx.speed,
        d: null, callCat: nx.resultCat || null, callP: nx.resultProb == null ? null : nx.resultProb, result: null, ok: null, next: true,
      });
      return { rows, called, graded, mae: errN ? err / errN : null };
    }
    pitchLogHtml(g) {
      const log = this.pitchLog(g);
      const v = (x) => (x == null ? "—" : Number(x).toFixed(1));
      const body = log.rows.map((r) => {
        const band = this.veloBand(r.d);
        const grade = r.next ? `<span class="ph-res ph-res--pending">PENDING</span>`
          : r.ok === true ? `<span class="ph-res ph-res--good">✓ CALLED</span>`
            : r.ok === false ? `<span class="ph-res ph-res--bad">✗ MISSED</span>`
              : `<span class="ph-missing-dash">—</span>`;
        const edge = r.next ? "is-next" : r.ok === true ? "is-good" : r.ok === false ? "is-bad" : "";
        if (this.mob()) {
          return `<div class="ph-plog-row ph-plog-row--m ${edge}">
            <span class="ph-plog-l1">
              <span class="ph-mono ph-dim">${r.n}</span>
              <span class="ph-mono">${esc(r.count)}</span>
              ${r.type ? `<span class="ph-mono ph-ptype" style="color:${this.pitchColor(r.type)}">${esc(r.type)}</span>` : `<span class="ph-missing-dash">—</span>`}
              <span class="ph-mono ph-nowrap"><span class="ph-dim">${v(r.call)}</span> → <b>${r.next ? "—" : v(r.speed)}</b></span>
              ${r.d == null ? "" : `<span class="ph-mono ph-vd ph-vd--${band}">${r.d >= 0 ? "+" : "−"}${Math.abs(r.d).toFixed(1)}</span>`}
              <span class="ph-plog-grade">${grade}</span>
            </span>
            <span class="ph-plog-l2">
              <span>call <b>${esc(this.outLabel(r.callCat) || "—")}</b> <span class="ph-mono ph-dim">${this.pct(r.callP)}</span></span>
              <span class="ph-dim">${r.next ? "next pitch" : esc(this.outLabel(r.result) || "—")}</span>
            </span>
          </div>`;
        }
        return `<div class="ph-plog-row ${edge}">
          <span class="ph-mono ph-dim">${r.n}</span>
          <span class="ph-mono">${esc(r.count)}</span>
          ${r.type ? `<span class="ph-mono ph-ptype" style="color:${this.pitchColor(r.type)}">${esc(r.type)}</span>` : `<span class="ph-missing-dash">—</span>`}
          <span class="ph-mono ph-nowrap"><span class="ph-dim">${v(r.call)}</span> → <b>${r.next ? "—" : v(r.speed)}</b></span>
          ${r.d == null ? `<span class="ph-missing-dash">—</span>` : `<span class="ph-mono ph-vd ph-vd--${band}">${r.d >= 0 ? "+" : "−"}${Math.abs(r.d).toFixed(1)}</span>`}
          <span><b>${esc(this.outLabel(r.callCat) || "—")}</b> <span class="ph-mono ph-dim">${this.pct(r.callP)}</span></span>
          <span class="ph-dim">${r.next ? "next pitch" : esc(this.outLabel(r.result) || "—")}</span>
          ${grade}
        </div>`;
      }).join("");
      const sum = `pitch ${this.ratioPct(log.called, log.graded)} · MAE ${log.mae == null ? "—" : log.mae.toFixed(1)} · pending calls never count as misses`;
      return `<div class="ph-panel">
        <div class="ph-panel-head">
          <span class="ph-kicker">Pitch-by-pitch · this at-bat</span>
          <span class="ph-mono ph-panel-note">${esc(sum)}</span>
        </div>
        ${this.mob() ? "" : `<div class="ph-plog-row ph-btable-head"><span>#</span><span>COUNT</span><span>TYPE</span><span>VELO CALLED → ACTUAL</span><span>Δ</span><span>CALL</span><span>RESULT</span><span>GRADE</span></div>`}
        ${body}
      </div>`;
    }

    // ── rail ─────────────────────────────────────────────────────────────
    railPlateHtml(g) {
      const b = this.battersOf(g.gamePk).find((x) => g.batter && x.id === String(g.batter.id));
      const side = g.half === "▲" ? g.away : g.home;
      const meta = [g.batter.hand, side, b && b.slot ? `#${b.slot}` : null].filter(Boolean).join(" · ");
      const pinKey = g.batter.id != null ? `b:${g.batter.id}` : null;
      const cell = (m, label) => `<span class="ph-rail-cell">
          <span class="ph-meta-k">${label}</span>
          ${b ? this.probCellHtml(b, m) : this.missingHtml("notserved")}
        </span>`;
      return `<div class="ph-rail">
        <div class="ph-rail-head">
          <span class="ph-kicker">At the plate</span><b>${esc(g.batter.name)}</b><span class="ph-mono ph-mut">${this.numHtml(meta)}</span>
          ${pinKey ? `<span class="ph-rail-pin">${this.pinBtnHtml(pinKey, "Watch this batter")}</span>` : ""}
        </div>
        ${this.phaseChip("pre", `PREGAME · FROZEN AT FIRST PITCH ${this.clockOf(g.startTs) || ""}`.trim())}
        <div class="ph-rail-2">${cell("hit", "1+ HIT")}${cell("hr", "1+ HR")}</div>
        ${b ? `<div class="ph-card-why ph-mono"><span>${this.whyLines(b, "hr")[0]}</span></div>`
          : `<div class="ph-note">${esc(COPY.railNoProjection)}</div>`}
        <div class="ph-rail-2">
          ${(() => {
            const e = this.rogOf(g, g.batter && g.batter.id);
            return e
              ? `<span class="ph-nm ph-nm--solid"><span class="ph-meta-k">REST OF GAME · 1+ HIT / HR</span><b class="ph-mono">${this.pct(e.hit)} / ${this.pct(e.hr)}</b><span class="ph-base-top">${this.baseTagHtml()}<span class="ph-mono ph-base-sub">${Number(e.remaining_pa).toFixed(1)} PA left</span></span></span>`
              : `<span class="ph-nm"><span class="ph-meta-k">REST OF GAME · 1+ HIT / HR</span><b class="ph-mono ph-mut">— / —</b></span>`;
          })()}
          <span class="ph-nm"><span class="ph-meta-k">TODAY SO FAR · H / HR / PA</span><b class="ph-mono ph-mut">—</b>${this.tagHtml("notserved")}</span>
        </div>
      </div>`;
    }
    railPitchingHtml(g) {
      const team = g.half === "▲" ? g.home : g.away;
      const s = this.starterStats(g.pitcher.id);
      const sp = this.starterProps(g.gamePk, g.pitcher.id);
      const props = this.STARTER_MARKETS.map(([m, l]) => {
        const r = sp && sp[m];
        return r
          ? `<span class="ph-nm ph-nm--sm ph-nm--solid"><span class="ph-meta-k">${l}</span><b class="ph-mono">O ${Number(r.line)}</b><span class="ph-mono ph-base-sub">${this.pct(Number(r.probability))}</span></span>`
          : `<span class="ph-nm ph-nm--sm"><span class="ph-meta-k">${l}</span><b class="ph-mono ph-mut">—</b></span>`;
      }).join("");
      return `<div class="ph-rail">
        <div class="ph-rail-head">
          <span class="ph-kicker ph-kicker--pit">Pitching</span><b>${esc(g.pitcher.name)}</b><span class="ph-mono ph-mut">${esc([g.pitcher.hand, team].filter(Boolean).join(" · "))}</span>
        </div>
        <div class="ph-rail-5">${props}</div>
        <span class="ph-rail-note">${sp ? this.baseTagHtml() : ""} ${esc(sp ? COPY.railPropsNote : COPY.railPropsNone)}</span>
        <div class="ph-rail-3">
          <span class="ph-meta"><span class="ph-meta-k">PITCH COUNT</span>${this.missingHtml("notserved")}</span>
          <span class="ph-meta"><span class="ph-meta-k">30D K%</span><b class="ph-mono">${this.pct(s.k)}</b></span>
          <span class="ph-meta"><span class="ph-meta-k">WHIFF · FB VELO</span><b class="ph-mono">${this.pct(s.whiff)} · ${s.velo == null ? "—" : s.velo.toFixed(1)}</b></span>
        </div>
      </div>`;
    }
    railGameHtml(g) {
      const w = this.gameWp(g);
      const t = this.gameTotal(g);
      return `<div class="ph-rail">
        <div class="ph-rail-head">
          <span class="ph-kicker">Game</span><b>${this.numHtml(`${g.away} ${g.score.away} – ${g.score.home} ${g.home}`)}</b>
          <span class="ph-phase ph-phase--live ph-rail-pin"><span class="ph-dot is-live ph-dot-sm"></span> LIVE WIN PROB</span>
        </div>
        <div class="ph-rail-wp">
          <b>${esc(w.team)}</b><b class="ph-mono ph-rail-wp-v">${esc(w.val)}</b>${this.deltaHtml(w.delta)}
          <span class="ph-mono ph-mut ph-rail-wp-open">opened ${this.pct(w.pre)}</span>
        </div>
        <div class="ph-card-spark">${this.missingHtml("needsroute")}<span class="ph-card-spark-note">per-pitch win-prob history</span></div>
        <div class="ph-rail-tot">
          <span class="ph-meta-k">TOTAL · PREGAME</span><b>${this.numHtml(t.pick)}</b>
          <span class="ph-mono ph-dim">${this.pct(t.prob)}${t.proj == null ? "" : ` · ${t.proj.toFixed(1)} R`}</span>
          <span class="ph-rail-wp-open ph-mut">frozen at first pitch</span>
        </div>
      </div>`;
    }

    // ── other live games ─────────────────────────────────────────────────
    otherLiveHtml(live, sel) {
      const others = live.filter((x) => x !== sel);
      if (!others.length) return "";
      const cards = others.map((x) => {
        const w = this.gameWp(x);
        const tc = this.topCallOf(x);
        const st = this.gameCallStats(x);
        const r = st && st.abN ? st.abC / st.abN : null;
        const band = this.accBand(r);
        return `<button class="ph-olive" data-act="liveSel" data-arg="${esc(String(x.gamePk))}">
          <span class="ph-olive-top">
            <span class="ph-phase ph-phase--live">● ${this.numHtml(`${this.halfWord(x.half)} ${x.inning == null ? "" : x.inning}`)}</span>
            <b>${esc(x.away)} @ ${esc(x.home)}</b>
            <span class="ph-mono ph-olive-score">${esc(`${x.score.away}–${x.score.home}`)}</span>
          </span>
          <span class="ph-olive-mid ph-mono">
            <span>${esc(`${x.count || "—"} · ${x.outs == null ? "—" : x.outs} out`)}</span>
            <span class="ph-olive-wp"><b>${esc(w.team)}</b> ${esc(w.val)}</span>${this.deltaHtml(w.delta)}
          </span>
          <span class="ph-olive-call">
            <span class="ph-phase ph-phase--live">TOP CALL</span>
            <span class="ph-ellip">${tc ? `${esc(this.outLabel(tc.k))} <span class="ph-mono">${this.pct(tc.p)}</span> · ${esc(tc.mkt)}` : "—"}</span>
          </span>
          <span class="ph-olive-acc">
            <span><b class="ph-mono ${band ? `ph-tone-${band}` : ""}">${esc(st ? this.ratioPct(st.abC, st.abN) : "—")}</b> <span class="ph-mut">at-bat calls</span></span>
            <span class="ph-olive-bar"><span class="ph-tone-bg-${band || "none"}" style="width:${((r || 0) * 100).toFixed(1)}%"></span></span>
          </span>
        </button>`;
      }).join("");
      return `<div class="ph-strip-head">
          <span class="ph-table-title">Other live games</span>
          <span class="ph-strip-sub">tap to switch the view</span>
        </div>
        <div class="ph-olive-grid">${cards}</div>`;
    }

    liveEmptyHtml() {
      const next = this.todayGames().filter((g) => g.phase === "pregame")
        .sort((a, b) => Date.parse(a.startTs || 0) - Date.parse(b.startTs || 0))[0];
      return `<div class="ph-panel ph-live-empty">
        <span class="ph-kicker ph-kicker--mut">Top call now · all games</span>
        <b>${esc(COPY.liveNothingTitle)}</b>
        <span>${esc(COPY.liveNothingBody)}</span>
        ${next ? `<span class="ph-mut">${this.numHtml(`Next first pitch: ${next.away} @ ${next.home} · ${this.clockOf(next.startTs) || "TBD"} ET`)}</span>` : ""}
      </div>`;
    }


    // ══ GRADED LOG (server-backed) ════════════════════════════════════════
















    // ══ DATA FEED (2026-09 redesign) ═════════════════════════════════════
    // How resolved reads have landed. One master filter bar drives every
    // chart and the resolved-markets feed; nothing else on the tab filters.
    // Rows and aggregates come from /graded and /graded/summary, which read
    // the graded_read table (see supabase/migrations/*_graded_reads.sql).
    D_MARKETS = [
      // key, chip label, table label, feed tag
      ["batter_hit", "1+ Hit", "1+ Hit", "1+ HIT"],
      ["batter_hr", "1+ HR", "1+ HR", "1+ HR"],
      ["game_moneyline", "Win prob", "Win prob", "WIN"],
      ["game_total", "Totals", "Totals", "TOTAL"],
      ["ab_result", "At-bat", "At-bat result", "AT-BAT"],
      ["pitch_result", "Pitch", "Next pitch", "PITCH"],
    ];
    D_DEFAULTS = { dTf: 30, dMk: "all", dTeam: "", dPark: "", dHand: "any", dSide: "any", dFeedN: 40 };
    D_PAGE = 40;
    // Home parks, for the "Stadium · TEAM · City, ST" label. The venue name
    // always comes from the data; a city is only attached when that name is
    // this club's listed park, so a neutral site never borrows a city.
    PARKS = {
      AZ: ["Chase Field", "Phoenix, AZ"], ATL: ["Truist Park", "Atlanta, GA"],
      BAL: ["Oriole Park at Camden Yards", "Baltimore, MD"], BOS: ["Fenway Park", "Boston, MA"],
      CHC: ["Wrigley Field", "Chicago, IL"], CWS: ["Rate Field", "Chicago, IL"],
      CIN: ["Great American Ball Park", "Cincinnati, OH"], CLE: ["Progressive Field", "Cleveland, OH"],
      COL: ["Coors Field", "Denver, CO"], DET: ["Comerica Park", "Detroit, MI"],
      HOU: ["Daikin Park", "Houston, TX"], KC: ["Kauffman Stadium", "Kansas City, MO"],
      LAA: ["Angel Stadium", "Anaheim, CA"], LAD: ["Dodger Stadium", "Los Angeles, CA"],
      MIA: ["loanDepot park", "Miami, FL"], MIL: ["American Family Field", "Milwaukee, WI"],
      MIN: ["Target Field", "Minneapolis, MN"], NYM: ["Citi Field", "Queens, NY"],
      NYY: ["Yankee Stadium", "Bronx, NY"], ATH: ["Sutter Health Park", "West Sacramento, CA"],
      PHI: ["Citizens Bank Park", "Philadelphia, PA"], PIT: ["PNC Park", "Pittsburgh, PA"],
      SD: ["Petco Park", "San Diego, CA"], SF: ["Oracle Park", "San Francisco, CA"],
      SEA: ["T-Mobile Park", "Seattle, WA"], STL: ["Busch Stadium", "St. Louis, MO"],
      TB: ["George M. Steinbrenner Field", "Tampa, FL"], TEX: ["Globe Life Field", "Arlington, TX"],
      TOR: ["Rogers Centre", "Toronto, ON"], WSH: ["Nationals Park", "Washington, DC"],
    };

    dataHtml() {
      this.loadData();
      const s = this.state;
      const sum = s.gsum.data;
      const src = s.gsum.source;
      const head = `<div class="ph-titlerow">
          <h1 class="ph-h1">${esc(COPY.dataTitle)}</h1>
          <span class="ph-strip-sub">${esc(COPY.dataSub)}</span>
        </div>
        ${src === "fixture" ? `<div class="ph-fixture">${this.tagHtml("needsroute")}<span>${esc(COPY.dFixtureNote)}</span></div>` : ""}
        ${this.dFilterBarHtml()}`;
      if (src === "missing") {
        return `${head}<div class="ph-empty ph-empty--dash"><b>${esc(COPY.dMissingTitle)}</b>${this.tagHtml("needsroute")}<span>${esc(COPY.dMissingBody)}</span></div>`;
      }
      if (s.gsum.err && !sum) {
        return `${head}<div class="ph-empty">${esc(COPY.dLoadError)}</div>`;
      }
      if (!sum) return `${head}<div class="ph-empty">${esc(COPY.dLoading)}</div>`;
      const n = sum.overall ? sum.overall.n : 0;
      const analysis = n
        ? `${this.dKpiTilesHtml(sum)}
           ${this.calibrationChartHtml(sum)}
           ${this.dailyGapChartHtml(sum)}
           ${this.byMarketTableHtml(sum)}
           ${this.byTeamGridHtml(sum)}
           ${this.splitsHtml(sum)}`
        : this.dEmptyHtml();
      if (this.mob()) {
        const feed = s.mOpen["d:view"] === "feed";
        return `${head}
          <div class="ph-dview">${this.segHtml("mSel", feed ? "d:view|feed" : "d:view|", [["d:view|", "Analytics"], ["d:view|feed", "Resolved markets"]])}</div>
          <div class="ph-dgrid">${feed ? `<div class="ph-dgrid-feed">${this.resolvedFeedHtml()}</div>` : `<div class="ph-dgrid-main">${analysis}</div>`}</div>`;
      }
      return `${head}
        <div class="ph-dgrid">
          <div class="ph-dgrid-main">${analysis}</div>
          <div class="ph-dgrid-feed">${this.resolvedFeedHtml()}</div>
        </div>`;
    }

    // ── scenario ─────────────────────────────────────────────────────────
    dWindow() {
      const tf = this.state.dTf;
      const to = PH.mlbDate(0);
      return { from: tf === "today" ? to : PH.mlbDate(-(Number(tf) - 1)), to };
    }
    dTfName() { return this.state.dTf === "today" ? "Today" : `Last ${this.state.dTf} days`; }
    dMarketName(k, i) { const m = this.D_MARKETS.find((x) => x[0] === k); return m ? m[i || 1] : k; }
    dQuery() {
      const s = this.state, w = this.dWindow();
      const q = new URLSearchParams({ from: w.from, to: w.to });
      if (s.dMk !== "all") q.set("market", s.dMk);
      if (s.dTeam) q.set("team", s.dTeam);
      if (s.dPark) q.set("venue", s.dPark);
      if (s.dHand !== "any") q.set("hand", s.dHand);
      if (s.dSide !== "any") q.set("side", s.dSide);
      return q;
    }
    // Every filter change goes through here: it resets the feed to one page
    // and re-asks for both the rows and the aggregates.
    dSet(patch) {
      Object.assign(this.state, patch, { dFeedN: this.D_PAGE });
      this.state.graded = { rows: [], total: 0, next: null, loaded: false, err: false };
      this.render();
    }
    dClear() { this.dSet(Object.assign({}, this.D_DEFAULTS)); }

    // ── loading ──────────────────────────────────────────────────────────
    // Called from dataHtml(): each loader is keyed on the filter signature,
    // so a render only fetches when the scenario actually changed.
    loadData() {
      this.loadVenues();
      this.loadGradedSummary();
      this.loadGraded();
    }
    // A route that is not deployed yet answers 404 {error:"no route: …"}. On
    // localhost that switches the tab to the dev fixture, clearly labelled;
    // anywhere else it is a NEEDS ROUTE state, never fabricated rows.
    async dFetch(path) {
      try {
        const r = await fetch(`${API_BASE}${path}`);
        const body = await r.json().catch(() => null);
        if (r.status === 404 && body && /^no route/.test(body.error || "")) return { missing: true };
        return r.ok ? { body } : { err: true };
      } catch (_e) { return { err: true }; }
    }
    isDevHost() { return /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname); }
    async loadFixture() {
      if (this._fixture) return this._fixture;
      if (!this.isDevHost()) return null;
      if (!window.PH_GRADED_FIXTURE) {
        await new Promise((res) => {
          const el = document.createElement("script");
          el.src = "dev/graded-fixture.js";
          el.onload = res; el.onerror = res;
          document.head.appendChild(el);
        });
      }
      this._fixture = window.PH_GRADED_FIXTURE ? window.PH_GRADED_FIXTURE(PH.mlbDate(0)) : null;
      return this._fixture;
    }
    async loadGradedSummary() {
      const sig = this.dQuery().toString();
      if (this._gsumSig === sig) return;
      this._gsumSig = sig;
      const res = await this.dFetch(`/graded/summary?${sig}`);
      if (this._gsumSig !== sig) return;   // a newer scenario was asked for
      let next;
      if (res.body) next = { data: res.body, source: "api", err: false };
      else if (res.missing) {
        const fx = await this.loadFixture();
        next = fx ? { data: this.summarizeGraded(fx), source: "fixture", err: false }
          : { data: null, source: "missing", err: false };
      } else next = Object.assign({}, this.state.gsum, { err: true });
      this.setState({ gsum: next });
    }
    async loadGraded(more) {
      const g = this.state.graded;
      const sig = this.dQuery().toString();
      if (!more && this._gradedSig === sig) return;
      if (more && (g.next == null || this._gradedMore)) return;
      this._gradedSig = sig;
      this._gradedMore = !!more;
      const cursor = more ? g.next : 0;
      const res = await this.dFetch(`/graded?${sig}&limit=${this.D_PAGE}&cursor=${cursor}`);
      this._gradedMore = false;
      if (this._gradedSig !== sig) return;
      let next;
      if (res.body) {
        next = {
          rows: (more ? g.rows : []).concat(res.body.rows || []),
          total: res.body.total || 0, next: res.body.next_cursor, loaded: true, err: false,
        };
      } else if (res.missing) {
        const fx = (await this.loadFixture()) || [];
        const all = fx.filter((r) => this.dPass(r));
        const upto = more ? g.rows.length + this.D_PAGE : this.D_PAGE;
        next = { rows: all.slice(0, upto), total: all.length, next: upto < all.length ? upto : null, loaded: true, err: false };
      } else next = Object.assign({}, g, { loaded: true, err: true });
      this.setState({ graded: next });
    }
    async loadVenues() {
      if (this._venuesAsked) return;
      this._venuesAsked = true;
      const res = await this.dFetch("/graded/venues");
      let venues = [];
      if (res.body) venues = res.body.venues || [];
      else if (res.missing) {
        const fx = (await this.loadFixture()) || [];
        const by = {};
        fx.forEach((r) => { if (!by[r.venue_id]) by[r.venue_id] = { venue_id: r.venue_id, venue_name: r.venue_name, home_abbr: r.home_abbr }; });
        venues = Object.values(by);
      } else this._venuesAsked = false;   // retry on a later render
      this.setState({ venues });
    }

    // ── maths (fixture mode only: the API computes these server-side) ────
    // `ig` names the one filter a surface ignores, which is what lets the
    // market table, team grid and daily chart act as filters themselves.
    dPass(r, ig) {
      const s = this.state, w = this.dWindow();
      return (ig === "mk" || s.dMk === "all" || r.market === s.dMk)
        && (ig === "team" || !s.dTeam || (r.team_abbrs || []).includes(s.dTeam))
        && (ig === "tf" || (r.official_date >= w.from && r.official_date <= w.to))
        && (!s.dPark || String(r.venue_id) === String(s.dPark))
        && (s.dHand === "any" || r.opp_pitcher_hand === s.dHand)
        && (s.dSide === "any" || r.batting_side === s.dSide);
    }
    statOf(rows) {
      let n = 0, sp = 0, so = 0, sb = 0;
      rows.forEach((r) => {
        const o = r.result === "hit" ? 1 : 0, p = Number(r.probability);
        n += 1; sp += p; so += o; sb += (p - o) * (p - o);
      });
      return n ? { n, exp: sp / n, act: so / n, brier: sb / n } : { n: 0, exp: null, act: null, brier: null };
    }
    summarizeGraded(all) {
      const G = all.filter((r) => r.result !== "void");
      const cur = G.filter((r) => this.dPass(r));
      const w = this.dWindow();
      const d0 = w.from < PH.mlbDate(-6) ? w.from : PH.mlbDate(-6);
      const group = (rows, keyOf, name) => {
        const by = {};
        rows.forEach((r) => [].concat(keyOf(r)).forEach((k) => { if (k != null) (by[k] = by[k] || []).push(r); }));
        return Object.keys(by).map((k) => Object.assign({ [name]: k }, this.statOf(by[k])));
      };
      const splits = [
        ["PITCHER", "vs LHP", (r) => r.opp_pitcher_hand === "L"], ["PITCHER", "vs RHP", (r) => r.opp_pitcher_hand === "R"],
        ["SIDE", "Batting at home", (r) => r.batting_side === "home"], ["SIDE", "Batting away", (r) => r.batting_side === "away"],
        ["ORDER", "Slots 1–3", (r) => r.lineup_slot >= 1 && r.lineup_slot <= 3],
        ["ORDER", "Slots 4–6", (r) => r.lineup_slot >= 4 && r.lineup_slot <= 6],
        ["ORDER", "Slots 7–9", (r) => r.lineup_slot >= 7 && r.lineup_slot <= 9],
      ].map(([grp, label, fn]) => Object.assign({ group: grp, label }, this.statOf(cur.filter(fn))));
      return {
        overall: this.statOf(cur),
        bins: group(cur, (r) => Math.min(9, Math.floor(Number(r.probability) * 10)), "bin")
          .map((b) => Object.assign(b, { bin: Number(b.bin) })),
        daily: group(G.filter((r) => this.dPass(r, "tf") && r.official_date >= d0 && r.official_date <= w.to), (r) => r.official_date, "date"),
        by_market: group(G.filter((r) => this.dPass(r, "mk")), (r) => r.market, "market"),
        by_team: group(G.filter((r) => this.dPass(r, "team")), (r) => r.team_abbrs, "team"),
        splits,
      };
    }
    // Gap (landed − predicted) and Brier skill against always predicting the
    // base rate. Skill is undefined when everything landed or nothing did.
    derive(st) {
      if (!st || !st.n) return { n: 0, gap: null, skill: null, exp: null, act: null, brier: null };
      const base = st.act * (1 - st.act);
      return Object.assign({}, st, { gap: st.act - st.exp, skill: base > 0 ? 1 - st.brier / base : null });
    }
    gapTxt(g) { return g == null ? "—" : `${g >= 0 ? "+" : "−"}${Math.abs(g * 100).toFixed(1)} pts`; }
    gapTone(g) { if (g == null) return null; const a = Math.abs(g) * 100; return a < 2 ? "good" : a < 4 ? "amber" : "bad"; }
    // Calibration colour: within 3 pts green; landed more blue; landed less amber.
    gapBand(g) { return g == null ? "none" : Math.abs(g) * 100 <= 3 ? "ok" : g > 0 ? "more" : "less"; }

    // ── filter bar ───────────────────────────────────────────────────────
    parkLabel(v) {
      const park = this.PARKS[v.home_abbr];
      const city = park && String(v.venue_name || "").toLowerCase() === park[0].toLowerCase() ? park[1] : "—";
      return `${v.venue_name || "—"} · ${v.home_abbr || "—"} · ${city}`;
    }
    dFilterBarHtml() {
      const s = this.state;
      const chip = (k, label) => `<button class="ph-chip${s.dMk === k ? " is-on" : ""}" data-act="dMk" data-arg="${esc(k)}">${esc(label)}</button>`;
      const teams = Object.keys(this.PARKS).sort();
      const venues = (s.venues || []).slice().sort((a, b) => String(a.venue_name).localeCompare(String(b.venue_name)));
      const venueNow = venues.find((v) => String(v.venue_id) === String(s.dPark));
      const scenario = [
        s.dTeam || null, venueNow ? `@ ${venueNow.venue_name}` : null,
        s.dMk === "all" ? null : this.dMarketName(s.dMk),
        s.dHand === "any" ? null : `vs ${s.dHand}HP`, s.dSide === "any" ? null : s.dSide,
        this.dTfName(),
      ].filter(Boolean).join(" · ");
      const n = s.gsum.data && s.gsum.data.overall ? s.gsum.data.overall.n : null;
      if (this.mob()) {
        const open = !!s.mOpen["f:data"];
        const k = (s.dTeam ? 1 : 0) + (s.dPark ? 1 : 0) + (s.dHand !== "any" ? 1 : 0) + (s.dSide !== "any" ? 1 : 0);
        return `<div class="ph-fbar ph-fbar--d">
          <div class="ph-fbar-line">
            ${this.segHtml("dTf", String(s.dTf), [["today", "Today"], ["7", "7D"], ["14", "14D"], ["30", "30D"]])}
            <button class="ph-chip${k ? " is-on" : ""}" data-act="mToggle" data-arg="f:data" aria-expanded="${open}">Filters${k ? ` <span class="ph-mono">${k}</span>` : ""} ${open ? "▴" : "▾"}</button>
          </div>
          <div class="ph-fscroll">${chip("all", "All")}${this.D_MARKETS.map((m) => chip(m[0], m[1])).join("")}</div>
          ${open ? `<div class="ph-fbar-line ph-fbar-more">
            <select class="ph-select" data-pfilter="dTeam" aria-label="Team">
              <option value="">All teams</option>
              ${teams.map((t) => `<option value="${t}"${s.dTeam === t ? " selected" : ""}>${t}</option>`).join("")}
            </select>
            <select class="ph-select ph-select--wide" data-pfilter="dPark" aria-label="Stadium">
              <option value="">All stadiums</option>
              ${venues.map((v) => `<option value="${esc(v.venue_id)}"${String(s.dPark) === String(v.venue_id) ? " selected" : ""}>${esc(this.parkLabel(v))}</option>`).join("")}
            </select>
            ${this.segHtml("dHand", s.dHand, [["any", "Any SP"], ["L", "vs LHP"], ["R", "vs RHP"]])}
            ${this.segHtml("dSide", s.dSide, [["any", "Home + away"], ["home", "Home"], ["away", "Away"]])}
            <button class="ph-link" data-act="dClear">Clear</button>
          </div>` : ""}
          <span class="ph-mono ph-fbar-count">${esc(scenario)} · <b>${n == null ? "—" : n.toLocaleString()}</b> graded</span>
        </div>`;
      }
      return `<div class="ph-fbar ph-fbar--d">
        <div class="ph-fbar-line">
          ${this.segHtml("dTf", String(s.dTf), [["today", "Today"], ["7", "7D"], ["14", "14D"], ["30", "30D"]])}
          <span class="ph-vrule"></span>
          <span class="ph-fgroup">${chip("all", "All")}${this.D_MARKETS.map((m) => chip(m[0], m[1])).join("")}</span>
        </div>
        <div class="ph-fbar-line">
          <select class="ph-select" data-pfilter="dTeam" aria-label="Team">
            <option value="">All teams</option>
            ${teams.map((t) => `<option value="${t}"${s.dTeam === t ? " selected" : ""}>${t}</option>`).join("")}
          </select>
          <select class="ph-select ph-select--wide" data-pfilter="dPark" aria-label="Stadium">
            <option value="">All stadiums</option>
            ${venues.map((v) => `<option value="${esc(v.venue_id)}"${String(s.dPark) === String(v.venue_id) ? " selected" : ""}>${esc(this.parkLabel(v))}</option>`).join("")}
          </select>
          ${this.segHtml("dHand", s.dHand, [["any", "Any SP"], ["L", "vs LHP"], ["R", "vs RHP"]])}
          ${this.segHtml("dSide", s.dSide, [["any", "Home + away"], ["home", "Home"], ["away", "Away"]])}
          <button class="ph-link" data-act="dClear">Clear</button>
          <span class="ph-mono ph-fbar-count">${esc(scenario)} · <b>${n == null ? "—" : n.toLocaleString()}</b> graded</span>
        </div>
      </div>`;
    }

    // ── analysis ─────────────────────────────────────────────────────────
    dKpiTilesHtml(sum) {
      const st = this.derive(sum.overall);
      const s = this.state;
      const tile = (k, v, sub, tone, tip) => `<div class="ph-kpi" title="${esc(tip || "")}">
          <span class="ph-kpi-k">${k}</span>
          <b class="ph-mono ph-kpi-v ${tone ? `ph-tone-${tone}` : ""}">${v}</b>
          <span class="ph-kpi-sub">${sub}</span>
        </div>`;
      return `<div class="ph-kpis ph-kpis--4">
          ${tile("GRADED", st.n.toLocaleString(), this.numHtml(`${this.dTfName().toLowerCase()} · ${s.dMk === "all" ? "all markets" : this.dMarketName(s.dMk).toLowerCase()}`))}
          ${tile("LANDED", this.pct1(st.act), this.numHtml(`model predicted ${this.pct1(st.exp)}`), null, "Share of reads where the pick happened")}
          ${tile("CALIBRATION GAP", this.gapTxt(st.gap), st.gap >= 0 ? "landed more often than predicted" : "landed less often than predicted", this.gapTone(st.gap), "Landed rate minus average predicted probability")}
          ${tile("BRIER SKILL", st.skill == null ? "—" : `${(st.skill * 100).toFixed(1)}%`, this.numHtml(`Brier ${st.brier.toFixed(3)} vs base rate`), st.skill == null ? null : st.skill > 0 ? "good" : "bad", "1 − Brier ÷ Brier of always predicting the base rate")}
        </div>
        <p class="ph-caption">${esc(COPY.dCaption)}</p>`;
    }
    dCard(title, sub, body) {
      return `<div class="ph-panel ph-dcard">
        <div class="ph-panel-head"><span class="ph-table-title">${esc(title)}</span><span class="ph-strip-sub">${this.numHtml(sub)}</span></div>
        ${body}
      </div>`;
    }
    calibrationChartHtml(sum) {
      const bins = {};
      (sum.bins || []).forEach((b) => { bins[Number(b.bin)] = this.derive(b); });
      // Touch has no hover, so on a phone a tap selects a band and its tip
      // is printed under the chart instead.
      const mob = this.mob(), sel = this.state.mOpen["d:cal"];
      let selTip = "";
      const cols = Array.from({ length: 10 }, (_, i) => {
        const t = bins[i];
        const has = t && t.n;
        const tip = has ? `${t.n} reads · predicted ${this.pct1(t.exp)} · landed ${this.pct1(t.act)}` : "no reads in this band";
        const on = mob && sel === String(i);
        if (on) selTip = `${i * 10}–${i * 10 + 10}%: ${tip}`;
        return `<div class="ph-cal-col${on ? " is-sel" : ""}" title="${esc(tip)}"${mob ? ` data-act="mSel" data-arg="d:cal|${i}"` : ""}>
          <span class="ph-mono ph-cal-val">${has ? this.pct(t.act) : ""}</span>
          <div class="ph-cal-plot">
            ${has ? `<span class="ph-cal-bar ph-gb--${this.gapBand(t.gap)}" style="height:${(t.act * 100).toFixed(1)}%"></span>
            <span class="ph-cal-exp" style="bottom:${(t.exp * 100).toFixed(1)}%"></span>` : ""}
          </div>
          <span class="ph-mono ph-cal-lbl">${i * 10}–${i * 10 + 10}</span>
          <span class="ph-mono ph-cal-n">${has ? t.n : ""}</span>
        </div>`;
      }).join("");
      const legend = `<div class="ph-legend">
          <span><i class="ph-gb--ok"></i>within <span class="ph-mono">3</span> pts</span><span><i class="ph-gb--more"></i>landed more than predicted</span>
          <span><i class="ph-gb--less"></i>landed less</span><span><i class="ph-legend-line"></i>mean predicted</span>
        </div>`;
      const note = mob ? `<div class="ph-mono ph-chart-sel">${esc(selTip || "tap a band for its counts")}</div>` : "";
      return this.dCard("Calibration", "landed rate per 10-pt probability band", `<div class="ph-cal">${cols}</div>${note}${legend}`);
    }
    dailyGapChartHtml(sum) {
      const s = this.state, w = this.dWindow();
      const days = s.dTf === "today" ? 7 : Number(s.dTf);
      const by = {};
      (sum.daily || []).forEach((d) => { by[d.date] = this.derive(d); });
      const bars = [];
      const mob = this.mob(), sel = this.state.mOpen["d:gap"];
      let selTip = "";
      for (let i = days - 1; i >= 0; i -= 1) {
        const date = PH.mlbDate(-i);
        const t = by[date];
        const v = t && t.n ? Math.max(-10, Math.min(10, t.gap * 100)) : 0;
        const tip = `${i === 0 ? "Today" : date} · ${t && t.n ? `${t.n} reads · ${this.gapTxt(t.gap)}` : "no reads"}`;
        const on = mob && sel === date;
        if (on) selTip = tip;
        bars.push(`<div class="ph-gap-col${date < w.from ? " is-out" : ""}${on ? " is-sel" : ""}" title="${esc(tip)}"${mob ? ` data-act="mSel" data-arg="d:gap|${date}"` : ""}>
          <span class="ph-gap-up">${v > 0 ? `<span class="ph-gb--${this.gapBand(t.gap)}" style="height:${(v * 10).toFixed(1)}%"></span>` : ""}</span>
          <span class="ph-gap-dn">${v < 0 ? `<span class="ph-gb--${this.gapBand(t.gap)}" style="height:${(-v * 10).toFixed(1)}%"></span>` : ""}</span>
        </div>`);
      }
      const sub = s.dTf === "today" ? "last 7 days for context · today highlighted"
        : `each bar is one day · ${mob ? "tap" : "hover"} for counts`;
      return this.dCard("Daily gap · landed − predicted", sub, `
        <div class="ph-gap">${bars.join("")}</div>
        <div class="ph-gap-axis ph-mono"><span>${days > 1 ? esc(PH.mlbDate(-(days - 1))) : ""}</span><span>±10 pts</span><span>TODAY</span></div>
        ${mob ? `<div class="ph-mono ph-chart-sel">${esc(selTip || "tap a day for its counts")}</div>` : ""}`);
    }
    byMarketTableHtml(sum) {
      const by = {};
      (sum.by_market || []).forEach((m) => { by[m.market] = this.derive(m); });
      if (this.mob()) {
        const cards = this.D_MARKETS.map(([k, , label]) => {
          const t = by[k] || this.derive(null);
          const on = this.state.dMk === k;
          return this.mCardHtml({
            key: `dm:${k}`, cls: on ? "is-on" : "",
            head: `<button class="ph-rowlink" data-act="dMkRow" data-arg="${k}"><span class="ph-rowlink-top"><b>${esc(label)}</b><span class="ph-mono">${t.n ? t.n.toLocaleString() : "0"} graded</span></span></button>`,
            stats: `${this.mPairHtml("LANDED · MODEL", `<span class="ph-mono">${this.pct1(t.act)} · <span class="ph-mut">${this.pct1(t.exp)}</span></span>`)}
              ${this.mPairHtml("GAP", `<span class="ph-mono ${t.n ? `ph-tone-${this.gapTone(t.gap)}` : "ph-mut"}">${this.gapTxt(t.gap)}</span>`)}`,
            more: `${this.mPairHtml("SKILL", `<span class="ph-mono">${t.skill == null ? "—" : `${(t.skill * 100).toFixed(1)}%`}</span>`)}
              ${this.mPairHtml("LANDED VS MODEL", t.n ? this.barHtml(t.act * 100, t.exp * 100, "ph-band-bg-good") : `<span class="ph-bar"></span>`)}`,
          });
        }).join("");
        return this.dCard("By market", "ignores the market filter · tap a name to filter", `<div class="ph-mlist">${cards}</div>`);
      }
      const rows = this.D_MARKETS.map(([k, , label]) => {
        const t = by[k] || this.derive(null);
        const on = this.state.dMk === k;
        return `<button class="ph-mrow${on ? " is-on" : ""}" data-act="dMkRow" data-arg="${k}">
          <span class="ph-mrow-name">${esc(label)}</span>
          <span class="ph-mono">${t.n ? t.n.toLocaleString() : "0"}</span>
          <span class="ph-mono">${this.pct1(t.exp)}</span>
          <span class="ph-mono">${this.pct1(t.act)}</span>
          <span class="ph-mono ${t.n ? `ph-tone-${this.gapTone(t.gap)}` : "ph-mut"}">${this.gapTxt(t.gap)}</span>
          <span class="ph-mono">${t.skill == null ? "—" : `${(t.skill * 100).toFixed(1)}%`}</span>
          ${t.n ? this.barHtml(t.act * 100, t.exp * 100, "ph-band-bg-good") : `<span class="ph-bar"></span>`}
        </button>`;
      }).join("");
      return this.dCard("By market", "ignores the market filter · click a row to filter", `
        <div class="ph-mtable">
          <div class="ph-mrow ph-mrow--head"><span>MARKET</span><span>GRADED</span><span>MODEL</span><span>LANDED</span><span>GAP</span><span>SKILL</span><span>LANDED VS MODEL</span></div>
          ${rows}
        </div>`);
    }
    byTeamGridHtml(sum) {
      const by = {};
      (sum.by_team || []).forEach((t) => { by[t.team] = this.derive(t); });
      const tiles = Object.keys(this.PARKS).sort().map((team) => {
        const t = by[team] || this.derive(null);
        const on = this.state.dTeam === team;
        const a = t.n && Math.abs(t.gap) >= 0.02 ? Math.min(0.38, Math.abs(t.gap) * 6).toFixed(2) : 0;
        const tint = !a ? "" : t.gap > 0 ? `background:rgba(47,143,214,${a})` : `background:rgba(224,168,58,${a})`;
        const tip = t.n ? `${team}: landed ${this.pct1(t.act)} vs predicted ${this.pct1(t.exp)}` : team;
        return `<button class="ph-ttile${on ? " is-on" : ""}" data-act="dTeamTile" data-arg="${team}" style="${tint}" title="${esc(tip)}">
          <b>${team}</b>
          <span class="ph-mono ${t.n ? `ph-tone-${this.gapTone(t.gap)}` : "ph-mut"}">${this.gapTxt(t.gap)}</span>
          <span class="ph-mono ph-mut">${t.n ? `${t.n} reads` : "no reads"}</span>
        </button>`;
      }).join("");
      return this.dCard("By team", "ignores the team filter · blue landed more, amber less · click to filter", `<div class="ph-tgrid">${tiles}</div>`);
    }
    splitsHtml(sum) {
      let last = null;
      const rows = (sum.splits || []).map((sp) => {
        const t = this.derive(sp);
        const grp = sp.group !== last ? sp.group : "";
        last = sp.group;
        return `<div class="ph-split">
          <span class="ph-meta-k">${esc(grp)}</span>
          <span>${this.numHtml(sp.label)}</span>
          <span class="ph-mono ph-mut">${t.n || 0}</span>
          ${t.n ? this.barHtml(t.act * 100, t.exp * 100, "ph-band-bg-good") : `<span class="ph-bar"></span>`}
          <span class="ph-mono">${this.pct1(t.act)}</span>
          <span class="ph-mono ${t.n ? `ph-tone-${this.gapTone(t.gap)}` : "ph-mut"}">${this.gapTxt(t.gap)}</span>
        </div>`;
      }).join("");
      return this.dCard("Matchup splits", "within the current scenario", `${rows}<p class="ph-caption">${esc(COPY.dSplitsNote)}</p>`);
    }
    dEmptyHtml() {
      return `<div class="ph-empty ph-empty--dash">
        <b>${esc(COPY.dEmptyTitle)}</b>
        <span>${esc(COPY.dEmptyBody)}</span>
        <button class="ph-chip is-on" data-act="dClear">Clear filters</button>
      </div>`;
    }

    // ── resolved-markets feed ────────────────────────────────────────────
    feedMeta(r) {
      const hand = r.opp_pitcher_hand ? ` (${r.opp_pitcher_hand})` : "";
      const game = `${r.away_abbr} @ ${r.home_abbr}`;
      if (r.market === "batter_hit" || r.market === "batter_hr") {
        return `${r.batter_team || "—"} · #${r.lineup_slot || "—"} vs ${this.lastName(r.pitcher_name)}${hand} · ${game}`;
      }
      if (r.market === "game_moneyline" || r.market === "game_total") return `${game} · ${r.venue_name || "—"}`;
      const miss = r.result === "miss" && r.actual_label ? ` · was ${this.outLabel(r.actual_label)}` : "";
      return `${this.shortName(r.batter_name)} vs ${this.lastName(r.pitcher_name)}${hand} · ${game}${miss}`;
    }
    feedSubject(r) {
      return r.market === "ab_result" || r.market === "pitch_result" ? this.outLabel(r.subject) || "—" : r.subject || "—";
    }
    resolvedFeedHtml() {
      const s = this.state, g = s.graded;
      const sum = s.gsum.data;
      const dayN = {};
      ((sum && sum.daily) || []).forEach((d) => { dayN[d.date] = d.n; });
      const today = PH.mlbDate(0);
      const dayLabel = (d) => {
        const t = new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase().replace(",", "");
        return d === today ? `TODAY · ${t}` : t;
      };
      const active = [
        s.dMk === "all" ? null : this.dMarketName(s.dMk), s.dTeam || null,
        s.dHand === "any" ? null : `vs ${s.dHand}HP`, s.dSide === "any" ? null : s.dSide,
        this.dTfName().toLowerCase(),
      ].filter(Boolean).join(" · ");
      let body = "", lastDay = null;
      g.rows.forEach((r) => {
        if (r.official_date !== lastDay) {
          lastDay = r.official_date;
          const n = dayN[r.official_date];
          body += `<div class="ph-feed-day"><span>${this.numHtml(dayLabel(r.official_date))}</span><span class="ph-mono">${n == null ? "" : `${n} graded`}</span></div>`;
        }
        const chip = r.result === "void" ? `<span class="ph-res ph-res--dnp">DNP</span>`
          : r.result === "hit" ? `<span class="ph-res ph-res--good">LANDED</span>` : `<span class="ph-res ph-res--bad">MISS</span>`;
        body += `<div class="ph-feed-item">
          <div class="ph-feed-r1">
            <span class="ph-feed-tag">${esc(this.dMarketName(r.market, 3))}</span>
            <b class="ph-ellip">${this.numHtml(this.feedSubject(r))}</b>
            <span class="ph-mono">${this.pct(r.probability)}</span>
            ${chip}
          </div>
          <div class="ph-feed-r2"><span class="ph-ellip">${this.numHtml(this.feedMeta(r))}</span><span class="ph-mono">${esc(this.clockOf(r.resolved_at) || "")}</span></div>
        </div>`;
      });
      const empty = g.loaded && !g.rows.length
        ? `<div class="ph-feed-empty">${esc(g.err ? COPY.dLoadError : COPY.dFeedEmpty)}</div>`
        : !g.loaded ? `<div class="ph-feed-empty">${esc(COPY.dLoading)}</div>` : "";
      const more = g.next != null
        ? `<button class="ph-more" data-act="dMore">Show <span class="ph-mono">${this.D_PAGE}</span> more</button>` : "";
      return `<div class="ph-feed">
        <div class="ph-feed-head">
          <span class="ph-kicker is-live">● Resolved markets</span>
          <span class="ph-mono ph-mut">${g.rows.length} of ${(g.total || 0).toLocaleString()}</span>
        </div>
        <div class="ph-feed-sub">${this.numHtml(`most recent first · ${active}`)}</div>
        <div class="ph-feed-list">${body}${empty}${more}</div>
      </div>`;
    }

    // ── player profiles ──────────────────────────────────────────────────
    // The nightly warehouse profile (and, for pitchers, the fatigue curve)
    // per player_id, fetched once and cached for the session. The Starters
    // tables and the Live pitching rail read it through starterStats().
    async loadEntityProfile(id, kind) {
      const key = String(id);
      if (this.state.entityProfile[key]) return;
      this.state.entityProfile = Object.assign({}, this.state.entityProfile, { [key]: { pending: true } });
      const [profile, fatigue] = await Promise.all([
        fetchJson(`/player/${key}/profile`),
        kind === "PITCHER" ? fetchJson(`/player/${key}/fatigue`) : Promise.resolve(null),
      ]);
      this.setState({
        entityProfile: Object.assign({}, this.state.entityProfile, {
          [key]: { pending: false, profile, fatigue },
        }),
      });
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
      // selection. Skip a render while the user is in a filter control —
      // otherwise the 8s poll yanks the cursor out of the box mid-word, or
      // closes an open dropdown mid-choice. The pending state is picked up by
      // the next render after blur.
      const ae = document.activeElement;
      const busy = ae && ae.hasAttribute
        && ae.hasAttribute("data-pfilter");
      if (busy && this.root.contains(ae)) {
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
        else if (view === "pred") main = this.predHtml();
        else if (view === "live") main = this.liveHtml();
        else main = this.dataHtml();
      } catch (e) {
        console.error(`[pitchhawk] ${view} view failed to render`, e);
        main = this.viewErrorHtml(view, e);
      }
      this._bindMq();
      // Shell rows above the view. The banner shows on every tab; Watching on
      // Home and Live only.
      const watch = view === "home" || view === "live" ? this.watchRowHtml() : "";
      const top = this.apiBannerHtml() + watch;
      this.root.innerHTML = `
        ${this.headerHtml()}
        <main class="ph-main ph-shell">${top}${main}</main>
        ${this.footerHtml()}`;
      // Lazy lookups the views asked for while rendering (head-to-head,
      // starter profiles). One batch per render; each lookup is cached, so a
      // re-render never asks twice.
      this._flushWants();
    }



    // Everything the drill-down needs for one slate, in one call: the rows,
    // the games they belong to, and (for the trend chart) the accuracy rollup.
    // Signature-gated inside each loader, so calling this on every poll and
    // every date chip is cheap when nothing changed.
    syncDay(force, view) {
      const date = this.viewDate(view);
      this.loadDayMeta(date).catch(() => {});
      return this.loadDayRows(date, force)
        .then((changed) => { if (changed) this.render(); })
        .catch(() => {});
    }

    liveGames() { return (PH.games || []).filter((g) => g.phase === "live"); }

    async poll() {
      try {
        await fetchSlate().catch(() => {});
        // Refreshed on its own 5-minute cadence inside fetchRecap; calling it
        // every tick is a no-op until then.
        fetchRecap().then((changed) => { if (changed) this.render(); }).catch(() => {});
        this.loadProjections().then((changed) => { if (changed) this.render(); }).catch(() => {});
        let games;
        try {
          games = await PH.loadLive(API_BASE);
        } catch (e) {
          // /live answering is the board's definition of "the API is up".
          // Keep every last-good number on screen and say why it isn't moving.
          if (!this.state.api.down) this.setState({ api: Object.assign({}, this.state.api, { down: true }) });
          throw e;
        }
        const now = Date.now();
        this.state.api = { down: false, lastGood: now, updatedAt: now };
        if (Array.isArray(games)) {
          PH.games = games;
          // Not awaited: the board must never wait on at-bat history. It
          // re-renders itself when the rows land, and no-ops unless a live
          // game's situation actually moved.
          this.refreshLiveRows()
            .then((changed) => { if (changed) this.render(); })
            .catch(() => {});
          this.render();
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
      // The slate recap (which seeds the games on a cold start) and today's
      // calls, on boot rather than waiting for the first poll.
      fetchRecap(true).then(() => this.render()).catch(() => {});
      this.syncDay(true);
      this.loadAccuracy()
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
    window.__npBoard = board;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
