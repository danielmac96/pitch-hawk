// ════════════════════════════════════════════════════════════════════════
// pitchhawk.js — Pitch Hawk single-page app.
//
// One page, three tabs: Home / Live Feed / Data Feed. No framework: every view
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
  // Last pitcher/batter/game the Data Feed showed. Persisted so the warehouse
  // scouting panels survive a reload — the session graded log cannot, because
  // nothing stores per-pitch prediction history (that store is deferred).
  const SCOUT_KEY = "ph.scout.v1";

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
        // The feed redesign's drill-down. Expansion is keyed by game_pk and by
        // game_pk + ":" + at_bat_index rather than by array position, so it
        // survives the 8s poll rebuilding every row underneath it. Filters are
        // per game, so scoping one game never narrows another.
        openG: {}, openAb: {}, phFilters: {},
        // Home slate pills. `homeOpen` is the metadata chevron, keyed by
        // game_pk; `gameCtx` caches GET /game/{pk}/context per game so the
        // tier is fetched once on first expand rather than on every poll.
        homeOpen: {}, gameCtx: {},
        // Which game the Live Feed hero describes. "top" is the most confident
        // open call across every live game (the board's original behaviour);
        // a gamePk pins the hero and the current-at-bat panel to that game.
        heroSel: "top",
        // Every micro-market prediction, and the slate it belongs to, keyed by
        // America/New_York date. Per date rather than one "current day": the
        // Live Feed is always about today while the Data Feed walks the
        // retained window, and sharing one store made the Data Feed's stepper
        // silently change what "Today's games" meant.
        days: {}, dayMeta: {},
        // Per-day, per-market accuracy from /accuracy. Never pruned, so this is
        // the one series that outlives the raw predictions.
        accuracy: { days: [], markets: [], loaded: false, err: false },
        // The Data Feed's window, and the history accordion's open paths.
        // The single-day stepper this replaced could only ever describe one
        // slate, so every analytic on the tab was pinned to one slate too.
        dfRange: "7d",              // today | 7d | 14d | 30d | custom
        dfFrom: "", dfTo: "",       // America/New_York dates, custom range only
        // Keyed by path — "d-2026-08-22", "d-2026-08-22/g-823507",
        // "d-2026-08-22/g-823507/ab-14" — so a game open under one day cannot
        // drag the same game open under another, and none of it lives in the
        // DOM the 8s poll throws away.
        dfOpen: {},
        // Row-level scoping for the analytic half of the tab. These four bind
        // to dimensions only the per-pitch rows carry — the nightly rollup has
        // no team, player or side — which is why they scope the KPI tiles and
        // the charts but never the history accordion.
        dfTeam: "", dfPlayer: "", dfSide: "all", dfRole: "all",
        // The entity overlay. `entity` is what is open; `entityProfile` caches
        // the warehouse lookups per player_id so re-opening the same name does
        // not re-request, and the 8s poll never does.
        entity: null, entityProfile: {},
        // Profitable trends. Server-ranked, so this holds a page rather than a
        // dataset — `loaded` stays false until the first request settles so the
        // panel is absent rather than flashing empty.
        trends: { rows: [], baseline: null, horizon: null, loaded: false, err: false },
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
      };
      this._pollIv = null;
      // Per-date fetch gates and built-model caches. Plain objects rather than
      // a single signature, because two tabs can want two different days.
      this._dayRowsSig = {};
      this._dayRowsSeq = {};
      this._models = {};
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
      // A modal that cannot be dismissed from the keyboard is a trap. One
      // document-level handler rather than a per-element one, so it survives
      // the innerHTML swap like every other listener on the board.
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.state.entity) this.setState({ entity: null });
      });
    }

    _onFilterChange(e) {
      // The drill-down's per-game team/batter/pitcher selects. They are the
      // only <select> on the board, and their value has to be re-derived from
      // state on every render because innerHTML is replaced wholesale.
      const ph = e.target && e.target.closest ? e.target.closest("[data-phfilter]") : null;
      if (ph) {
        const pk = ph.getAttribute("data-arg");
        const key = ph.getAttribute("data-phfilter");
        const next = Object.assign({}, this.phFilter(pk), { [key]: ph.value || "" });
        // The choice is made, so release focus before re-rendering — otherwise
        // the guard above holds every poll off until the reader clicks away.
        if (ph.blur) ph.blur();
        return this.setState({
          phFilters: Object.assign({}, this.state.phFilters, { [pk]: next }),
        });
      }
      const el = e.target && e.target.closest ? e.target.closest("[data-feedfilter]") : null;
      if (!el) return;
      const key = el.getAttribute("data-feedfilter");
      const val = (el.value || "").trim();
      // The Data Feed's custom window rides the same delegation as the history
      // filters below, so it inherits render()'s focus guard for free — the 8s
      // poll cannot yank the date picker out from under a half-made choice.
      // Every Data Feed control that is a <select> or an <input> routes here,
      // so all of them are covered by render()'s data-feedfilter focus guard
      // and none can be re-rendered out from under a half-made choice.
      if (key === "dfFrom" || key === "dfTo" || key === "dfTeam" || key === "dfPlayer") {
        if (this.state[key] === val) return;
        this.state[key] = val;
        // The choice is made, so release focus before repainting — otherwise
        // the guard holds every poll off until the reader clicks away.
        if (el.blur) el.blur();
        // dfPlayer is applied to the returned page rather than sent, so it is
        // the one control here that does not need a refetch.
        if (key !== "dfPlayer") this.syncTrends().catch(() => {});
        return this.render();
      }
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
          // it is not already cached. Cached days are a no-op.
          if (arg !== "home") this.syncDay(false, arg);
          return;
        }
        case "goHome": return this.setState({ view: "home" });
        case "goLive": return this.setState({ view: "live" });
        // A Home pill's body: open the Live Feed on that game. The pill's own
        // open state is `openG`, which the Live Feed already reads, so the
        // game arrives expanded.
        case "goLiveGame": {
          const pk = String(arg);
          this.setState({
            view: "live",
            openG: Object.assign({}, this.state.openG, { [pk]: true }),
          });
          this.syncDay(false, "live");
          this.scrollToPill(pk);
          return;
        }
        // The metadata tier. Context is fetched on first expand and cached, so
        // collapsing and re-opening costs nothing and the 8s poll never
        // re-requests it.
        case "heroSel": return this.setState({ heroSel: arg });
        case "homeMeta": {
          const o = Object.assign({}, this.state.homeOpen);
          o[arg] = !o[arg];
          this.setState({ homeOpen: o });
          if (o[arg]) this.loadGameContext(arg);
          return;
        }
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
        // arg is "kind|id|name" — a name can hold spaces and periods but
        // never a pipe, so the first two separators are the split points.
        case "entity": {
          const i1 = arg.indexOf("|"), i2 = arg.indexOf("|", i1 + 1);
          const kind = arg.slice(0, i1);
          const id = arg.slice(i1 + 1, i2);
          const name = arg.slice(i2 + 1);
          this.setState({ entity: { kind, id: id || null, name } });
          if (id) this.loadEntityProfile(id, kind);
          return;
        }
        case "entityClose": return this.setState({ entity: null });
        case "dfSide": {
          this.state.dfSide = arg;
          this.syncTrends().catch(() => {});
          return this.render();
        }
        case "dfRole": {
          this.state.dfRole = arg;
          // The player list is per role, so a batter left selected under the
          // Pitchers role would scope everything to nothing.
          this.state.dfPlayer = "";
          this.syncTrends().catch(() => {});
          return this.render();
        }
        // Clears the four row filters and leaves the window alone — the window
        // is not a filter, it is what the page is about.
        case "dfClear": {
          Object.assign(this.state, { dfTeam: "", dfPlayer: "", dfSide: "all", dfRole: "all" });
          this.syncTrends().catch(() => {});
          return this.render();
        }
        case "dfRange": {
          this.state.dfRange = arg;
          // The accuracy rollup for the whole retained span is already held, so
          // the window is a filter over it — but trends is ranked server-side
          // per window and has to be re-asked.
          this.syncTrends().catch(() => {});
          return this.render();
        }
        // One toggle for all four levels of the history accordion. The arg is
        // the full path, so the same handler opens a day, a game under it, and
        // an at-bat under that.
        case "dfOpen": {
          const o = Object.assign({}, this.state.dfOpen);
          o[arg] = !o[arg];
          this.setState({ dfOpen: o });
          // Opening a day is what loads it: the window can span thirty slates
          // and no browser is paging thirty days of per-pitch rows up front.
          if (o[arg] && /^d-\d{4}-\d{2}-\d{2}$/.test(arg)) {
            const date = arg.slice(2);
            this.loadDayMeta(date).then(() => this.render()).catch(() => {});
            this.loadDayRows(date).then((c) => { if (c) this.render(); }).catch(() => {});
          }
          return;
        }
        // Drill-down toggles. These MUST write to state: render() replaces the
        // whole tree, so an element-local open state would last one poll.
        case "phGame": {
          const o = Object.assign({}, this.state.openG);
          o[arg] = !o[arg];
          return this.setState({ openG: o });
        }
        case "phAb": {
          const o = Object.assign({}, this.state.openAb);
          o[arg] = !o[arg];
          return this.setState({ openAb: o });
        }
        case "phClear": {
          const f = Object.assign({}, this.state.phFilters);
          delete f[arg];
          return this.setState({ phFilters: f });
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

      // The slate as one row pill per game, grouped live (latest inning
      // first) -> final -> upcoming. The pill is a shared method: the Live
      // Feed draws the same game with the same status chip, score cell and
      // game-level lines.
      const slateBlock = `
      <div style="margin-bottom:1.6rem;">
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:.2rem;">
          <h2 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0;">${esc(COPY.slateTitle)}</h2>
          <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:${this.mob() ? 10 : 11.5}px;color:var(--faint);">${esc(this.mob() ? COPY.slateHintShort : COPY.slateHint)}</span>
        </div>
        <p style="margin:.35rem 0 14px;color:var(--muted);font-size:.95rem;">${esc(COPY.slateSub)}</p>
        ${this.slatePillsHtml(this.mob())}
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
    // Just the clock, and just the countdown — the pill puts them in different
    // cells (chip and sub-line), so firstPitch()'s combined string is no use.
    clockOf(ts) {
      const t = Date.parse(ts || "");
      return isFinite(t)
        ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
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

    // ══ SLATE PILLS (Home · reused by the Live Feed) ══════════════════════
    // One row per game. Everything the pill draws comes from the /live slate
    // payload, which is the whole schedule with an explicit phase per game —
    // /games carries no inning, count or game-level call, so it is only the
    // cold-start fallback below.
    homeSlate() {
      const games = PH.games || [];
      if (games.length) {
        return games.map((g) => {
          const live = g.phase === "live";
          const has = g.score && g.score.away !== "—" && g.score.home !== "—";
          return {
            pk: String(g.gamePk), away: g.away, home: g.home,
            phase: g.phase, startTs: g.startTs, venue: g.venue || null,
            inning: live ? g.inning : null,
            half: live ? g.half : null,
            // Pregame rows arrive with a defaulted "0-0" / 0 out; showing them
            // on a game that has not started is a fabricated situation.
            count: live ? g.count : null,
            outs: live && g.outs != null ? g.outs : null,
            // games.home_score/away_score are 0, not null, before first pitch,
            // so a scheduled game reported a 0–0 score it had not played.
            score: has && g.phase !== "pregame" ? `${g.score.away} – ${g.score.home}` : null,
            // The whole market map, not just the two game-level calls: a
            // scheduled game's body reads the four micro-market opening calls
            // straight off it.
            m: g.m || null,
            ml: (g.m && g.m.game_moneyline) || null,
            tot: (g.m && g.m.game_total) || null,
            mlPre: (g.mPre && g.mPre.game_moneyline) || null,
            totPre: (g.mPre && g.mPre.game_total) || null,
            modelVersion: g.modelVersion || null,
          };
        });
      }
      // Cold start, before the first /live or /board lands: /games is enough
      // for teams, status, score and first pitch. Everything else is absent,
      // and renders as absent.
      if (!Array.isArray(SLATE)) return null;
      return SLATE.map((g) => {
        const has = g.away_score != null && g.home_score != null;
        const phase = isLiveStatus(g.status) ? "live" : isFinalStatus(g.status) ? "final" : "pregame";
        return {
          pk: String(g.game_pk),
          away: g.away_abbr || g.away_team, home: g.home_abbr || g.home_team,
          phase,
          startTs: g.start_ts, venue: g.venue_name || null,
          inning: null, half: null, count: null, outs: null,
          score: has && phase !== "pregame" ? `${g.away_score} – ${g.home_score}` : null,
          m: null, ml: null, tot: null, mlPre: null, totPre: null, modelVersion: null,
        };
      });
    }

    // Live latest-inning-first (bottom 9 above top 9 — strict inning order, a
    // blowout is not demoted), then finals as returned, then upcoming by first
    // pitch.
    slateGroups(rows) {
      const of = (p) => (rows || []).filter((g) => g.phase === p);
      const innKey = (g) => (g.inning == null ? -1 : g.inning * 2 + (g.half === "▼" ? 1 : 0));
      // Live first, latest inning at the top (bottom 9 above top 1), then what
      // is still to come, then what is already over. Finals sit last because a
      // finished game is the least urgent thing on the page.
      return [
        { title: "LIVE NOW", fg: this.C.grn, games: of("live").slice().sort((a, b) => innKey(b) - innKey(a)) },
        {
          title: "UPCOMING", fg: this.C.blue,
          games: of("pregame").slice().sort((a, b) =>
            Date.parse(a.startTs || 0) - Date.parse(b.startTs || 0)),
        },
        { title: "FINAL", fg: this.C.mut, games: of("final") },
      ];
    }

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
      return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:${mobile ? 9.5 : 10}px;font-weight:800;letter-spacing:.05em;padding:${mobile ? "2px 6px" : "3px 7px"};border-radius:${mobile ? 5 : 6}px;justify-self:start;white-space:nowrap;color:${fg};background:${bg};">${esc(text)}</span>`;
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

    // A game-level call as pick + probability, with the frozen pregame call
    // beside it once a game is under way.
    //
    // The two are genuinely different numbers on a live game: live-poll
    // overwrites game_moneyline with an MLB live win probability every poll,
    // so the headline is "who wins from here" and the PRE value is the log5
    // call the model opened with. game_total is written once by game-predict
    // and never updated, so its two values are the same row and only one is
    // drawn. `pre` is passed as null whenever there is nothing to compare.
    gameLineCell(main, pre, caption, tight) {
      const C = this.C;
      const val = (pick, prob, size, fg) => `<b style="font-size:${size}px;font-weight:800;white-space:nowrap;color:${fg || "inherit"};">${esc(pick)}</b><span style="font-family:'IBM Plex Mono',monospace;font-size:${size}px;font-weight:600;color:${prob == null ? C.faint : fg || this.accColor(prob)};">${this.pct(prob)}</span>`;
      // PRE gets its own line rather than sitting inline. Inline, a cell wraps
      // or does not depending on how long the two team abbreviations happen to
      // be, so one pill in the list is a line taller than the next — the list
      // reads as broken. A fixed three-line cell is uniform at every width.
      const preCell = pre
        ? `<span title="${esc(COPY.pregameCallNote)}" style="display:flex;align-items:baseline;gap:4px;white-space:nowrap;">
            <span style="font-size:9px;font-weight:800;letter-spacing:.05em;color:${C.faint};">PRE</span>
            ${val(pre.pick, pre.prob, tight ? 10.5 : 11, C.mut)}
          </span>`
        : "";
      return `<span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
        <span style="display:flex;align-items:baseline;gap:${tight ? 5 : 6}px;white-space:nowrap;">
          ${val(main.pick, main.prob, 12.5)}
        </span>
        ${preCell}
        <span style="font-size:9.5px;font-weight:700;letter-spacing:.05em;color:${C.faint};white-space:nowrap;">${esc(caption)}</span>
      </span>`;
    }
    // Moneyline recommendation is "home"/"away"; the cell names the side it
    // picked rather than the word, because the cell is about this game.
    mlPickOf(mkt, g) {
      const rec = mkt && mkt.recommendation;
      if (!rec) return { pick: "—", prob: null };
      return {
        pick: rec === "home" ? g.home : rec === "away" ? g.away : (this.outLabel(rec) || "—"),
        prob: mkt.modelProb,
      };
    }
    totPickOf(mkt) {
      const rec = mkt && mkt.recommendation;
      if (!rec) return { pick: "—", prob: null };
      const side = rec === "over" ? "O" : rec === "under" ? "U" : this.outLabel(rec) || "—";
      const line = mkt.line == null ? "" : ` ${Number(mkt.line)}`;
      return { pick: `${side}${line}`, prob: mkt.modelProb };
    }
    // Show the pregame call beside the headline only when the game has started
    // AND the pregame row is a different call from the one being shown. Before
    // first pitch the headline IS the pregame call, and repeating it is noise.
    preOf(main, pre, phase) {
      if (phase === "pregame" || !pre || pre.prob == null) return null;
      return pre.pick === main.pick && pre.prob === main.prob ? null : pre;
    }
    // What the two game-level cells are actually showing, which is not what the
    // handoff assumed. `game_total` is written once by game-predict and never
    // updated, so it really is a frozen pregame line. `game_moneyline` is NOT:
    // live-poll writes an MLB live win probability every poll (mlb_winprob_v1)
    // over the pregame log5 call, and slatePayloads prefers that row — so a
    // live game's moneyline is a live number and a finished game's is the win
    // probability at its last pitch.
    mlCaption(phase) {
      return phase === "live" ? "MONEYLINE · LIVE"
        : phase === "final" ? "MONEYLINE · AT FINAL"
          : "MONEYLINE · PREGAME";
    }
    totCaption(phase, hasPre) {
      if (!hasPre) return "TOTAL · PREGAME";
      return phase === "live" ? "TOTAL · LIVE" : phase === "final" ? "TOTAL · AT FINAL" : "TOTAL · PREGAME";
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
    gameMetaPairs(g) {
      const c = this.state.gameCtx[g.pk] || {};
      const ok = !!c.found;
      const txt = (v) => (v == null || v === "" ? "—" : String(v));
      const weather = ok && c.weather_condition
        ? `${c.weather_condition}${c.temp_f == null ? "" : ` · ${c.temp_f}°F`}`
        : null;
      const wind = ok && c.wind_mph != null
        ? `${c.wind_mph} mph ${c.wind_direction || ""}`.trim()
        : null;
      return [
        ["STADIUM", txt((ok && c.venue_name) || g.venue)],
        // No roof column exists in game_context, so this is honestly unknown
        // for every game rather than pending for today's.
        ["ROOF", "—"],
        ["WEATHER", txt(weather)],
        ["WIND", txt(wind)],
        ["HP UMPIRE", txt(ok ? c.hp_umpire : null)],
        ["FIRST PITCH", txt(this.clockOf(g.startTs))],
        ["ATTENDANCE", txt(ok && c.attendance != null ? Number(c.attendance).toLocaleString() : null)],
        ["MODEL VERSION", txt(g.modelVersion)],
      ];
    }
    slateMetaHtml(g, mobile) {
      const C = this.C;
      const pairs = this.gameMetaPairs(g).map(([k, v]) => `
        <span style="display:flex;flex-direction:column;gap:${mobile ? 1 : 2}px;min-width:0;">
          <span style="font-size:${mobile ? 9 : 9.5}px;font-weight:800;letter-spacing:.06em;color:${C.faint};">${esc(k)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 12 : 12.5}px;color:${C.txt};overflow:hidden;text-overflow:ellipsis;">${esc(v)}</span>
        </span>`).join("");
      const note = g.phase === "pregame" ? COPY.slateMetaNoteSched : COPY.slateMetaNote;
      const cta = `<button data-act="goLiveGame" data-arg="${esc(g.pk)}" style="border:1px solid ${C.gbd};background:#12301f;color:${C.grn};font-family:inherit;font-weight:700;cursor:pointer;${mobile
        ? `margin-top:10px;width:100%;min-height:44px;font-size:12px;border-radius:10px;`
        : `font-size:11.5px;padding:6px 12px;border-radius:999px;`}">Go to Live Feed →</button>`;

      return mobile
        ? `<div style="border-top:1px solid ${C.bd};background:${C.panel2};padding:10px 11px 11px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;">${pairs}</div>
            ${cta}
            <div style="margin-top:8px;font-size:10.5px;color:${C.faint};line-height:1.5;">${esc(note)}</div>
          </div>`
        : `<div style="border-top:1px solid ${C.bd};background:${C.panel2};padding:12px 14px 13px;">
            <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 22px;">${pairs}</div>
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid ${C.row};">
              ${cta}<span style="font-size:11px;color:${C.faint};">${esc(note)}</span>
            </div>
          </div>`;
    }

    // ── the pill ─────────────────────────────────────────────────────────
    slatePillHtml(g, mobile) {
      const C = this.C;
      const open = !!this.state.homeOpen[g.pk];
      const live = g.phase === "live";
      const final = g.phase === "final";
      const ml = this.mlPickOf(g.ml, g), tot = this.totPickOf(g.tot);
      const mlPre = this.preOf(ml, this.mlPickOf(g.mlPre, g), g.phase);
      const totPre = this.preOf(tot, this.totPickOf(g.totPre), g.phase);
      const label = `${g.away} @ ${g.home}`;
      const until = g.phase === "pregame" ? this.untilText(g.startTs) : null;
      const sub = [g.venue, until].filter(Boolean).join(" · ") || "—";
      const scoreFg = live ? C.txt : final ? C.dim : C.faint;
      const scoreSub = live
        ? (g.inning == null ? "live" : `${this.halfWord(g.half).toLowerCase()} ${g.inning}`)
        : final ? "final" : "first pitch";
      const cta = live ? "Live feed →" : final ? "Recap →" : "Preview →";
      const chev = open ? "▾" : "▸";
      const jump = `data-act="goLiveGame" data-arg="${esc(g.pk)}"`;
      const chevBtn = (style) =>
        `<button data-act="homeMeta" data-arg="${esc(g.pk)}" title="Game metadata" aria-expanded="${open}" style="${style}border:0;background:transparent;color:${C.mut};font-weight:700;cursor:pointer;line-height:1;">${chev}</button>`;

      if (mobile) {
        return `<div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};overflow:hidden;">
          <div style="display:flex;flex-direction:column;gap:7px;padding:10px 11px;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              ${this.slateChipHtml(g, true)}
              <button ${jump} style="border:0;background:transparent;padding:0;cursor:pointer;font-family:inherit;font-size:13px;font-weight:800;color:${C.txt};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;">${esc(label)}</button>
              <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:700;color:${scoreFg};white-space:nowrap;">${esc(g.score || "—")}</span>
              ${chevBtn("font-size:13px;padding:6px 2px;")}
            </div>
            <div style="display:flex;align-items:center;gap:10px;min-width:0;">
              ${this.basesHtml(true)}
              <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};white-space:nowrap;">${esc(g.count || "—")} · ${esc(g.outs == null ? "—" : `${g.outs} out`)}</span>
              <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${C.faint};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;">${esc(sub)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding-top:7px;border-top:1px solid ${C.row};">
              <span title="${esc(this.mlCaption(g.phase))}" style="display:flex;align-items:baseline;gap:5px;"><span style="font-size:9px;font-weight:800;color:${C.faint};">ML</span><b style="font-size:12px;font-weight:800;">${esc(ml.pick)}</b><span style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${ml.prob == null ? C.faint : this.accColor(ml.prob)};">${this.pct(ml.prob)}</span></span>
              <span style="display:flex;align-items:baseline;gap:5px;"><span style="font-size:9px;font-weight:800;color:${C.faint};">TOT</span><b style="font-size:12px;font-weight:800;">${esc(tot.pick)}</b><span style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${tot.prob == null ? C.faint : this.accColor(tot.prob)};">${this.pct(tot.prob)}</span></span>
              <button ${jump} style="margin-left:auto;border:0;background:transparent;color:${C.grn};font-family:inherit;font-size:11.5px;font-weight:700;cursor:pointer;padding:6px 0;">${esc(cta)}</button>
            </div>
            ${mlPre || totPre ? `<div title="${esc(COPY.pregameCallNote)}" style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:10.5px;color:${C.mut};">
              <span style="font-size:9px;font-weight:800;letter-spacing:.05em;color:${C.faint};">PREGAME</span>
              ${mlPre ? `<span style="display:flex;align-items:baseline;gap:4px;"><span style="font-size:9px;font-weight:800;color:${C.faint};">ML</span><b style="font-weight:800;">${esc(mlPre.pick)}</b><span style="font-family:'IBM Plex Mono',monospace;font-weight:600;">${this.pct(mlPre.prob)}</span></span>` : ""}
              ${totPre ? `<span style="display:flex;align-items:baseline;gap:4px;"><span style="font-size:9px;font-weight:800;color:${C.faint};">TOT</span><b style="font-weight:800;">${esc(totPre.pick)}</b><span style="font-family:'IBM Plex Mono',monospace;font-weight:600;">${this.pct(totPre.prob)}</span></span>` : ""}
            </div>` : ""}
          </div>
          ${open ? this.slateMetaHtml(g, true) : ""}
        </div>`;
      }

      // Between 1024 and 1240 there is no room for the CTA column at the
      // design's widths, and a fixed 210px matchup column pushes the page into
      // a horizontal scroll. The matchup flexes and the CTA drops — the pill
      // body still navigates, so nothing becomes unreachable.
      const tight = this.narrow();
      const cols = tight
        ? "78px minmax(0,1fr) 120px 104px 128px 128px 26px"
        : "86px minmax(0,1fr) 150px 118px 152px 152px 128px 30px";
      return `<div class="ph-card-hover" style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};overflow:hidden;">
        <div style="display:grid;grid-template-columns:${cols};gap:${tight ? 10 : 12}px;align-items:center;padding:11px 14px;">
          ${this.slateChipHtml(g, false)}
          <button ${jump} style="border:0;background:transparent;padding:0;text-align:left;cursor:pointer;font-family:inherit;color:${C.txt};display:flex;flex-direction:column;gap:2px;min-width:0;">
            <b style="font-size:13.5px;font-weight:800;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${esc(label)}</b>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${C.mut};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${esc(sub)}</span>
          </button>
          <span style="display:flex;align-items:baseline;gap:8px;font-family:'IBM Plex Mono',monospace;min-width:0;">
            <b style="font-size:19px;font-weight:700;color:${scoreFg};white-space:nowrap;">${esc(g.score || "—")}</b>
            <span style="font-size:10.5px;color:${C.faint};white-space:nowrap;">${esc(scoreSub)}</span>
          </span>
          <span style="display:flex;align-items:center;gap:10px;">
            ${this.basesHtml(false)}
            <span style="display:flex;flex-direction:column;gap:1px;font-family:'IBM Plex Mono',monospace;">
              <b style="font-size:12.5px;font-weight:600;color:${C.txt};">${esc(g.count || "—")}</b>
              <span style="font-size:10px;color:${C.faint};">${esc(g.outs == null ? "—" : `${g.outs} out`)}</span>
            </span>
          </span>
          ${this.gameLineCell(ml, mlPre, this.mlCaption(g.phase), tight)}
          ${this.gameLineCell(tot, totPre, this.totCaption(g.phase, !!totPre), tight)}
          ${tight ? "" : `<button ${jump} style="justify-self:end;border:1px solid ${C.bd};background:${C.chip};color:${C.dim};font-family:inherit;font-size:11px;font-weight:700;padding:6px 11px;border-radius:999px;cursor:pointer;white-space:nowrap;">${esc(cta)}</button>`}
          ${chevBtn("justify-self:end;font-size:14px;padding:4px;")}
        </div>
        ${open ? this.slateMetaHtml(g, false) : ""}
      </div>`;
    }

    // The three groups, plus the states that are not "a list of games".
    slatePillsHtml(mobile) {
      const C = this.C;
      const rows = this.homeSlate();
      const box = (body) =>
        `<div style="padding:1.6rem 1rem;border:1px solid ${C.bd};border-radius:12px;background:${C.panel};color:${C.mut};">${body}</div>`;
      if (rows === null) return box(`<span style="font-style:italic;">Loading today's games…</span>`);
      if (!rows.length) {
        return RECAP_ERR
          ? box(`Couldn't reach the schedule feed — a connection problem, not an empty slate.`)
          : box(`No MLB games on today's schedule.`);
      }
      return this.slateGroups(rows).filter((grp) => grp.games.length).map((grp) => `
        <div style="margin-bottom:${mobile ? 14 : 18}px;">
          <div style="display:flex;align-items:center;gap:${mobile ? 8 : 9}px;margin-bottom:${mobile ? 7 : 8}px;">
            <span style="font-size:${mobile ? 9.5 : 10}px;font-weight:800;letter-spacing:.08em;color:${grp.fg};">${grp.title}</span>
            ${mobile ? "" : `<span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${C.faint};">${grp.games.length} game${grp.games.length === 1 ? "" : "s"}</span>`}
            <span style="flex:1;height:1px;background:${C.row};"></span>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${grp.games.map((g) => this.slatePillHtml(g, mobile)).join("")}
          </div>
        </div>`).join("");
    }

    // Bring a game's pill into the viewport after jumping to the Live Feed.
    // scrollIntoView is banned here (it hijacks the scroll container and
    // fights the poll's re-render), so the offset is measured and set.
    scrollToPill(pk) {
      requestAnimationFrame(() => {
        const el = this.root.querySelector(`[data-ph-pill="${pk}"]`);
        const y = el ? Math.max(0, el.getBoundingClientRect().top + window.pageYOffset - 84) : 0;
        window.scrollTo(0, y);
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
    MICRO_LABEL = {
      pitch_speed_ou: "Pitch Speed O/U", pitch_result: "Pitch Result",
      ab_result: "At-Bat Result", ab_pitches_ou: "Pitches in AB",
    };
    // The bar a call has to clear to be badged TOP, and the cut the
    // high-confidence KPI reports. Matches the design's confidenceThreshold.
    CONF_TOP = 0.4;

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

    // ── the Data Feed window ─────────────────────────────────────────────
    DF_RANGES = [["today", "Today"], ["7d", "7 days"], ["14d", "14 days"], ["30d", "30 days"], ["custom", "Custom"]];
    dfWindow() {
      const to = PH.mlbDate(0);
      const r = this.state.dfRange || "7d";
      if (r === "custom") {
        const floor = PH.mlbDate(-(this.ACC_SPAN_DAYS - 1));
        const t = this.state.dfTo || to;
        let f = this.state.dfFrom || PH.mlbDate(-6);
        // Past the retained span the rollup has nothing, so an unclamped
        // picker would render an empty window as if the model had said nothing.
        if (f < floor) f = floor;
        return { from: f > t ? t : f, to: t };
      }
      const days = r === "today" ? 1 : Number(String(r).replace("d", "")) || 7;
      return { from: PH.mlbDate(-(days - 1)), to };
    }
    dfWindowLabel() {
      const r = this.state.dfRange || "7d";
      const hit = this.DF_RANGES.find(([k]) => k === r);
      if (r !== "custom") return (hit ? hit[1] : r).toLowerCase();
      const w = this.dfWindow();
      return `${w.from} to ${w.to}`;
    }
    // True when everything on the tab is about one slate — the only window in
    // which the row-derived surfaces below cover the whole of it.
    dfSingleDay() {
      const w = this.dfWindow();
      return w.from === w.to;
    }
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
          this.autoExpand(want);
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
      this.autoExpand(want);
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
      if (changed) this.autoExpand(today);
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
        // Ids ride along so the entity overlay can reach the warehouse
        // aggregates, which are keyed on player_id. The rows have always
        // carried them; nothing kept them.
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
    allAbs(models) {
      return [].concat.apply([], (models || []).map((g) => g.abs));
    }
    // Every pitch on the day, flattened with its at-bat and game — the input
    // the three row-derived charts share.
    flatPitches(models) {
      const out = [];
      (models || []).forEach((g) => g.abs.forEach((ab) =>
        ab.pitches.forEach((p) => out.push({ p, ab, g }))));
      return out;
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
    rate(c, n) { return n ? c / n : null; }
    accBand(r) { return r == null ? null : r >= 0.66 ? "good" : r >= 0.5 ? "amber" : "bad"; }
    accColor(r) { return r == null ? this.C.dim : this.grd(this.accBand(r)).fg; }
    outLabel(k) { return k == null ? null : (PH.OUTCOME_LABEL[k] || k); }
    maeText(m) { return m == null ? "—" : m.toFixed(1); }
    signed(v, d) {
      if (v == null) return "—";
      return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d == null ? 1 : d)}`;
    }

    // ── the hero's subject ───────────────────────────────────────────────
    // The single most confident open call on the board, across the four
    // micro-markets and every live game. It is what the hero describes, and
    // its game is the one the board drills into by default.
    bestCallIn(g) {
      let best = null;
      this.MICRO.forEach((key) => {
        const m = g.m && g.m[key];
        if (!m || !m.covered || m.modelProb == null) return;
        if (!best || m.modelProb > best.prob) {
          best = { game: g, market: key, prob: m.modelProb, m };
        }
      });
      return best;
    }
    bestCall() {
      let best = null;
      this.liveGames().forEach((g) => {
        const b = this.bestCallIn(g);
        if (b && (!best || b.prob > best.prob)) best = b;
      });
      return best;
    }
    // What the hero is about, given the Showing selection. A pinned game that
    // has since ended is not an error state — the selection silently falls back
    // to "top" rather than stranding the reader on a hero that cannot be drawn.
    heroSubject() {
      const sel = this.state.heroSel || "top";
      if (sel !== "top") {
        const g = this.liveGames().find((x) => String(x.gamePk) === String(sel));
        if (g) return { best: this.bestCallIn(g), game: g, pinned: true };
      }
      const best = this.bestCall();
      return { best, game: best ? best.game : null, pinned: false };
    }
    // One chip per live game, plus the cross-game default. Hidden entirely when
    // nothing is live: a selector over an empty set is furniture, not a control.
    heroChipsHtml(mobile) {
      const C = this.C;
      const live = this.liveGames();
      if (!live.length) return "";
      const sel = this.state.heroSel || "top";
      const chip = (arg, label, on) =>
        `<button data-act="heroSel" data-arg="${esc(arg)}" style="flex:none;border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.chip};color:${on ? C.grn : C.dim};font-family:inherit;font-weight:600;font-size:${mobile ? 11.5 : 12}px;padding:${mobile ? "7px 12px" : "6px 12px"};border-radius:999px;cursor:pointer;white-space:nowrap;">${esc(label)}</button>`;
      const chips = chip("top", "★ Top at-bat", sel === "top")
        + live.map((g) => chip(String(g.gamePk), `${g.away} @ ${g.home}`, String(sel) === String(g.gamePk))).join("");
      return mobile
        ? `<div style="display:flex;gap:6px;overflow-x:auto;margin-bottom:11px;padding-bottom:2px;">${chips}</div>`
        : `<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:12px;">
            <span style="font-size:10px;font-weight:800;letter-spacing:.06em;color:${C.faint};">SHOWING</span>${chips}
          </div>`;
    }

    // Open the live game and its at-bat in progress on first paint, then never
    // again for this date — re-seeding every poll would re-open whatever the
    // reader had just collapsed.
    autoExpand(date) {
      // Only today has a game in progress to drill into.
      if (date !== PH.mlbDate(0) || this._autoExpanded === date) return;
      const best = this.bestCall();
      if (!best) return;
      const pk = String(best.game.gamePk);
      const m = this.models(date).find((x) => x.pk === pk);
      if (!m || !m.abs.length) return;
      this._autoExpanded = date;
      const cur = m.abs[m.abs.length - 1];
      this.state.openG = Object.assign({}, this.state.openG, { [pk]: true });
      this.state.openAb = Object.assign({}, this.state.openAb, {
        [`${pk}:${cur.abi}`]: true,
      });
    }

    // Score / status / when for a pill. Today's slate is the live poll; a past
    // date comes from the /board call in loadDayMeta. Absent either way it
    // reports no score rather than inventing one.
    gameMeta(pk, date) {
      const n = Number(pk);
      const d = date || this.viewDate();
      // Today's slate is the live poll, which is fresher; any other date is
      // whatever /board returned for it.
      const pool = d === PH.mlbDate(0) && (PH.games || []).length
        ? PH.games
        : (this.state.dayMeta[d] || []);
      const g = pool.find((x) => x.gamePk === n);
      if (!g) return { score: null, phase: null, live: false, when: null };
      const has = g.score && g.score.away !== "—" && g.score.home !== "—";
      return {
        score: has ? `${g.score.away}–${g.score.home}` : null,
        phase: g.phase,
        live: g.phase === "live",
        when: g.phase === "live"
          ? `${g.half || ""}${g.inning == null ? "" : g.inning}`
          : g.phase === "final" ? "Final" : (this.firstPitch(g.startTs) || "Scheduled"),
      };
    }

    // ── shared drill-down: game -> at-bat -> pitch ───────────────────────
    // The same component on both tabs. Expansion lives in state keyed by
    // game_pk and game_pk + ":" + at_bat_index, because render() throws the
    // whole DOM away every poll — an element-local open state would last
    // eight seconds.
    phFilter(pk) {
      return this.state.phFilters[pk] || { team: "", batter: "", pitcher: "" };
    }
    // The drill-down is shared by both tabs, but its open state is not. The
    // Live Feed keys a game on its game_pk (`openG`) so the Home pill can hand
    // it a game to open; the Data Feed keys everything on a path under a day
    // (`dfOpen`), so the same game expanded under Friday does not also expand
    // under Saturday. `scope` is null for the Live Feed and { path } for the
    // Data Feed, and the three methods below are the only places that differ.
    abKey(scope, m, ab) {
      return scope ? `${scope.path}/ab-${ab.abi}` : `${m.pk}:${ab.abi}`;
    }
    abIsOpen(scope, key) {
      return scope ? !!this.state.dfOpen[key] : !!this.state.openAb[key];
    }
    abAct(scope) { return scope ? "dfOpen" : "phAb"; }
    phFilterDirty(f) { return !!(f.team || f.batter || f.pitcher); }
    // A <select> is the only control on the board that is not a chip, so it
    // carries its own styling. `selected` has to be written into the markup:
    // innerHTML is replaced wholesale, so a DOM-set value does not survive.
    phSelectHtml(pk, key, allLabel, opts, val, mobile) {
      const C = this.C;
      const opt = (v, label, on) =>
        `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;
      const body = [opt("", allLabel, !val)]
        .concat(opts.map((o) => opt(o, o, o === val))).join("");
      return `<select data-phfilter="${key}" data-arg="${esc(pk)}" style="background:${C.panel};color:${C.txt};border:1px solid ${val ? C.acc : C.bd};border-radius:7px;font-family:inherit;font-size:${mobile ? 12 : 11.5}px;font-weight:600;padding:${mobile ? "7px 8px" : "5px 8px"};max-width:190px;cursor:pointer;">${body}</select>`;
    }

    // Collapsed pill + everything it reveals.
    gamePillHtml(m, mobile, date, scope) {
      const C = this.C;
      const meta = this.gameMeta(m.pk, date);
      const st = this.gameStats(m.abs);
      // Inside the Data Feed's accordion a game is keyed by its path under a
      // day; on its own it falls back to the flat game_pk key.
      const gkey = scope ? scope.path : m.pk;
      const gact = scope ? "dfOpen" : "phGame";
      const open = scope ? !!this.state.dfOpen[gkey] : !!this.state.openG[m.pk];
      const accR = this.rate(st.abC, st.abN);
      const accC = this.accColor(accR);
      // The game's most confident at-bat call, graded or not — "what did the
      // model most want to say about this game".
      const top = m.abs.reduce(
        (a, b) => (b.predProb != null && (!a || b.predProb > a.predProb) ? b : a), null,
      );
      const topText = top
        ? `${this.outLabel(top.predLabel) || "—"} ${this.pct(top.predProb)} · ${esc(this.shortName(top.batter))}`
        : "no at-bat call yet";
      const statusFg = meta.live ? C.grn : C.faint;
      const statusText = meta.live ? "LIVE" : meta.phase === "final" ? "FINAL" : "SCHEDULED";

      const chev = `<span style="font-size:15px;font-weight:700;color:${C.dim};line-height:1;">${open ? "▾" : "▸"}</span>`;
      const matchup = `<span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
        <b style="font-size:13.5px;font-weight:800;letter-spacing:.01em;">${esc(m.label)}</b>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.mut};">${esc(meta.when || "")}</span>
      </span>`;
      const scoreCell = `<span style="display:flex;align-items:baseline;gap:7px;font-family:'IBM Plex Mono',monospace;">
        <b style="font-size:17px;font-weight:700;">${esc(meta.score || "—")}</b>
        <span style="font-size:10px;font-weight:700;letter-spacing:.05em;color:${statusFg};">${statusText}</span>
      </span>`;
      const topCell = `<span style="display:flex;align-items:center;gap:8px;min-width:0;">
        <span style="font-size:10px;font-weight:800;letter-spacing:.05em;color:${C.grn};background:rgba(74,222,128,.13);padding:2px 6px;border-radius:5px;white-space:nowrap;">TOP CALL</span>
        <span style="font-size:12px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${topText}</span>
      </span>`;
      const accCell = `<span style="display:flex;flex-direction:column;gap:3px;">
        <span style="display:flex;align-items:baseline;gap:6px;">
          <b style="font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;color:${accC};">${this.ratioPct(st.abC, st.abN)}</b>
          <span style="font-size:10.5px;color:${C.faint};">at-bat calls</span>
        </span>
        <span style="height:5px;background:${C.panel2};border-radius:999px;overflow:hidden;display:block;"><span style="display:block;height:100%;border-radius:999px;background:${accC};width:${Math.round((accR || 0) * 100)}%;"></span></span>
      </span>`;
      const pitchCell = `<span style="display:flex;flex-direction:column;gap:2px;text-align:right;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:${this.accColor(this.rate(st.pC, st.pN))};">${this.ratioPct(st.pC, st.pN)} <span style="font-size:10px;color:${C.faint};">pitch</span></span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:${C.dim};">${this.maeText(st.mae)} <span style="font-size:10px;color:${C.faint};">mph MAE</span></span>
      </span>`;

      const head = mobile
        ? `<button data-act="${gact}" data-arg="${esc(gkey)}" style="width:100%;display:flex;flex-direction:column;gap:8px;text-align:left;border:0;background:transparent;color:${C.txt};font-family:inherit;padding:11px 12px;cursor:pointer;">
            <span style="display:flex;align-items:center;gap:10px;width:100%;">${chev}${matchup}<span style="margin-left:auto;">${scoreCell}</span></span>
            <span style="display:grid;grid-template-columns:minmax(0,1fr) 116px;gap:10px;align-items:center;width:100%;">${accCell}${pitchCell}</span>
            <span style="width:100%;min-width:0;">${topCell}</span>
          </button>`
        : `<button data-act="${gact}" data-arg="${esc(gkey)}" class="ph-card-hover" style="width:100%;display:grid;grid-template-columns:18px 168px 128px minmax(0,1fr) 150px 138px;gap:14px;align-items:center;text-align:left;border:0;background:transparent;color:${C.txt};font-family:inherit;padding:12px 14px;cursor:pointer;">
            ${chev}${matchup}${scoreCell}${topCell}${accCell}${pitchCell}
          </button>`;

      return `<div data-ph-pill="${esc(m.pk)}" style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};overflow:hidden;">
        ${head}
        ${open ? this.gameBodyHtml(m, st, mobile, scope) : ""}
      </div>`;
    }

    // The at-bat list, its scoped filters, and the filtered readout.
    gameBodyHtml(m, st, mobile, scope) {
      const C = this.C;
      const f = this.phFilter(m.pk);
      const uniq = (key) => [...new Set(
        m.abs.map((ab) => ab[key]).filter((v) => v != null && v !== ""),
      )].sort();
      const abs = m.abs.filter((ab) =>
        (!f.team || ab.team === f.team)
        && (!f.batter || ab.batter === f.batter)
        && (!f.pitcher || ab.pitcher === f.pitcher));
      const fst = this.gameStats(abs);
      const dirty = this.phFilterDirty(f);
      // Scoped to the whole game, not the filtered subset: the standout call is
      // a fact about the game, and it must not move when a filter is applied.
      const topProb = m.abs.reduce(
        (a, x) => (x.predProb != null && (a == null || x.predProb > a) ? x.predProb : a), null,
      );

      const fact = (label, body) =>
        `<span style="white-space:nowrap;">${label ? `${esc(label)} ` : ""}${body}</span>`;
      const tinted = (c2, n2) =>
        `<span style="color:${this.accColor(this.rate(c2, n2))};">${this.ratioPct(c2, n2)}</span>`;
      const readout = dirty
        ? fact(`${abs.length} of ${m.abs.length} at-bats`, "") + fact("calls", tinted(fst.abC, fst.abN)) + fact("MAE", this.maeText(fst.mae))
        : fact(`all ${m.abs.length} at-bats`, "") + fact("pitch", tinted(st.pC, st.pN)) + fact("MAE", this.maeText(st.mae));

      const filters = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:11px;">
        <span style="font-size:10px;font-weight:800;letter-spacing:.06em;color:${C.faint};">FILTER</span>
        ${this.phSelectHtml(m.pk, "team", "All teams", [m.away, m.home].filter(Boolean), f.team, mobile)}
        ${this.phSelectHtml(m.pk, "batter", "All batters", uniq("batter"), f.batter, mobile)}
        ${this.phSelectHtml(m.pk, "pitcher", "All pitchers", uniq("pitcher"), f.pitcher, mobile)}
        ${dirty ? `<button data-act="phClear" data-arg="${esc(m.pk)}" style="border:1px solid ${C.bd};background:transparent;color:${C.dim};font-family:inherit;font-size:11px;font-weight:600;padding:5px 9px;border-radius:7px;cursor:pointer;">Clear</button>` : ""}
        <span style="margin-left:auto;display:flex;gap:14px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.mut};">${readout}</span>
      </div>`;

      const cols = "16px 34px minmax(0,1fr) minmax(0,1fr) 208px 96px 88px";
      const header = mobile ? "" : `<div style="display:grid;grid-template-columns:${cols};gap:10px;padding:0 8px 6px;">
        ${["#", "INN", "BATTER", "PITCHER", "CALL → RESULT", "PITCHES", "PITCH ACC"].map((h, i) =>
          `<span style="font-size:9.5px;font-weight:800;letter-spacing:.05em;color:${C.faint};${i >= 5 ? "text-align:right;" : ""}">${h}</span>`).join("")}
      </div>`;

      const body = abs.length
        ? `<div style="display:flex;flex-direction:column;gap:4px;">${abs.map((ab, i) => this.abRowHtml(m, ab, cols, mobile, i + 1, topProb, scope)).join("")}</div>`
        : `<div style="padding:16px 8px;font-size:12px;color:${C.faint};">No at-bats match this filter.</div>`;

      return `<div style="border-top:1px solid ${C.bd};background:${C.panel2};padding:12px ${mobile ? 10 : 14}px 14px;">
        ${filters}${header}${body}
      </div>`;
    }

    abRowHtml(m, ab, cols, mobile, ord, topProb, scope) {
      const C = this.C;
      const key = this.abKey(scope, m, ab);
      const open = this.abIsOpen(scope, key);
      const act = this.abAct(scope);
      const s = this.abStats(ab);
      const pAcc = this.rate(s.c, s.n);
      // Graded green/red; an at-bat still in progress stays neutral rather than
      // borrowing the miss styling.
      const gband = ab.ok == null ? null : ab.ok ? "good" : "bad";
      const g = this.grd(gband);
      // Over the bar AND the most confident call in this game.
      const isTop = ab.predProb != null
        && ab.predProb >= this.CONF_TOP
        && topProb != null && ab.predProb >= topProb - 1e-9;

      const call = `<span style="display:flex;align-items:baseline;gap:6px;padding:3px 7px;border-radius:7px;white-space:nowrap;overflow:hidden;background:${g.bg};">
        <b style="font-size:11.5px;font-weight:700;color:${gband ? g.fg : C.dim};">${esc(this.outLabel(ab.predLabel) || "—")}</b>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.mut};">${this.pct(ab.predProb)}</span>
        <span style="font-size:10px;color:${C.faint};">→ ${esc(this.outLabel(ab.actual) || "pending")}</span>
      </span>`;
      const batter = `<span style="display:flex;align-items:center;gap:6px;min-width:0;">
        ${ab.team ? this.entityLinkHtml("TEAM", null, ab.team, esc(ab.team), `font-size:9.5px;font-weight:800;color:${C.blue};`) : ""}
        ${this.entityLinkHtml("BATTER", ab.batterId, ab.batter, esc(this.shortName(ab.batter)), "font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;")}
        ${isTop ? `<span style="font-size:9.5px;font-weight:800;color:${C.grn};background:rgba(74,222,128,.13);padding:2px 5px;border-radius:4px;white-space:nowrap;">TOP</span>` : ""}
        ${ab.back ? this.bfTag() : ""}
      </span>`;

      const head = mobile
        ? `<button data-act="${act}" data-arg="${esc(key)}" style="width:100%;display:flex;flex-direction:column;gap:6px;text-align:left;border:0;background:transparent;color:${C.txt};font-family:inherit;padding:9px 10px;cursor:pointer;">
            <span style="display:flex;align-items:center;gap:8px;width:100%;min-width:0;">
              <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">${esc(ab.inn)}</span>
              ${batter}
            </span>
            <span style="display:flex;align-items:center;gap:8px;width:100%;min-width:0;">
              ${call}
              <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${this.accColor(pAcc)};white-space:nowrap;">${this.ratioPct(s.c, s.n)}</span>
            </span>
            <span style="font-size:11px;color:${C.faint};">vs ${this.entityLinkHtml("PITCHER", ab.pitcherId, ab.pitcher, esc(this.shortName(ab.pitcher)), `color:${C.faint};`)}</span>
          </button>`
        : `<button data-act="${act}" data-arg="${esc(key)}" style="width:100%;display:grid;grid-template-columns:${cols};gap:10px;align-items:center;text-align:left;border:0;background:transparent;color:${C.txt};font-family:inherit;padding:8px;cursor:pointer;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};" title="at_bat_index ${esc(ab.abi)}">${ord}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};">${esc(ab.inn)}</span>
            ${batter}
            ${this.entityLinkHtml("PITCHER", ab.pitcherId, ab.pitcher, esc(this.shortName(ab.pitcher)), `font-size:12px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`)}
            ${call}
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};text-align:right;">${ab.actPitches} / ${ab.projPitches == null ? "—" : ab.projPitches.toFixed(1)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${this.accColor(pAcc)};text-align:right;">${this.ratioPct(s.c, s.n)}</span>
          </button>`;

      return `<div style="border:1px solid ${C.row};border-radius:9px;background:${C.panel};overflow:hidden;">
        ${head}
        ${open ? this.pitchTableHtml(ab, s, mobile) : ""}
      </div>`;
    }

    // Reconstructed calls sit in the same table and count the same way, so the
    // only thing separating them is this mark. Muted rather than alarming — the
    // call is real, it just was not made at the time.
    bfTag() {
      return `<span title="Reconstructed after the fact — not a live call" style="font-size:9px;font-weight:800;letter-spacing:.04em;background:rgba(160,160,160,.16);color:${this.C.mut};padding:2px 4px;border-radius:4px;">BF</span>`;
    }

    pitchTableHtml(ab, s, mobile) {
      const C = this.C;
      const cols = "18px 38px 38px 130px minmax(0,1fr) 78px";
      const head = mobile ? "" : `<div style="display:grid;grid-template-columns:${cols};gap:10px;padding:0 4px 5px;">
        ${["P", "CNT", "TYPE", "VELO ACT · CALL · Δ", "RESULT vs CALL", "GRADE"].map((h, i) =>
          `<span style="font-size:9.5px;font-weight:800;letter-spacing:.05em;color:${C.faint};${i === 5 ? "text-align:right;" : ""}">${h}</span>`).join("")}
      </div>`;

      const rows = ab.pitches.map((p) => {
        const vb = this.veloBand(p.err);
        const v = this.grd(vb);
        const rband = p.ok == null ? null : p.ok ? "good" : "bad";
        const r = this.grd(rband);
        const veloCell = `<span style="display:inline-flex;align-items:baseline;gap:6px;padding:2px 7px;border-radius:6px;white-space:nowrap;background:${v.bg};">
          <b style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;color:${vb ? v.fg : C.dim};">${p.velo == null ? "—" : p.velo.toFixed(1)}</b>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.mut};">${p.predVelo == null ? "—" : p.predVelo.toFixed(1)}${p.delta == null ? "" : ` · ${this.signed(p.delta)}`}</span>
        </span>`;
        const resCell = `<span style="display:inline-flex;align-items:baseline;gap:6px;min-width:0;">
          <b style="font-size:11.5px;font-weight:700;color:${rband ? r.fg : C.dim};">${esc(this.outLabel(p.result) || "pending")}</b>
          <span style="font-size:10.5px;color:${C.faint};white-space:nowrap;">called ${esc(this.outLabel(p.predResult) || "—")}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.mut};">${this.pct(p.predProb)}</span>
        </span>`;
        // One chip for the pitch as a whole: the class call it got right or
        // wrong, and how far the velocity call missed by.
        const gband = p.ok == null ? null
          : p.ok && vb !== "bad" ? "good"
            : !p.ok && vb === "bad" ? "bad" : "amber";
        const gg = this.grd(gband);
        const gradeText = p.ok == null ? "PENDING"
          : `${p.ok ? "HIT" : "MISS"}${p.err == null ? "" : ` · ${Math.abs(p.err).toFixed(1)}`}`;
        const grade = `<span style="display:inline-block;font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:600;padding:2px 6px;border-radius:5px;color:${gband ? gg.fg : C.faint};background:${gg.bg};white-space:nowrap;">${gradeText}</span>`;

        if (mobile) {
          return `<div style="display:flex;flex-direction:column;gap:5px;padding:8px 4px;border-top:1px solid ${C.panel};">
            <span style="display:flex;align-items:center;gap:8px;">
              <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">#${p.n}</span>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};">${esc(p.count || "—")}</span>
              <span style="font-size:11px;font-weight:800;color:${this.pitchColor(p.type)};">${esc(p.type || "—")}</span>
              ${p.back ? this.bfTag() : ""}
              <span style="margin-left:auto;">${grade}</span>
            </span>
            <span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${veloCell}${resCell}</span>
          </div>`;
        }
        return `<div style="display:grid;grid-template-columns:${cols};gap:10px;align-items:center;padding:5px 4px;border-top:1px solid ${C.panel};">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">${p.n}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};">${esc(p.count || "—")}</span>
          <span style="font-size:11px;font-weight:800;color:${this.pitchColor(p.type)};">${esc(p.type || "—")}</span>
          ${veloCell}${resCell}
          <span style="text-align:right;">${grade}</span>
        </div>`;
      }).join("");

      const footer = `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:9px;padding-top:8px;border-top:1px solid ${C.panel};font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.mut};">
        <span>pitch result <span style="color:${this.accColor(this.rate(s.c, s.n))};">${this.ratioPct(s.c, s.n)}</span></span>
        <span>velo MAE ${this.maeText(s.mae)} mph</span>
        <span>proj pitches ${ab.projPitches == null ? "—" : ab.projPitches.toFixed(1)} · actual ${ab.actPitches}</span>
      </div>`;

      return `<div style="border-top:1px solid ${C.row};background:${C.panel3};padding:9px 10px 11px;">
        ${head}
        ${rows || `<div style="font-size:12px;color:${C.faint};padding:6px 4px;">No pitch calls recorded for this at-bat.</div>`}
        ${footer}
      </div>`;
    }

    // The whole list, plus the states that are not "a list of games".
    gamePillsHtml(models, mobile, date) {
      const C = this.C;
      const d = date || this.viewDate();
      const dr = this.dayState(d);
      const box = (body) =>
        `<div style="padding:2.6rem 1rem;text-align:center;border:1px solid ${C.bd};border-radius:14px;background:${C.panel};">${body}</div>`;

      if (!dr.loaded || (!models.length && dr.pending)) {
        return box(`<div style="color:${C.mut};font-size:.92rem;">Loading the day's calls${dr.pending ? ` · ${dr.pending} game${dr.pending === 1 ? "" : "s"} to go` : ""}…</div>`);
      }
      if (dr.err) {
        return `<div style="padding:1.1rem 1.2rem;border:1px solid ${C.bd};border-left:3px solid ${C.red};border-radius:14px;background:${C.panel};">
          <div style="font-size:13px;font-weight:700;">Couldn't reach the prediction feed</div>
          <div style="font-size:12px;color:${C.mut};margin-top:5px;line-height:1.5;">Showing whatever was already loaded. This is a connection problem, not a slate on which nothing was called.</div>
        </div>`;
      }
      if (!models.length) {
        // A full slate with no calls is a slate before first pitch. Saying "no
        // games were played" at 10am on a 15-game day is simply false, and it
        // is the state the board spends every morning in.
        const scheduled = this.slateFor(d).length;
        if (scheduled) {
          return box(`<div style="font-size:1.02rem;font-weight:700;margin-bottom:.35rem;">${scheduled} game${scheduled === 1 ? "" : "s"} scheduled · nothing called yet</div>
            <div style="font-size:.9rem;color:${C.mut};">Calls are made and graded pitch by pitch. The first game to start fills in here.</div>`);
        }
        return box(`<div style="font-size:1.02rem;font-weight:700;margin-bottom:.35rem;">No calls for ${esc(d)}</div>
          <div style="font-size:.9rem;color:${C.mut};">Either no games were scheduled, or the day has aged past the ${this.DF_RETAIN_DAYS}-day prediction window.</div>`);
      }
      // Games are spliced in whole, so anything already on screen is complete.
      // These notes are about what is still missing, never a caveat on what is
      // shown — a pill that is up is a pill whose numbers are final.
      const notes = [
        dr.pending
          ? `Loading ${dr.pending} more game${dr.pending === 1 ? "" : "s"}…`
          : null,
        dr.partial
          ? "Some games on this slate couldn't be loaded and are missing below."
          : null,
      ].filter(Boolean).map((t, i) =>
        `<div style="font-size:11.5px;color:${i && dr.partial ? C.amb : C.mut};padding:0 2px 6px;">${esc(t)}</div>`).join("");

      return `${notes}<div style="display:flex;flex-direction:column;gap:7px;">${models.map((m) => this.gamePillHtml(m, mobile, d)).join("")}</div>`;
    }

    // How far back `predictions` is retained. The stepper clamps to it, and the
    // empty state names it so an aged-out day reads as aged out rather than as
    // a day the model said nothing about.
    DF_RETAIN_DAYS = 20;

    // == LIVE FEED PILLS ==================================================
    // Every game on the slate, not only the ones with graded rows. A scheduled
    // game has no at-bat history -- it has the frozen pregame call the model
    // opened with, which is what its body shows.

    // The model's opening read on a game that has not started. game-predict
    // scores all four micro-markets pregame against both probable starters and
    // a league-average batter (it cannot know the lineup), so this is a real
    // published call, not a placeholder.
    openingCall(g) {
      const pres = g.m && g.m.pitch_result;
      if (!pres || !pres.covered || pres.modelProb == null) return null;
      return { label: this.outLabel(pres.recommendation) || "—", prob: pres.modelProb };
    }
    // The call chip and its one-line summary, per phase.
    liveCallCell(g, model, mobile) {
      const C = this.C;
      let chipText, chipFg, chipBg, text;
      if (g.phase === "pregame") {
        const oc = this.openingCall(g);
        chipText = "FIRST AB"; chipFg = C.blue; chipBg = "#16294a";
        text = oc ? `${oc.label} ${this.pct(oc.prob)} · opening call` : "no opening call published yet";
      } else {
        const top = ((model && model.abs) || []).reduce(
          (a, b) => (b.predProb != null && (!a || b.predProb > a.predProb) ? b : a), null,
        );
        const liveG = g.phase === "live";
        chipText = liveG ? "TOP CALL" : "GRADED";
        chipFg = liveG ? C.grn : C.mut;
        chipBg = liveG ? "rgba(74,222,128,.13)" : C.chip;
        text = top
          ? `${this.outLabel(top.predLabel) || "—"} ${this.pct(top.predProb)} · ${this.shortName(top.batter)}`
          : "no at-bat call yet";
      }
      return `<span style="display:flex;align-items:center;gap:8px;min-width:0;">
        <span style="font-size:10px;font-weight:800;letter-spacing:.05em;color:${chipFg};background:${chipBg};padding:2px 6px;border-radius:5px;white-space:nowrap;">${chipText}</span>
        <span style="font-size:${mobile ? 11.5 : 12}px;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;">${esc(text)}</span>
      </span>`;
    }
    // At-bat record with its percentage and a progress bar. A game with nothing
    // graded shows an em-dash and an empty track, never 0%.
    liveAccCell(model, mobile) {
      const C = this.C;
      const st = model ? this.gameStats(model.abs) : { abC: 0, abN: 0 };
      const r = this.rate(st.abC, st.abN);
      const fg = this.accColor(r);
      return `<span style="display:flex;flex-direction:column;gap:3px;min-width:0;">
        <span style="display:flex;align-items:baseline;gap:6px;">
          <b style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 12 : 13}px;font-weight:600;color:${fg};white-space:nowrap;">${this.ratioPct(st.abC, st.abN)}</b>
          <span style="font-size:10.5px;color:${C.faint};white-space:nowrap;">at-bat calls</span>
        </span>
        <span style="height:5px;background:${C.panel2};border-radius:999px;overflow:hidden;display:block;"><span style="display:block;height:100%;border-radius:999px;background:${fg};width:${Math.round((r || 0) * 100)}%;"></span></span>
      </span>`;
    }
    // The body of a game that has not started: the four opening calls, and the
    // note saying what is still missing and why.
    openingBodyHtml(g, mobile) {
      const C = this.C;
      const cells = this.MICRO.map((key) => {
        const m = g.m && g.m[key];
        const covered = !!(m && m.covered && m.modelProb != null);
        const val = !covered ? "—"
          : m.kind === "ou"
            ? `${this.outLabel(m.recommendation) || "—"}${m.line == null ? "" : ` ${Number(m.line)}`}`
            : (this.outLabel(m.recommendation) || "—");
        const proj = covered && m.kind === "ou" && m.predictedValue != null
          ? `proj ${Number(m.predictedValue).toFixed(1)}` : "";
        return `<span style="display:flex;flex-direction:column;gap:3px;min-width:0;">
          <span style="font-size:9.5px;font-weight:800;letter-spacing:.05em;color:${C.faint};">${esc((this.MICRO_LABEL[key] || key).toUpperCase())}</span>
          <span style="display:flex;align-items:baseline;gap:6px;">
            <b style="font-size:12.5px;font-weight:700;color:${covered ? C.txt : C.faint};">${esc(val)}</b>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${covered ? C.grn : C.faint};">${this.pct(covered ? m.modelProb : null)}</span>
          </span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.faint};">${esc(proj)}</span>
        </span>`;
      }).join("");
      return `<div style="border-top:1px solid ${C.bd};background:${C.panel2};padding:12px ${mobile ? 10 : 14}px 14px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
          <span style="font-size:10px;font-weight:800;letter-spacing:.06em;color:${C.faint};">OPENING AT-BAT PREDICTIONS</span>
          <span style="font-size:11px;color:${C.faint};">${esc(COPY.openingCallNote)}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(${mobile ? 2 : 4},minmax(0,1fr));gap:12px 18px;">${cells}</div>
      </div>`;
    }

    liveGamePillHtml(g, model, mobile) {
      const C = this.C;
      const open = !!this.state.openG[g.pk];
      const live = g.phase === "live";
      const final = g.phase === "final";
      const ml = this.mlPickOf(g.ml, g), tot = this.totPickOf(g.tot);
      const mlPre = this.preOf(ml, this.mlPickOf(g.mlPre, g), g.phase);
      const until = g.phase === "pregame" ? this.untilText(g.startTs) : null;
      const sub = [g.venue, until].filter(Boolean).join(" · ") || "—";
      const scoreFg = live ? C.txt : final ? C.dim : C.faint;
      const scoreSub = live
        ? (g.inning == null ? "live" : `${this.halfWord(g.half).toLowerCase()} ${g.inning}`)
        : final ? "final" : "first pitch";
      const chev = open ? "▾" : "▸";
      const bd = live ? C.gbd : C.bd;
      // One column carries both game-level calls, per the design: the moneyline
      // on the value line, the total in the caption beneath it.
      const mlTag = live ? "ML LIVE" : final ? "ML AT FINAL" : "ML PREGAME";
      const linesCell = `<span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
        <span style="display:flex;align-items:baseline;gap:6px;white-space:nowrap;">
          <b style="font-size:12.5px;font-weight:800;">${esc(ml.pick)}</b>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;color:${ml.prob == null ? C.faint : this.accColor(ml.prob)};">${this.pct(ml.prob)}</span>
          ${mlPre ? `<span title="${esc(COPY.pregameCallNote)}" style="font-size:9px;font-weight:800;letter-spacing:.05em;color:${C.faint};">PRE</span><span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${C.mut};">${esc(mlPre.pick)} ${this.pct(mlPre.prob)}</span>` : ""}
        </span>
        <span style="font-size:9.5px;font-weight:700;letter-spacing:.05em;color:${C.faint};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(`${mlTag} · ${tot.pick} ${this.pct(tot.prob)} TOTAL`)}</span>
      </span>`;

      const head = mobile
        ? `<button data-act="phGame" data-arg="${esc(g.pk)}" style="width:100%;display:flex;flex-direction:column;gap:7px;text-align:left;border:0;background:transparent;color:${C.txt};font-family:inherit;padding:10px 11px;cursor:pointer;">
            <span style="display:flex;align-items:center;gap:8px;width:100%;min-width:0;">
              <span style="font-size:13px;color:${C.dim};line-height:1;">${chev}</span>
              ${this.slateChipHtml(g, true)}
              <b style="font-size:13px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;">${esc(`${g.away} @ ${g.home}`)}</b>
              <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:15px;font-weight:700;color:${scoreFg};white-space:nowrap;">${esc(g.score || "—")}</span>
            </span>
            <span style="display:flex;align-items:center;gap:12px;width:100%;min-width:0;">
              ${this.basesHtml(true)}
              <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};white-space:nowrap;">${esc(g.count || "—")} · ${esc(g.outs == null ? "—" : `${g.outs} out`)}</span>
              <span style="margin-left:auto;min-width:0;">${linesCell}</span>
            </span>
            <span style="width:100%;min-width:0;">${this.liveCallCell(g, model, true)}</span>
            <span style="width:100%;min-width:0;">${this.liveAccCell(model, true)}</span>
          </button>`
        : `<button data-act="phGame" data-arg="${esc(g.pk)}" style="width:100%;display:grid;grid-template-columns:${this.narrow()
            ? "16px 74px minmax(0,1fr) 112px 88px 148px minmax(0,1fr) 126px"
            : "18px 84px 190px 132px 118px 150px minmax(0,1fr) 140px"};gap:${this.narrow() ? 10 : 12}px;align-items:center;text-align:left;border:0;background:transparent;color:${C.txt};font-family:inherit;padding:12px 14px;cursor:pointer;">
            <span style="font-size:15px;font-weight:700;color:${C.dim};line-height:1;">${chev}</span>
            ${this.slateChipHtml(g, false)}
            <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
              <b style="font-size:13.5px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(`${g.away} @ ${g.home}`)}</b>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${C.mut};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(sub)}</span>
            </span>
            <span style="display:flex;align-items:baseline;gap:8px;font-family:'IBM Plex Mono',monospace;min-width:0;">
              <b style="font-size:18px;font-weight:700;color:${scoreFg};white-space:nowrap;">${esc(g.score || "—")}</b>
              <span style="font-size:10.5px;color:${C.faint};white-space:nowrap;">${esc(scoreSub)}</span>
            </span>
            <span style="display:flex;align-items:center;gap:8px;min-width:0;">
              ${this.basesHtml(false)}
              <span style="display:flex;flex-direction:column;gap:1px;font-family:'IBM Plex Mono',monospace;">
                <b style="font-size:12.5px;font-weight:600;">${esc(g.count || "—")}</b>
                <span style="font-size:10px;color:${C.faint};">${esc(g.outs == null ? "—" : `${g.outs} out`)}</span>
              </span>
            </span>
            ${linesCell}
            ${this.liveCallCell(g, model, false)}
            ${this.liveAccCell(model, false)}
          </button>`;

      let body = "";
      if (open) {
        body = g.phase === "pregame"
          ? this.openingBodyHtml(g, mobile)
          : model
            ? this.gameBodyHtml(model, this.gameStats(model.abs), mobile, null)
            : `<div style="border-top:1px solid ${C.bd};background:${C.panel2};padding:14px;font-size:12.5px;color:${C.faint};line-height:1.5;">${esc(COPY.noGradedRows)}</div>`;
      }
      return `<div data-ph-pill="${esc(g.pk)}" style="border:1px solid ${bd};border-radius:12px;background:${C.panel};overflow:hidden;">
        ${head}${body}
      </div>`;
    }

    // The whole Live Feed list: the slate in live -> final -> upcoming order,
    // each game matched to its built model where one exists.
    liveGamePillsHtml(models, mobile, date) {
      const C = this.C;
      const rows = this.homeSlate();
      const dr = this.dayState(date);
      const box = (body) =>
        `<div style="padding:2.6rem 1rem;text-align:center;border:1px solid ${C.bd};border-radius:14px;background:${C.panel};color:${C.mut};font-size:.92rem;">${body}</div>`;
      if (rows === null) return box("Loading today's games…");
      if (!rows.length) {
        return box(RECAP_ERR
          ? "Couldn't reach the schedule feed — a connection problem, not an empty slate."
          : "No MLB games on today's schedule.");
      }
      const byPk = new Map((models || []).map((m) => [m.pk, m]));
      const ordered = [].concat.apply([], this.slateGroups(rows).map((grp) => grp.games));
      // Notes are about what is still missing, never a caveat on what is shown:
      // a game is spliced in whole, so a pill that is up is final.
      const notes = [
        dr.pending ? `Loading calls for ${dr.pending} more game${dr.pending === 1 ? "" : "s"}…` : null,
        dr.err ? "Couldn't reach the prediction feed — the game lines above are unaffected." : null,
        dr.partial ? "Some games on this slate couldn't be loaded and show no at-bat record." : null,
      ].filter(Boolean).map((t) =>
        `<div style="font-size:11.5px;color:${dr.partial || dr.err ? C.amb : C.mut};padding:0 2px 6px;">${esc(t)}</div>`).join("");
      return `${notes}<div style="display:flex;flex-direction:column;gap:7px;">${
        ordered.map((g) => this.liveGamePillHtml(g, byPk.get(g.pk) || null, mobile)).join("")
      }</div>`;
    }

    // ── Live Feed ────────────────────────────────────────────────────────
    // Hero on top of the shared drill-down. The hero reads /live, which is
    // ~8s fresh; the pills read the graded feed, which lags by the settle job.
    // Mixing them is deliberate: the call being made now and the record of
    // calls already graded are different questions.
    heroHtml(best, models, mobile, pinned) {
      const C = this.C;
      const g = best.game;
      const m = best.m;
      const model = (models || []).find((x) => x.pk === String(g.gamePk));
      const gs = model ? this.gameStats(model.abs) : { abC: 0, abN: 0 };
      const nc = this.nextCall(g);
      const covered = this.MICRO.filter((k) => g.m && g.m[k] && g.m[k].covered).length;

      const label = m.kind === "ou"
        ? `${this.outLabel(m.recommendation) || "—"}${m.line == null ? "" : ` ${m.line}`}`
        : (this.outLabel(m.recommendation) || "—");
      // The subject changed with the Showing selector, so the badge and the
      // note have to say which question is being answered — otherwise a pinned
      // game reads as a claim that it holds the board's best call.
      const badge = pinned ? "SELECTED GAME" : "TOP AT-BAT · ALL GAMES";
      const openN = this.liveGames().reduce((a2, x) => a2 + (this.bestCallIn(x) ? 1 : 0), 0);
      const note = pinned
        ? "the open at-bat in this game"
        : `highest model probability of ${openN} open at-bat${openN === 1 ? "" : "s"}`;
      const why = pinned
        ? `${esc(this.shortName(g.batter.name))} vs ${esc(this.shortName(g.pitcher.name))} — the model's most confident open call in this game, across the ${covered === 1 ? "one covered micro-market" : `${covered} covered micro-markets`}.`
        : `${esc(this.shortName(g.batter.name))} vs ${esc(this.shortName(g.pitcher.name))} — the model's most confident open call across the ${covered === 1 ? "one covered micro-market" : `${covered} covered micro-markets`}.`;

      // The distribution is the pitch_result market's own probs, straight off
      // /live. The graded feed does not carry them — pitchfeed.ts selects
      // confidence but not probs — so this is the only place they exist.
      const dist = nc.rows.length
        ? nc.rows.map((r) => `<div style="display:grid;grid-template-columns:${mobile ? 88 : 96}px minmax(0,1fr) 46px;gap:10px;align-items:center;">
            <span style="font-size:12.5px;color:${C.gsub};">${esc(r.label)}</span>
            <span style="height:7px;background:${C.panel3};border-radius:999px;overflow:hidden;display:block;"><span style="display:block;height:100%;border-radius:999px;background:${r.rec ? C.acc : C.gbd};width:${r.pct}%;"></span></span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;text-align:right;">${r.pct}%</span>
          </div>`).join("")
        : `<div style="font-size:12px;color:${C.gsub};font-style:italic;">No pitch-result distribution on this call yet.</div>`;

      const spd = (g.m && g.m.pitch_speed_ou) || {};
      const abp = (g.m && g.m.ab_pitches_ou) || {};
      const tile = (v, lab, fg) => `<div style="display:flex;flex-direction:column;gap:2px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:19px;font-weight:700;color:${fg || C.txt};">${esc(v)}</span>
        <span style="font-size:10.5px;font-weight:700;letter-spacing:.05em;color:${C.gsub};">${lab}</span>
      </div>`;

      return `<div style="border:1px solid ${C.gbd};border-radius:14px;background:${C.gbg};padding:16px 18px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
          <span style="font-size:10px;font-weight:800;letter-spacing:.09em;color:${C.grn};background:rgba(74,222,128,.14);padding:3px 7px;border-radius:5px;">${esc(badge)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.gsub};">${esc(g.away)} @ ${esc(g.home)} · ${esc(g.half || "")}${esc(g.inning == null ? "" : g.inning)} · ${esc(g.count || "0-0")}</span>
          <span style="margin-left:auto;font-size:11.5px;color:${C.gsub};">${esc(note)}</span>
        </div>
        <div style="display:flex;align-items:baseline;gap:11px;flex-wrap:wrap;margin-bottom:4px;">
          <span style="font-size:${mobile ? 24 : 30}px;font-weight:800;letter-spacing:-.03em;line-height:1;">${esc(label)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 19 : 23}px;font-weight:600;color:${C.grn};line-height:1;">${this.pct(best.prob)}</span>
          <span style="font-size:12px;color:${C.gsub};">${esc(this.MICRO_LABEL[best.market] || best.market)}</span>
        </div>
        <div style="font-size:12.5px;color:${C.gsub};margin-bottom:14px;line-height:1.5;">${why}</div>
        <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:15px;">${dist}</div>
        <div style="display:flex;gap:22px;flex-wrap:wrap;border-top:1px solid ${C.gbd};padding-top:12px;">
          ${tile(spd.predictedValue == null ? "—" : Number(spd.predictedValue).toFixed(1), "PROJ VELO (MPH)")}
          ${tile(abp.predictedValue == null ? "—" : Number(abp.predictedValue).toFixed(1), "PROJ PITCHES IN AB")}
          ${tile(this.ratioPct(gs.abC, gs.abN), "CALLS CORRECT THIS GAME", gs.abN ? this.accColor(this.rate(gs.abC, gs.abN)) : C.dim)}
        </div>
      </div>`;
    }

    // The plate appearance in progress, pitch by pitch. Read from /live rather
    // than from the graded feed: every pitch here already carries the call made
    // before it, and it is current to the last poll rather than to the last
    // settle.
    currentAbHtml(g, mobile) {
      const C = this.C;
      const pitches = g.pitches || [];
      let c = 0, n = 0, es = 0, en = 0;
      pitches.forEach((p) => {
        const pr = p.pred;
        if (pr && pr.resultOk != null) { n += 1; if (pr.resultOk) c += 1; }
        if (pr && pr.speed != null && p.speed != null) { es += Math.abs(p.speed - pr.speed); en += 1; }
      });
      const mae = en ? es / en : null;

      const rows = pitches.map((p, i) => {
        const pr = p.pred || {};
        // Supabase stores balls/strikes AFTER the pitch, so the count a pitch
        // was thrown into is the previous pitch's — and 0-0 for the first.
        const prev = i > 0 ? pitches[i - 1] : null;
        const count = prev ? `${prev.balls}-${prev.strikes}` : "0-0";
        const d = pr.speed != null && p.speed != null ? p.speed - pr.speed : null;
        const vb = this.veloBand(d);
        const v = this.grd(vb);
        const rband = pr.resultOk == null ? null : pr.resultOk ? "good" : "bad";
        const r = this.grd(rband);
        return `<div style="display:grid;grid-template-columns:14px 28px 26px ${mobile ? "minmax(0,1fr)" : "116px minmax(0,1fr)"};gap:7px;align-items:center;padding:5px 7px;border-radius:7px;background:${C.panel2};">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">${esc(p.n)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};">${esc(count)}</span>
          <span style="font-size:11px;font-weight:800;color:${this.pitchColor(p.type)};">${esc(p.type)}</span>
          <span style="display:flex;align-items:baseline;gap:5px;padding:2px 6px;border-radius:6px;white-space:nowrap;background:${v.bg};">
            <b style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;color:${vb ? v.fg : C.dim};">${p.speed == null ? "—" : p.speed.toFixed(1)}</b>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.mut};">${pr.speed == null ? "" : pr.speed.toFixed(1)}${d == null ? "" : ` · ${this.signed(d)}`}</span>
          </span>
          ${mobile ? "" : `<span style="display:flex;align-items:baseline;gap:5px;padding:2px 6px;border-radius:6px;white-space:nowrap;overflow:hidden;background:${r.bg};">
            <b style="font-size:11.5px;font-weight:700;color:${rband ? r.fg : C.dim};">${esc(this.outLabel(p.cat) || "—")}</b>
            <span style="font-size:10px;color:${C.mut};">called ${esc(this.outLabel(pr.resultCat) || "—")}</span>
          </span>`}
        </div>`;
      }).join("");

      return `<div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel};padding:14px 16px;">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
          <span style="font-size:10px;font-weight:800;letter-spacing:.09em;color:${C.faint};">CURRENT AT-BAT</span>
          <span style="margin-left:auto;display:flex;gap:14px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.mut};"><span style="white-space:nowrap;">pitch <span style="color:${this.accColor(this.rate(c, n))};">${this.ratioPct(c, n)}</span></span><span style="white-space:nowrap;">MAE ${this.maeText(mae)}</span></span>
        </div>
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:3px;">
          ${this.entityLinkHtml("BATTER", g.batter.id, g.batter.name, esc(g.batter.name), "font-size:16px;font-weight:700;")}
          <span style="font-size:11.5px;color:${C.mut};">vs ${this.entityLinkHtml("PITCHER", g.pitcher.id, g.pitcher.name, esc(g.pitcher.name), `color:${C.mut};`)}</span>
        </div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.faint};margin-bottom:12px;">${esc(g.half || "")}${esc(g.inning == null ? "" : g.inning)} · ${esc(g.count || "0-0")} count · ${pitches.length} pitch${pitches.length === 1 ? "" : "es"} seen</div>
        <div style="display:flex;flex-direction:column;gap:3px;">${rows || `<div style="font-size:12px;color:${C.faint};font-style:italic;">No pitches thrown in this at-bat yet.</div>`}</div>
      </div>`;
    }

    liveHtml() {
      const C = this.C;
      const mobile = this.mob();
      // Always today, whatever date the Data Feed's stepper has been left on.
      const date = PH.mlbDate(0);
      const models = this.models(date);
      const sub = this.heroSubject();
      const best = sub.best;
      const all = this.allAbs(models);
      const gs = this.gameStats(all);

      // A pinned game with no covered market is a real state — the game is
      // live but nothing has been scored into the current at-bat yet — and it
      // is not the same as "nothing is live".
      const emptyHero = (title, body) =>
        `<div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel};padding:18px 20px;margin-bottom:22px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:.09em;color:${C.faint};">${sub.pinned ? "SELECTED GAME" : "TOP AT-BAT · ALL GAMES"}</div>
          <div style="font-size:15px;font-weight:700;margin-top:6px;">${esc(title)}</div>
          <div style="font-size:12.5px;color:${C.mut};margin-top:5px;line-height:1.5;">${esc(body)}</div>
        </div>`;

      const hero = best
        ? `<div style="display:grid;grid-template-columns:${mobile || this.narrow() ? "minmax(0,1fr)" : "1.55fr minmax(0,1fr)"};gap:14px;margin-bottom:26px;align-items:start;">
            ${this.heroHtml(best, models, mobile, sub.pinned)}
            ${this.currentAbHtml(best.game, mobile)}
          </div>`
        : sub.pinned && sub.game
          ? `<div style="display:grid;grid-template-columns:${mobile || this.narrow() ? "minmax(0,1fr)" : "1.55fr minmax(0,1fr)"};gap:14px;margin-bottom:26px;align-items:start;">
              ${emptyHero(`No open call in ${sub.game.away} @ ${sub.game.home}`, COPY.heroNoCallInGame)}
              ${this.currentAbHtml(sub.game, mobile)}
            </div>`
          : emptyHero("Nothing live right now", COPY.heroNothingLive);

      return `<div style="padding:${mobile ? "14px 14px 24px" : "20px 26px 48px"};max-width:1240px;margin:0 auto;">
        ${this.heroChipsHtml(mobile)}
        ${hero}
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 10px;">
          <span style="font-size:15px;font-weight:800;letter-spacing:-.01em;">All of today's games</span>
          ${mobile ? "" : `<span style="font-size:11.5px;color:${C.faint};">${esc(COPY.liveListHint)}</span>`}
          <span style="margin-left:auto;display:flex;gap:16px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.mut};"><span style="white-space:nowrap;"><span style="color:${this.accColor(this.rate(gs.abC, gs.abN))};">${this.ratioPct(gs.abC, gs.abN)}</span> at-bat calls</span><span style="white-space:nowrap;"><span style="color:${this.accColor(this.rate(gs.pC, gs.pN))};">${this.ratioPct(gs.pC, gs.pN)}</span> pitch calls</span><span style="white-space:nowrap;">MAE ${this.maeText(gs.mae)}</span></span>
        </div>
        ${this.liveGamePillsHtml(models, mobile, date)}
      </div>`;
    }

    // ══ GRADED LOG (server-backed) ════════════════════════════════════════



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

    // Seed from whichever game the reader has drilled into, otherwise from the
    // slate, otherwise from the last session — which is what makes the tab
    // survive a refresh.
    //
    // This followed `state.feedGame` until 2026-08-16 — state nothing rendered
    // a control for, which poll() pinned to the first live game — and then the
    // Data Feed's game chips until the feed redesign removed them. Following
    // the open pill keeps the panels describing the game on screen without
    // reintroducing a second, competing game selector.
    syncScouting() {
      const slate = this.slateGames();
      const open = Object.keys(this.state.openG).filter((k) => this.state.openG[k]);
      const g = slate.find((x) => open.includes(String(x.gamePk))) || slate[0];
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
          <span style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">${esc(COPY.feedPanelTitle)}</span>
          <span style="font-size:11.5px;color:${C.faint};">${esc(COPY.feedPanelSub)}</span>
        </div>
        ${filters}
        ${summary}
        <div style="border:1px solid ${C.bd};border-radius:13px;background:${C.panel2};overflow:hidden;">${body}</div>
      </div>`;
    }

    // ── Data Feed: KPIs and charts ───────────────────────────────────────
    // Three of the four charts are derived from the same at-bat/pitch rows the
    // drill-down below them reads, so a number in a chart and a number in a row
    // can never disagree. The fourth reads /accuracy, which is the only source
    // that survives the prediction prune.
    chartCard(title, note, body, mobile) {
      const C = this.C;
      return `<div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};padding:14px 16px;min-width:0;">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:2px;">${esc(title)}</div>
        <div style="font-size:11px;color:${C.faint};margin-bottom:14px;">${esc(note)}</div>
        ${body}
      </div>`;
    }
    chartEmpty(msg) {
      return `<div style="font-size:12.5px;color:${this.C.faint};font-style:italic;line-height:1.55;">${esc(msg)}</div>`;
    }

    // The graded record for the whole window, summed from /accuracy. That
    // rollup is per (day, market) and is never pruned, so it can answer for a
    // 30-day window without the browser paging 300,000 per-pitch rows — which
    // is the only reason these tiles can describe more than one slate.
    windowAcc() {
      const w = this.dfWindow();
      const days = (this.state.accuracy.days || [])
        .filter((d) => d.day >= w.from && d.day <= w.to);
      const of = (market) => days.filter((d) => d.market === market).reduce(
        (a, d) => ({
          w: a.w + Number(d.wins || 0),
          l: a.l + Number(d.losses || 0),
          n: a.n + Number(d.n_graded || 0),
        }), { w: 0, l: 0, n: 0 },
      );
      return {
        ab: of("ab_result"), pitch: of("pitch_result"),
        days: [...new Set(days.map((d) => d.day))].length,
      };
    }

    kpiTilesHtml(models, mobile) {
      const C = this.C;
      const acc = this.state.accuracy;
      const wa = this.windowAcc();
      const dirty = this.dfFilterDirty();
      const scope = this.dfRowScope();

      // Tiles 1 and 2 answer "how good is the record" and have two possible
      // sources. Unfiltered they come from the nightly rollup, which covers the
      // whole window in one request. The moment a row-level filter is set the
      // rollup cannot answer — it has no team or player — so they switch to the
      // per-pitch rows, and their subtitle names the slates that covers. The
      // number moves when you filter because it is a different question, and
      // the subtitle is what says so.
      const abDecided = wa.ab.w + wa.ab.l;
      const pDecided = wa.pitch.w + wa.pitch.l;
      const rowAbs = this.allAbs(models);
      const rowGs = this.gameStats(rowAbs);

      const abR = dirty ? this.rate(rowGs.abC, rowGs.abN) : this.rate(wa.ab.w, abDecided);
      const pR = dirty ? this.rate(rowGs.pC, rowGs.pN) : this.rate(wa.pitch.w, pDecided);

      // MAE and high-confidence accuracy are NOT in the daily rollup — it
      // carries wins/losses/pushes and mean confidence, nothing about how far a
      // velocity call missed by. They come from rows always, so they cover the
      // loaded slates and say so.
      const hi = rowAbs.filter((ab) => ab.ok != null && ab.predProb != null && ab.predProb >= this.CONF_TOP);
      const hiR = this.rate(hi.filter((ab) => ab.ok).length, hi.length);
      const emptySub = this.dfStaleNote()
        ? `rollup has nothing since ${this.accNewestDay()}`
        : "nothing graded in this window";
      // "Nothing loaded" and "nothing matched" are different failures and must
      // not share a message: the first is fixed by opening a day, the second by
      // relaxing a filter.
      const noRows = this.dfRowModels().length
        ? "no calls match these filters"
        : "no slate loaded — pick Today, or open a day below";

      const tiles = [
        {
          big: dirty ? this.pct(abR) : (acc.loaded ? this.pct(abR) : "—"),
          label: "At-bat call accuracy",
          sub: dirty
            ? (rowGs.abN ? `${rowGs.abC} of ${rowGs.abN} graded · ${scope}` : noRows)
            : (abDecided ? `${wa.ab.w} of ${abDecided} graded at-bats` : emptySub),
          c: abR == null ? C.dim : this.accColor(abR),
        },
        {
          big: dirty ? this.pct(pR) : (acc.loaded ? this.pct(pR) : "—"),
          label: "Pitch result accuracy",
          sub: dirty
            ? (rowGs.pN ? `${rowGs.pC} of ${rowGs.pN} graded · ${scope}` : noRows)
            : (pDecided ? `${wa.pitch.w} of ${pDecided} graded pitches` : emptySub),
          c: pR == null ? C.dim : this.accColor(pR),
        },
        {
          big: this.maeText(rowGs.mae), label: "Velo MAE (mph)",
          sub: rowGs.mae == null ? noRows : `mean abs error · ${scope}`,
          c: rowGs.mae == null ? C.dim : this.grd(this.veloBand(rowGs.mae)).fg,
        },
        {
          big: hiR == null ? "—" : this.pct(hiR), label: "High-confidence accuracy",
          sub: hiR == null ? noRows : `${hi.length} calls at ${Math.round(this.CONF_TOP * 100)}%+ · ${scope}`,
          c: hiR == null ? C.dim : this.accColor(hiR),
        },
        dirty || this.dfSingleDay()
          ? { big: String(models.length), label: "Games graded", sub: scope, c: C.dim }
          : { big: acc.loaded ? String(wa.days) : "—", label: "Days graded", sub: this.dfWindowLabel(), c: C.dim },
      ];
      return `<div style="display:grid;grid-template-columns:repeat(${mobile ? 2 : 5},minmax(0,1fr));gap:10px;margin-bottom:16px;">
        ${tiles.map((k) => `<div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};padding:12px 13px;display:flex;flex-direction:column;gap:5px;min-width:0;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:700;color:${k.c};line-height:1;">${esc(k.big)}</span>
          <span style="font-size:10.5px;font-weight:700;letter-spacing:.05em;color:${C.mut};text-transform:uppercase;">${esc(k.label)}</span>
          <span style="font-size:11px;color:${C.faint};">${esc(k.sub)}</span>
        </div>`).join("")}
      </div>`;
    }

    // Chart 1 — accuracy over time by market, from /accuracy.
    accuracyChartHtml(mobile) {
      const C = this.C;
      const acc = this.state.accuracy;
      if (!acc.loaded) return this.chartEmpty("Loading the accuracy history…");
      if (acc.err) return this.chartEmpty("Couldn't reach the accuracy rollup. The other three panels are computed from the day's rows and are unaffected.");
      // The whole retained span is held in state; this chart draws the window.
      // Without the filter it kept plotting days the reader had just excluded.
      const w = this.dfWindow();
      const byMkt = new Map();
      (acc.days || []).forEach((d) => {
        if (d.day < w.from || d.day > w.to) return;
        if (!this.MICRO.includes(d.market) || d.win_rate == null) return;
        const arr = byMkt.get(d.market) || [];
        arr.push(d);
        byMkt.set(d.market, arr);
      });
      if (!byMkt.size) {
        const stale = this.dfStaleNote();
        return this.chartEmpty(stale
          || "No graded days in this window yet. The rollup runs nightly, so a market appears here the morning after its first graded slate.");
      }

      const rows = this.MICRO.filter((k) => byMkt.has(k)).map((k) => {
        const series = byMkt.get(k).slice(-14);
        const now = series[series.length - 1];
        const prev = series.length > 1 ? series[series.length - 2] : null;
        const delta = prev ? now.win_rate - prev.win_rate : null;
        const bars = series.map((d) => {
          const band = this.accBand(d.win_rate);
          return `<span title="${esc(d.day)} · ${this.pct(d.win_rate)} of ${d.n_graded}" style="flex:1;min-width:3px;border-radius:2px 2px 0 0;background:${this.grd(band).fg};height:${Math.max(4, Math.round(d.win_rate * 40))}px;display:block;"></span>`;
        }).join("");
        return `<div style="display:grid;grid-template-columns:${mobile ? 92 : 104}px minmax(0,1fr) 74px;gap:12px;align-items:end;">
          <span style="font-size:11.5px;color:${C.dim};padding-bottom:2px;">${esc(this.MICRO_LABEL[k])}</span>
          <span style="display:flex;align-items:flex-end;gap:3px;height:40px;">${bars}</span>
          <span style="display:flex;flex-direction:column;align-items:flex-end;">
            <b style="font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;">${this.pct(now.win_rate)}</b>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${delta == null ? C.faint : delta >= 0 ? C.grn : C.red};">${delta == null ? "—" : `${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta * 100))}pt`}</span>
          </span>
        </div>`;
      }).join("");
      return `<div style="display:flex;flex-direction:column;gap:11px;">${rows}</div>`;
    }

    // Chart 2 — pitch-result accuracy by the count the pitch was thrown into.
    countChartHtml(flat) {
      const C = this.C;
      const by = new Map();
      flat.forEach(({ p }) => {
        if (p.ok == null || !p.count) return;
        const arr = by.get(p.count) || [];
        arr.push(p);
        by.set(p.count, arr);
      });
      // Under six samples a rate is noise dressed as a finding.
      const rows = [...by.entries()]
        .map(([label, arr]) => ({
          label, n: arr.length, r: arr.filter((p) => p.ok).length / arr.length,
        }))
        .filter((c) => c.n >= 6)
        .sort((a, b) => b.r - a.r)
        .slice(0, 8);
      if (!rows.length) return this.chartEmpty("Needs at least six graded pitches in one count.");
      return `<div style="display:flex;flex-direction:column;gap:6px;">${rows.map((c) => `
        <div style="display:grid;grid-template-columns:44px minmax(0,1fr) 84px;gap:10px;align-items:center;">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:${C.dim};">${esc(c.label)}</span>
          <span style="height:9px;background:${C.panel2};border-radius:999px;overflow:hidden;display:block;"><span style="display:block;height:100%;border-radius:999px;background:${this.accColor(c.r)};width:${Math.round(c.r * 100)}%;"></span></span>
          <span style="display:flex;gap:7px;justify-content:flex-end;font-family:'IBM Plex Mono',monospace;font-size:11.5px;">
            <b style="font-weight:600;">${this.pct(c.r)}</b><span style="color:${C.faint};">${c.n}</span>
          </span>
        </div>`).join("")}</div>`;
    }

    // Chart 3 — pitch mix across the day, and mean velocity by how deep into
    // the pitcher's outing the pitch was thrown.
    mixChartHtml(flat) {
      const C = this.C;
      const typed = flat.filter(({ p }) => p.type);
      if (typed.length < 8) return this.chartEmpty("Needs at least eight pitches with a recorded type.");
      const tc = {};
      typed.forEach(({ p }) => { tc[p.type] = (tc[p.type] || 0) + 1; });
      const tot = typed.length;
      const mix = Object.keys(tc).sort((a, b) => tc[b] - tc[a]).map((k) => ({
        label: k, color: this.pitchColor(k),
        pct: Math.round((tc[k] / tot) * 100), w: (tc[k] / tot) * 100,
      }));
      const named = mix.filter((m2) => m2.pct >= 1).slice(0, 8);
      const rest = mix.length - named.length;

      const buckets = [[1, 25], [26, 50], [51, 75], [76, 999]];
      const velo = buckets.map(([lo, hi]) => {
        const arr = typed.filter(({ p }) => p.velo != null && p.pc >= lo && p.pc <= hi);
        return {
          label: hi === 999 ? `${lo}+` : `${lo}–${hi}`,
          n: arr.length,
          raw: arr.length ? arr.reduce((a, x) => a + x.p.velo, 0) / arr.length : null,
        };
      }).filter((v) => v.n > 0);

      let veloBlock = this.chartEmpty("No velocity by workload yet.");
      if (velo.length) {
        const vals = velo.map((v) => v.raw);
        const lo = Math.min.apply(null, vals) - 1.2;
        const hi = Math.max.apply(null, vals) + 0.6;
        veloBlock = `<div style="display:flex;align-items:flex-end;gap:8px;height:62px;border-bottom:1px solid ${C.bd};">
            ${velo.map((v) => `<span style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;justify-content:flex-end;height:100%;">
              <b style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;font-weight:600;">${v.raw.toFixed(1)}</b>
              <span title="${v.n} pitches" style="width:100%;border-radius:3px 3px 0 0;background:${C.acc};height:${Math.round(10 + (hi === lo ? 0.5 : (v.raw - lo) / (hi - lo)) * 34)}px;display:block;"></span>
            </span>`).join("")}
          </div>
          <div style="display:flex;gap:8px;margin-top:6px;">
            ${velo.map((v) => `<span style="flex:1;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.faint};">${esc(v.label)}</span>`).join("")}
          </div>`;
      }

      return `<div style="display:flex;height:11px;border-radius:999px;overflow:hidden;background:${C.panel2};margin-bottom:9px;">
          ${mix.map((s) => `<span title="${esc(s.label)} ${s.pct}%" style="display:block;height:100%;background:${s.color};width:${s.w}%;"></span>`).join("")}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:16px;">
          ${named.map((s) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:${C.dim};">
            <span style="width:7px;height:7px;border-radius:2px;background:${s.color};display:block;"></span>${esc(s.label)}
            <b style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:${C.txt};">${s.pct}%</b>
          </span>`).join("")}
          ${rest > 0 ? `<span style="font-size:11px;color:${C.faint};">+${rest} rarer type${rest === 1 ? "" : "s"}</span>` : ""}
        </div>
        ${veloBlock}`;
    }

    // Chart 4 — the day's most-seen batters: how their at-bats actually ended,
    // and how often the model called them right.
    batterChartHtml(models, mobile) {
      const C = this.C;
      const bt = {};
      (models || []).forEach((g) => g.abs.forEach((ab) => {
        if (!ab.batter) return;
        const e = bt[ab.batter] || (bt[ab.batter] = {
          name: ab.batter, id: ab.batterId, ab: 0, ok: 0, graded: 0, str: 0, pn: 0, mix: {},
        });
        if (e.id == null && ab.batterId != null) e.id = ab.batterId;
        e.ab += 1;
        if (ab.ok != null) { e.graded += 1; if (ab.ok) e.ok += 1; }
        if (ab.actual) e.mix[ab.actual] = (e.mix[ab.actual] || 0) + 1;
        ab.pitches.forEach((p) => {
          if (!p.result) return;
          e.pn += 1;
          if (p.result === "strike_foul") e.str += 1;
        });
      }));
      const rows = Object.keys(bt).map((k) => bt[k])
        .sort((a, b) => b.ab - a.ab).slice(0, 7);
      if (!rows.length) return this.chartEmpty("No at-bats with a named batter yet.");

      const OUT_KEYS = ["strikeout", "walk", "hit", "out"];
      const cols = mobile
        ? "minmax(0,1.4fr) 44px minmax(0,1fr) 46px"
        : "minmax(0,1.4fr) 52px 52px minmax(0,1fr) 46px";
      const head = (mobile ? ["BATTER", "AB", "OUTCOME MIX", "ACC"] : ["BATTER", "AB", "STR%", "OUTCOME MIX", "ACC"])
        .map((h, i) => `<span style="font-size:10px;font-weight:800;letter-spacing:.05em;color:${C.faint};${i === 1 || i === 2 || h === "ACC" ? "text-align:right;" : ""}">${h}</span>`).join("");

      const body = rows.map((e) => {
        const r = this.rate(e.ok, e.graded);
        const mixTotal = OUT_KEYS.reduce((a, k) => a + (e.mix[k] || 0), 0);
        const mix = OUT_KEYS.filter((k) => e.mix[k]).map((k) =>
          `<span title="${esc(this.outLabel(k))} ${e.mix[k]}" style="display:block;height:100%;background:${this.OUT_COLOR[k]};width:${(e.mix[k] / mixTotal) * 100}%;"></span>`).join("");
        return `<div style="display:grid;grid-template-columns:${cols};gap:8px;align-items:center;padding:7px 2px;border-bottom:1px solid ${C.row};">
          ${this.entityLinkHtml("BATTER", e.id, e.name, esc(this.shortName(e.name)), "font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;")}
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};text-align:right;">${e.ab}</span>
          ${mobile ? "" : `<span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};text-align:right;">${e.pn ? Math.round((e.str / e.pn) * 100) + "%" : "—"}</span>`}
          <span style="display:flex;height:8px;border-radius:999px;overflow:hidden;background:${C.panel2};">${mix}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;font-weight:600;color:${this.accColor(r)};text-align:right;">${r == null ? "—" : this.pct(r)}</span>
        </div>`;
      }).join("");

      return `<div style="display:grid;grid-template-columns:${cols};gap:8px;padding:0 2px 7px;border-bottom:1px solid ${C.bd};">${head}</div>
        ${body}
        <div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;">
          ${OUT_KEYS.map((k) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:${C.mut};"><span style="width:7px;height:7px;border-radius:2px;background:${this.OUT_COLOR[k]};display:block;"></span>${esc(this.outLabel(k))}</span>`).join("")}
        </div>`;
    }

    // ── the window ───────────────────────────────────────────────────────
    // Replaces the single-day stepper. Everything on the tab that CAN describe
    // more than one slate now does; everything that cannot says so.
    dfWindowChipsHtml(mobile) {
      const C = this.C;
      const cur = this.state.dfRange || "7d";
      const chip = (arg, label, on) =>
        `<button data-act="dfRange" data-arg="${esc(arg)}" style="border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.chip};color:${on ? C.grn : C.dim};font-family:inherit;font-weight:600;font-size:12px;padding:6px 12px;border-radius:999px;cursor:pointer;white-space:nowrap;">${esc(label)}</button>`;
      const chips = this.DF_RANGES.map(([k, l]) => chip(k, l, cur === k)).join("");
      const w = this.dfWindow();
      // The two date boxes are `change`-driven and carry data-feedfilter, so
      // render()'s focus guard already holds the 8s poll off while one of them
      // has the caret.
      const dateInput = (key, val, max, min) =>
        `<input type="date" data-feedfilter="${key}" value="${esc(val)}" max="${esc(max)}"${min ? ` min="${esc(min)}"` : ""} style="border:1px solid ${C.bd};background:${C.panel};color:${C.txt};font-family:inherit;font-size:11.5px;padding:5px 8px;border-radius:7px;color-scheme:dark;" />`;
      const custom = cur === "custom"
        ? `<span style="display:inline-flex;align-items:center;gap:6px;">
            ${dateInput("dfFrom", this.state.dfFrom || w.from, w.to, PH.mlbDate(-(this.ACC_SPAN_DAYS - 1)))}
            <span style="font-size:11px;color:${C.faint};">to</span>
            ${dateInput("dfTo", this.state.dfTo || w.to, PH.mlbDate(0))}
          </span>`
        : "";
      return `<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">${chips}${custom}</div>`;
    }

    // ── row-level filters ────────────────────────────────────────────────
    // Team, player, home/away and role are dimensions of the per-pitch rows and
    // of nothing else: prediction_accuracy_daily is keyed (day, market) and has
    // no idea who was batting. So these four scope the surfaces built from rows
    // — the KPI tiles and the charts — and deliberately never touch the history
    // accordion, which follows the window alone.
    dfFilters() {
      return {
        team: this.state.dfTeam || "",
        player: this.state.dfPlayer || "",
        side: this.state.dfSide || "all",
        role: this.state.dfRole || "all",
      };
    }
    dfFilterDirty() {
      const f = this.dfFilters();
      return !!(f.team || f.player || f.side !== "all" || f.role !== "all");
    }
    // Bottom of an inning is the home side batting, so the pitching side is
    // whichever team is not batting. Both are derived from `half` plus the
    // game label — no API row names a batting team.
    dfBatTeam(m, ab) { return ab.team; }
    dfPitTeam(m, ab) {
      if (ab.half == null) return null;
      return ab.half === "▼" ? m.away : m.home;
    }
    dfIsHome(m, ab, role) {
      if (ab.half == null) return null;
      const battingHome = ab.half === "▼";
      return role === "pitcher" ? !battingHome : battingHome;
    }
    abMatchesDf(m, ab, f) {
      const roles = f.role === "all" ? ["batter", "pitcher"] : [f.role];
      // "All" matches if EITHER side of the matchup satisfies the filters, so
      // a team filter under All finds that team's at-bats and its pitching.
      return roles.some((role) => {
        if (f.team) {
          const t = role === "batter" ? this.dfBatTeam(m, ab) : this.dfPitTeam(m, ab);
          if (t !== f.team) return false;
        }
        if (f.player) {
          const nm = role === "batter" ? ab.batter : ab.pitcher;
          if (nm !== f.player) return false;
        }
        if (f.side !== "all") {
          const home = this.dfIsHome(m, ab, role);
          if (home == null || home !== (f.side === "home")) return false;
        }
        return true;
      });
    }
    dfApplyFilters(models) {
      if (!this.dfFilterDirty()) return models;
      const f = this.dfFilters();
      const out = [];
      (models || []).forEach((m) => {
        const abs = m.abs.filter((ab) => this.abMatchesDf(m, ab, f));
        if (abs.length) out.push(Object.assign({}, m, { abs }));
      });
      return out;
    }

    // Which slates in the window are actually in memory. Rows are paged one
    // slate at a time, so this is today plus whatever days the reader has
    // opened in the history — and it is what every row-derived surface below
    // is honestly about.
    dfLoadedDates() {
      const w = this.dfWindow();
      return Object.keys(this.state.days)
        .filter((date) => {
          if (date < w.from || date > w.to) return false;
          const dr = this.state.days[date];
          return !!(dr && dr.loaded && !dr.pending && (dr.rows || []).length);
        })
        .sort();
    }
    dfRowModels() {
      const out = [];
      this.dfLoadedDates().forEach((date) => out.push(...this.models(date)));
      return out;
    }
    dfRowScope() {
      const dates = this.dfLoadedDates();
      if (!dates.length) return "no slate loaded";
      return dates.length === 1 ? dates[0] : `${dates.length} loaded slates`;
    }

    // Options come from the loaded slates rather than from a hard-coded league
    // list: an option that cannot match anything is worse than a shorter menu.
    dfTeamOptions(models) {
      const set = new Set();
      (models || []).forEach((m) => { if (m.away) set.add(m.away); if (m.home) set.add(m.home); });
      // Also whatever the trends page names. Without this the select was empty
      // on any day with no slate paged in — off-hours, or before first pitch —
      // even though /trends could answer a team filter perfectly well.
      ((this.state.trends && this.state.trends.rows) || []).forEach((r) => {
        if (r.team) set.add(r.team);
      });
      return [...set].sort();
    }
    dfPlayerOptions(models) {
      const f = this.dfFilters();
      const set = new Set();
      (models || []).forEach((m) => m.abs.forEach((ab) => {
        if (f.role !== "pitcher" && ab.batter) set.add(ab.batter);
        if (f.role !== "batter" && ab.pitcher) set.add(ab.pitcher);
      }));
      return [...set].sort();
    }

    dfSelectHtml(key, allLabel, opts, val, mobile) {
      const C = this.C;
      const opt = (v, label, on) =>
        `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;
      const body = [opt("", allLabel, !val)]
        .concat(opts.map((o) => opt(o, o, o === val)))
        // A value that is no longer in the option list (its slate was evicted)
        // still has to appear, or the select would silently show "All" while
        // the filter was still applied.
        .concat(val && opts.indexOf(val) === -1 ? [opt(val, `${val} (not in loaded slates)`, true)] : [])
        .join("");
      return `<select data-feedfilter="${key}" style="background:${C.panel};color:${C.txt};border:1px solid ${val ? C.acc : C.bd};border-radius:7px;font-family:inherit;font-size:11.5px;font-weight:600;padding:6px 9px;max-width:${mobile ? 150 : 190}px;cursor:pointer;min-width:0;${mobile ? "flex:1 1 132px;" : ""}">${body}</select>`;
    }
    dfSegHtml(act, cur, items) {
      const C = this.C;
      return `<span style="display:inline-flex;gap:3px;background:${C.chip};border:1px solid ${C.bd};border-radius:999px;padding:2px;">
        ${items.map(([k, l]) => {
          const on = cur === k;
          return `<button data-act="${act}" data-arg="${esc(k)}" style="border:0;background:${on ? "#12301f" : "transparent"};color:${on ? C.grn : C.dim};font-family:inherit;font-weight:600;font-size:11.5px;padding:4px 10px;border-radius:999px;cursor:pointer;white-space:nowrap;">${esc(l)}</button>`;
        }).join("")}
      </span>`;
    }

    dfFilterBarHtml(mobile) {
      const C = this.C;
      const f = this.dfFilters();
      const all = this.dfRowModels();
      const dirty = this.dfFilterDirty();
      const scoped = this.dfApplyFilters(all);
      const abN = scoped.reduce((a, m) => a + m.abs.length, 0);

      // Label and control travel as one unit. Emitted as siblings they got
      // split by the wrap on a phone, leaving "PLAYER" stranded at the end of
      // the row above the select it names.
      const field = (t, control) =>
        `<span style="display:inline-flex;align-items:center;gap:7px;min-width:0;${mobile ? "flex:1 1 auto;" : ""}">
          <span style="font-size:9.5px;font-weight:800;letter-spacing:.06em;color:${C.faint};white-space:nowrap;">${t}</span>${control}
        </span>`;
      const divider = `<span style="width:1px;height:18px;background:${C.bd2};"></span>`;
      const summary = [
        f.team || "All teams",
        f.player ? this.shortName(f.player) : "All players",
        f.side === "all" ? "home + away" : f.side,
        f.role === "all" ? "batters + pitchers" : `${f.role}s`,
        this.dfWindowLabel(),
      ].join(" · ");

      return `<div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel2};padding:11px 13px;margin-bottom:14px;display:flex;align-items:center;gap:${mobile ? 8 : 10}px;flex-wrap:wrap;">
        ${field("TEAM", this.dfSelectHtml("dfTeam", "All teams", this.dfTeamOptions(all), f.team, mobile))}
        ${field("PLAYER", this.dfSelectHtml("dfPlayer", "All players", this.dfPlayerOptions(all), f.player, mobile))}
        ${mobile ? "" : divider}
        ${field("SPLIT", this.dfSegHtml("dfSide", f.side, [["all", "Both"], ["home", "Home"], ["away", "Away"]]))}
        ${field("ROLE", this.dfSegHtml("dfRole", f.role, [["all", "All"], ["batter", "Batters"], ["pitcher", "Pitchers"]]))}
        ${dirty ? `<button data-act="dfClear" style="border:1px solid ${C.bd};background:transparent;color:${C.dim};font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 10px;border-radius:999px;cursor:pointer;">Clear</button>` : ""}
        <span style="${mobile
          // On a phone the summary is its own full-width line that wraps. Left
          // nowrap it ran to ~660px and took the whole page into a sideways
          // scroll, which the design system does not allow.
          ? `flex:1 0 100%;white-space:normal;line-height:1.5;`
          : `margin-left:auto;white-space:nowrap;`}font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">${esc(summary)} — ${abN} at-bat${abN === 1 ? "" : "s"} · ${esc(this.dfRowScope())}</span>
      </div>`;
    }

    // ── profitable trends ────────────────────────────────────────────────
    // The sample floor is the whole point of the panel: without it a 4-for-5
    // stretch tops the table and the reader learns nothing. It is enforced
    // server-side; this is the value the board asks for.
    TRENDS_MIN_GRADED = 20;
    // Streaks are the only part of /trends that scales with page size, so the
    // board asks for a panel's worth rather than a dataset's.
    TRENDS_LIMIT = 12;

    trendsPanelHtml(mobile) {
      const C = this.C;
      const t = this.state.trends;
      const f = this.dfFilters();
      const card = (body, note) => `<div style="border:1px solid ${C.gbd};border-radius:12px;background:${C.panel};padding:14px 16px;min-width:0;grid-column:1/-1;">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:2px;">
          <span style="font-size:12.5px;font-weight:700;">Profitable trends</span>
          <span style="font-size:11px;color:${C.faint};">${esc(note)}</span>
        </div>
        <div style="margin-top:12px;">${body}</div>
      </div>`;

      const base = t.baseline;
      const baseRate = base && base.win_rate != null ? base.win_rate : null;
      const note = baseRate == null
        ? COPY.trendsNote
        : `${COPY.trendsNote} · baseline ${this.pct(baseRate)} over ${Number(base.wins + base.losses).toLocaleString()} graded calls`;

      if (!t.loaded) return card(this.chartEmpty("Loading the trends table…"), note);
      if (t.err) return card(this.chartEmpty("Couldn't reach the trends endpoint. The panels around it are computed from other sources and are unaffected."), note);

      // The player filter is a name, and the route keys on id, so it is applied
      // to the page rather than sent.
      const rows = f.player ? t.rows.filter((r) => r.name === f.player) : t.rows;
      if (!rows.length) {
        return card(this.chartEmpty(
          f.player
            ? `${f.player} is not in the ranked page, or has fewer than ${this.TRENDS_MIN_GRADED} graded calls in this window.`
            : `No player has ${this.TRENDS_MIN_GRADED} or more graded calls under these filters yet.`,
        ), note);
      }

      // Edge bars share one scale so two rows can be compared by length.
      const maxEdge = rows.reduce((a, r) => Math.max(a, Math.abs(r.edge_pt || 0)), 1);
      const cols = mobile
        ? "minmax(0,1fr) 74px 62px"
        : "minmax(0,1.1fr) 58px 66px 128px minmax(0,1fr) 72px 62px";
      const head = (mobile
        ? ["PLAYER", "GRADED", "EDGE"]
        : ["PLAYER", "ROLE", "SPLIT", "GRADED CALLS", "EDGE VS BASELINE", "UNITS", "STREAK"])
        .map((h, i) => `<span style="font-size:9.5px;font-weight:800;letter-spacing:.05em;color:${C.faint};${i >= (mobile ? 1 : 5) ? "text-align:right;" : ""}">${h}</span>`).join("");

      const body = rows.map((r) => {
        const decided = (r.wins || 0) + (r.losses || 0);
        const rate = r.win_rate;
        const edge = r.edge_pt;
        const edgeFg = edge == null ? C.faint : edge >= 0 ? C.grn : this.GRD.bad.fg;
        const units = r.profit_units;
        const unitFg = units == null ? C.faint : units >= 0 ? C.grn : this.GRD.bad.fg;
        // A streak of null is "no settled call inside the horizon", which is
        // not a streak of zero — the dash says so.
        const st = r.streak;
        const stText = st == null ? "—" : `${st >= 0 ? "W" : "L"}${Math.abs(st)}`;
        const stFg = st == null ? C.faint : st >= 0 ? C.grn : this.GRD.bad.fg;
        // Spelled out rather than the design's BAT/PIT: "PIT" is also
        // Pittsburgh's abbreviation, and the row above it shows the team — so a
        // Pirates pitcher rendered as "PIT / PIT".
        const roleTag = r.role === "pitcher" ? "PITCHER" : "BATTER";
        const roleFg = r.role === "pitcher" ? "#b49bff" : C.blue;
        const hr = r.splits && r.splits.home ? r.splits.home.win_rate : null;
        const ar = r.splits && r.splits.away ? r.splits.away.win_rate : null;
        // One line saying why this player is on the table, in words.
        const reason = `${this.pct(rate)} on ${decided} graded${edge == null ? "" : `, ${edge >= 0 ? "+" : "−"}${Math.abs(edge).toFixed(1)} pt vs baseline`}`;
        const name = this.entityLinkHtml(
          r.role === "pitcher" ? "PITCHER" : "BATTER", r.player_id, r.name || "—",
          esc(this.shortName(r.name)), "font-size:12.5px;font-weight:700;",
        );
        const bar = `<span style="display:flex;align-items:center;gap:7px;min-width:0;">
          <span style="flex:1;height:7px;background:${C.panel2};border-radius:999px;overflow:hidden;display:block;min-width:24px;">
            <span style="display:block;height:100%;border-radius:999px;background:${edgeFg};width:${Math.round((Math.abs(edge || 0) / maxEdge) * 100)}%;"></span>
          </span>
          <b style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;font-weight:600;color:${edgeFg};white-space:nowrap;">${edge == null ? "—" : `${edge >= 0 ? "+" : "−"}${Math.abs(edge).toFixed(1)} pt`}</b>
        </span>`;

        if (mobile) {
          return `<div style="display:grid;grid-template-columns:${cols};gap:8px;align-items:center;padding:8px 2px;border-bottom:1px solid ${C.row};">
            <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
              ${name}
              <span style="font-size:10px;color:${C.faint};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="color:${roleFg};font-weight:800;">${roleTag}</span> ${esc(r.team || "—")} · ${esc(reason)}</span>
            </span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${this.accColor(rate)};text-align:right;white-space:nowrap;">${this.ratioPct(r.wins, decided)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;font-weight:600;color:${edgeFg};text-align:right;white-space:nowrap;">${edge == null ? "—" : `${edge >= 0 ? "+" : "−"}${Math.abs(edge).toFixed(1)}`}</span>
          </div>`;
        }
        return `<div style="display:grid;grid-template-columns:${cols};gap:10px;align-items:center;padding:8px 2px;border-bottom:1px solid ${C.row};">
          <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
            ${name}
            <span style="font-size:10.5px;color:${C.faint};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(reason)}</span>
          </span>
          <span style="display:flex;flex-direction:column;gap:1px;min-width:0;">
            <b style="font-size:9.5px;font-weight:800;color:${roleFg};">${roleTag}</b>
            ${this.entityLinkHtml("TEAM", null, r.team || "", esc(r.team || "—"), `font-size:10.5px;color:${C.mut};`)}
          </span>
          <span style="display:flex;flex-direction:column;gap:1px;font-family:'IBM Plex Mono',monospace;font-size:10.5px;">
            <span style="color:${hr == null ? C.faint : this.accColor(hr)};">H ${this.pct(hr)}</span>
            <span style="color:${ar == null ? C.faint : this.accColor(ar)};">A ${this.pct(ar)}</span>
          </span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${this.accColor(rate)};white-space:nowrap;">${this.ratioPct(r.wins, decided)}</span>
          ${bar}
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;font-weight:600;color:${unitFg};text-align:right;white-space:nowrap;">${units == null ? "—" : `${units >= 0 ? "+" : "−"}${Math.abs(units).toFixed(0)}`}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;font-weight:600;color:${stFg};text-align:right;">${stText}</span>
        </div>`;
      }).join("");

      const foot = `<div style="margin-top:9px;font-size:10.5px;color:${C.faint};line-height:1.5;">${esc(COPY.trendsFloorNote.replace("{n}", String(this.TRENDS_MIN_GRADED)))}${t.horizon ? ` ${COPY.trendsStreakNote.replace("{d}", String(t.horizon))}` : ""}</div>`;

      return card(`<div style="display:grid;grid-template-columns:${cols};gap:${mobile ? 8 : 10}px;padding:0 2px 7px;border-bottom:1px solid ${C.bd};">${head}</div>${body}${foot}`, note);
    }

    // ── the history accordion: day -> game -> at-bat -> pitch ────────────
    // The day list comes from /accuracy, not from the raw rows: the rollup is
    // never pruned and is one row per (day, market), so a window of thirty
    // slates costs one request. Rows for a day are paged only when its pill is
    // opened.
    dfDays() {
      const w = this.dfWindow();
      const by = new Map();
      (this.state.accuracy.days || []).forEach((d) => {
        if (d.day < w.from || d.day > w.to) return;
        const e = by.get(d.day) || { day: d.day, mk: {} };
        e.mk[d.market] = d;
        by.set(d.day, e);
      });
      return [...by.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
    }
    // Midday UTC, formatted in UTC: a date-only string parsed as local midnight
    // renders as the previous day for anyone west of Greenwich.
    dfDayLabel(day) {
      const d = new Date(Date.parse(`${day}T12:00:00Z`));
      if (isNaN(d)) return day;
      const opt = (o) => d.toLocaleDateString(undefined, Object.assign({ timeZone: "UTC" }, o));
      return `${opt({ weekday: "short" })} · ${opt({ month: "short", day: "numeric" })}`;
    }
    // The most recent day the nightly rollup has written. When this trails
    // today the tab is not empty because nothing happened — it is empty
    // because the job has not run, and the two must not read the same.
    accNewestDay() {
      const days = (this.state.accuracy.days || []).map((d) => d.day);
      return days.length ? days.reduce((a, b) => (a > b ? a : b)) : null;
    }
    // A window that contains no rolled-up day, on a rollup that has older
    // days, is a stale job rather than a quiet week.
    dfStaleNote() {
      const newest = this.accNewestDay();
      if (!newest) return null;
      const w = this.dfWindow();
      if (newest >= w.from) return null;
      return `The nightly accuracy rollup has not run since ${newest}. Every day in this window is missing from it — this is a job that has stopped, not a stretch with nothing graded.`;
    }
    dfDayAged(day) {
      return day < PH.mlbDate(-this.DF_RETAIN_DAYS);
    }

    dfDayPillHtml(d, mobile) {
      const C = this.C;
      const path = `d-${d.day}`;
      const open = !!this.state.dfOpen[path];
      const today = d.day === PH.mlbDate(0);
      const aged = this.dfDayAged(d.day);
      const rec = (mk) => {
        const r = d.mk[mk];
        if (!r) return { c: 0, n: 0 };
        return { c: Number(r.wins || 0), n: Number(r.wins || 0) + Number(r.losses || 0) };
      };
      const ab = rec("ab_result"), pit = rec("pitch_result");
      const abR = this.rate(ab.c, ab.n);
      // MAE and the game count are not in the rollup. They fill in for a day
      // that has been opened, because opening it pages that slate's rows.
      const dr = this.state.days[d.day];
      const loaded = !!(dr && dr.loaded && !dr.pending);
      const mae = loaded ? this.gameStats(this.allAbs(this.models(d.day))).mae : null;
      const slate = (this.state.dayMeta[d.day] || []).length
        || (today ? (PH.games || []).length : 0);
      const note = aged ? "individual calls aged out"
        : today ? "settling as games finish"
          : "settled";

      const cell = (main, label, fg) => `<span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
        <b style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 12 : 13}px;font-weight:600;color:${fg || C.dim};white-space:nowrap;">${main}</b>
        <span style="font-size:10px;color:${C.faint};white-space:nowrap;">${esc(label)}</span>
      </span>`;
      const abCell = `<span style="display:flex;flex-direction:column;gap:3px;min-width:0;">
        <span style="display:flex;align-items:baseline;gap:6px;">
          <b style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 12 : 13}px;font-weight:600;color:${this.accColor(abR)};white-space:nowrap;">${this.ratioPct(ab.c, ab.n)}</b>
          <span style="font-size:10px;color:${C.faint};white-space:nowrap;">at-bat calls</span>
        </span>
        <span style="height:5px;background:${C.panel2};border-radius:999px;overflow:hidden;display:block;"><span style="display:block;height:100%;border-radius:999px;background:${this.accColor(abR)};width:${Math.round((abR || 0) * 100)}%;"></span></span>
      </span>`;

      const head = mobile
        ? `<button data-act="dfOpen" data-arg="${esc(path)}" style="width:100%;display:flex;flex-direction:column;gap:7px;text-align:left;border:0;background:transparent;color:${C.txt};font-family:inherit;padding:11px 12px;cursor:pointer;">
            <span style="display:flex;align-items:center;gap:9px;width:100%;">
              <span style="font-size:14px;font-weight:700;color:${C.dim};line-height:1;">${open ? "▾" : "▸"}</span>
              <b style="font-size:13.5px;font-weight:800;">${esc(this.dfDayLabel(d.day))}</b>
              <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${C.faint};">${slate ? `${slate} games` : "—"} · ${esc(note)}</span>
            </span>
            <span style="width:100%;">${abCell}</span>
            <span style="display:flex;gap:16px;width:100%;">
              ${cell(this.ratioPct(pit.c, pit.n), "pitch calls", this.accColor(this.rate(pit.c, pit.n)))}
              ${cell(mae == null ? "—" : this.maeText(mae), "mph MAE")}
            </span>
          </button>`
        : `<button data-act="dfOpen" data-arg="${esc(path)}" class="ph-card-hover" style="width:100%;display:grid;grid-template-columns:18px 150px 190px minmax(0,1fr) 150px 108px;gap:14px;align-items:center;text-align:left;border:0;background:transparent;color:${C.txt};font-family:inherit;padding:12px 14px;cursor:pointer;">
            <span style="font-size:15px;font-weight:700;color:${C.dim};line-height:1;">${open ? "▾" : "▸"}</span>
            <b style="font-size:13.5px;font-weight:800;white-space:nowrap;">${esc(this.dfDayLabel(d.day))}</b>
            <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
              <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};">${slate ? `${slate} games` : "—"}</span>
              <span style="font-size:10px;color:${C.faint};">${esc(note)}</span>
            </span>
            ${abCell}
            ${cell(this.ratioPct(pit.c, pit.n), "pitch calls", this.accColor(this.rate(pit.c, pit.n)))}
            ${cell(mae == null ? "—" : this.maeText(mae), "mph MAE")}
          </button>`;

      return `<div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};overflow:hidden;">
        ${head}
        ${open ? this.dfDayBodyHtml(d.day, mobile) : ""}
      </div>`;
    }

    // A day's games, keyed under that day's path so the same game under two
    // days keeps two open states.
    dfDayBodyHtml(date, mobile) {
      const C = this.C;
      const wrap = (body) =>
        `<div style="border-top:1px solid ${C.bd};background:${C.panel2};padding:12px ${mobile ? 10 : 14}px 14px;">${body}</div>`;
      if (this.dfDayAged(date)) {
        return wrap(`<div style="font-size:12.5px;color:${C.faint};line-height:1.55;">${esc(COPY.dfAgedOut)}</div>`);
      }
      const dr = this.dayState(date);
      if (!dr.loaded || dr.pending) {
        return wrap(`<div style="font-size:12.5px;color:${C.mut};font-style:italic;">Loading this slate's calls${dr.pending ? ` · ${dr.pending} game${dr.pending === 1 ? "" : "s"} to go` : ""}…</div>`);
      }
      if (dr.err) {
        return wrap(`<div style="font-size:12.5px;color:${C.faint};line-height:1.55;">Couldn't reach the prediction feed for this slate. The day's record above comes from the nightly rollup and is unaffected.</div>`);
      }
      const models = this.models(date);
      if (!models.length) {
        return wrap(`<div style="font-size:12.5px;color:${C.faint};">No individual calls stored for this slate.</div>`);
      }
      return wrap(`<div style="display:flex;flex-direction:column;gap:6px;">${
        models.map((m) => this.gamePillHtml(m, mobile, date, { path: `d-${date}/g-${m.pk}` })).join("")
      }</div>`);
    }

    dfHistoryHtml(mobile) {
      const C = this.C;
      const acc = this.state.accuracy;
      const box = (body) =>
        `<div style="padding:2rem 1rem;text-align:center;border:1px solid ${C.bd};border-radius:12px;background:${C.panel};color:${C.mut};font-size:.92rem;">${body}</div>`;
      if (!acc.loaded) return box("Loading the graded record…");
      if (acc.err) return box("Couldn't reach the accuracy rollup — a connection problem, not an empty record.");
      const days = this.dfDays();
      if (!days.length) {
        const stale = this.dfStaleNote();
        return stale
          ? `<div style="padding:1.1rem 1.2rem;border:1px solid ${C.bd};border-left:3px solid ${C.amb};border-radius:12px;background:${C.panel};">
              <div style="font-size:13px;font-weight:700;">No graded days in this window</div>
              <div style="font-size:12px;color:${C.mut};margin-top:5px;line-height:1.5;">${esc(stale)}</div>
            </div>`
          : box(`Nothing graded in the ${esc(this.dfWindowLabel())} window yet.`);
      }
      return `<div style="display:flex;flex-direction:column;gap:7px;">${
        days.map((d) => this.dfDayPillHtml(d, mobile)).join("")
      }</div>`;
    }

    dataHtml() {
      const C = this.C;
      const mobile = this.mob();
      // Everything row-derived reads the slates actually in memory within the
      // window — today, plus any day opened in the history — scoped by the
      // filter bar. The accordion below deliberately ignores the filters: it is
      // the record, and a record you have filtered is not the record.
      const models = this.dfApplyFilters(this.dfRowModels());
      const flat = this.flatPitches(models);
      const scope = this.dfRowScope();
      const note = (base) => `${base} · ${scope}`;
      const anyLoaded = this.dfRowModels().length > 0;
      const rowChart = (body) => (models.length ? body
        : this.chartEmpty(anyLoaded ? COPY.dfNoMatch : COPY.dfRowChartWide));

      const charts = `<div style="display:grid;grid-template-columns:${mobile ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)"};gap:12px;">
        ${this.trendsPanelHtml(mobile)}
        ${this.chartCard("Accuracy over time by market", `share of calls graded correct, per game day · ${this.dfWindowLabel()}${this.dfFilterDirty() ? " · unfiltered" : ""}`, this.accuracyChartHtml(mobile), mobile)}
        ${this.chartCard("Pitch-result accuracy by count", note("how well the model reads each count it predicts into"), rowChart(this.countChartHtml(flat)), mobile)}
        ${this.chartCard("Pitch mix and velocity trend", note("mix across the slate, mean velo by pitcher workload"), rowChart(this.mixChartHtml(flat)), mobile)}
        ${this.chartCard("Batter tendencies", note("most-seen batters, how their at-bats ended and how often we called them"), rowChart(this.batterChartHtml(models, mobile)), mobile)}
      </div>`;

      return `<div style="padding:${mobile ? "14px 14px 24px" : "20px 26px 48px"};max-width:1240px;margin:0 auto;">
        <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:14px;">
          <div style="min-width:0;">
            <h1 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0;">${esc(COPY.dataTitle)}</h1>
            <p style="margin:.3rem 0 0;color:${C.mut};font-size:.95rem;">${esc(COPY.dataSub)}</p>
          </div>
          <div style="margin-left:auto;">${this.dfWindowChipsHtml(mobile)}</div>
        </div>

        ${this.dfFilterBarHtml(mobile)}
        ${this.kpiTilesHtml(models, mobile)}
        ${charts}

        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:26px 0 10px;">
          <span style="font-size:15px;font-weight:800;letter-spacing:-.01em;">Prediction history</span>
          ${mobile ? "" : `<span style="font-size:11.5px;color:${C.faint};">${esc(COPY.dfHistoryHint)}</span>`}
          <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.faint};">${esc(this.dfWindowLabel())}${this.dfFilterDirty() ? " · unfiltered" : ""}</span>
        </div>
        ${this.dfFilterDirty() ? `<div style="font-size:11.5px;color:${C.faint};margin:-4px 0 8px 2px;">${esc(COPY.dfHistoryUnfiltered)}</div>` : ""}
        ${this.dfHistoryHtml(mobile)}

        <div style="margin-top:30px;">${this.feedHtml(true)}</div>
        <div style="margin-top:18px;">${this.scoutingHtml()}</div>
      </div>`;
    }

    // ══ ENTITY OVERLAY ═══════════════════════════════════════════════════
    // A name on this board is a thing you can ask about. Clicking a batter, a
    // pitcher or a team opens one card describing it.
    //
    // It reads two sources with different reaches, and says which is which:
    //   • the per-pitch rows already in memory — real graded calls, but only
    //     for the slates that have been paged in (today, plus days opened in
    //     the history), so its scope is named rather than claimed as 30 days;
    //   • /player/{id}/profile — the nightly warehouse aggregate, which really
    //     is a d30 window, and is the only source for zone/chase/whiff.
    //
    // A per-player, per-day accuracy series for a true 30 bars does not exist
    // in any endpoint today. That is the same gap the trends work covers, and
    // the chart says so rather than drawing a shorter series as if it were 30.

    // The mark on a clickable name. A span, not a button: at-bat rows are
    // themselves buttons and a nested button is invalid markup the browser
    // will not lay out. Delegation still lands here, because closest() finds
    // the innermost data-act.
    entityLinkHtml(kind, id, name, inner, style) {
      if (!name) return inner || "—";
      const arg = `${kind}|${id == null ? "" : id}|${name}`;
      return `<span data-act="entity" data-arg="${esc(arg)}" title="${esc(name)}" style="${style || ""}cursor:pointer;text-decoration:underline;text-decoration-color:${this.C.bd2};text-underline-offset:3px;">${inner == null ? esc(name) : inner}</span>`;
    }

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

    // Every at-bat in memory that this entity was part of, tagged with its day.
    entityAbs(ent) {
      const out = [];
      Object.keys(this.state.days).sort().forEach((date) => {
        const dr = this.state.days[date];
        if (!dr || !dr.loaded || !(dr.rows || []).length) return;
        this.models(date).forEach((m) => m.abs.forEach((ab) => {
          let hit = false;
          if (ent.kind === "BATTER") hit = ab.batter === ent.name;
          else if (ent.kind === "PITCHER") hit = ab.pitcher === ent.name;
          else hit = this.dfBatTeam(m, ab) === ent.name || this.dfPitTeam(m, ab) === ent.name;
          if (hit) out.push({ date, m, ab });
        }));
      });
      return out;
    }

    entityStats(rows) {
      let abC = 0, abN = 0, pC = 0, pN = 0, es = 0, en = 0;
      const games = new Set();
      const byDay = new Map();
      const mix = { strike_foul: 0, ball: 0, in_play: 0 };
      let mixN = 0;
      rows.forEach(({ date, m, ab }) => {
        games.add(m.pk);
        const day = byDay.get(date) || { day: date, c: 0, n: 0 };
        if (ab.ok != null) { abN += 1; day.n += 1; if (ab.ok) { abC += 1; day.c += 1; } }
        byDay.set(date, day);
        (ab.pitches || []).forEach((pt) => {
          if (pt.ok != null) { pN += 1; if (pt.ok) pC += 1; }
          if (pt.err != null) { es += Math.abs(pt.err); en += 1; }
          if (pt.result && mix[pt.result] != null) { mix[pt.result] += 1; mixN += 1; }
        });
      });
      return {
        abC, abN, pC, pN, mae: en ? es / en : null,
        games: games.size, days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        mix, mixN,
      };
    }

    entityHtml() {
      const ent = this.state.entity;
      if (!ent) return "";
      const C = this.C;
      const mobile = this.mob();
      const rows = this.entityAbs(ent);
      const st = this.entityStats(rows);
      const scope = this.dfRowScope();
      const cached = ent.id ? this.state.entityProfile[String(ent.id)] : null;

      const tile = (big, label, fg) => `<div style="border:1px solid ${C.bd};border-radius:11px;background:${C.panel};padding:11px 12px;display:flex;flex-direction:column;gap:4px;min-width:0;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:18px;font-weight:700;color:${fg || C.txt};line-height:1;">${big}</span>
        <span style="font-size:9.5px;font-weight:800;letter-spacing:.05em;color:${C.mut};text-transform:uppercase;">${esc(label)}</span>
      </div>`;
      const abR = this.rate(st.abC, st.abN);
      const tiles = `<div style="display:grid;grid-template-columns:repeat(${mobile ? 2 : 4},minmax(0,1fr));gap:9px;margin-bottom:15px;">
        ${tile(abR == null ? "—" : this.pct(abR), "call accuracy", this.accColor(abR))}
        ${tile(this.ratioPct(st.abC, st.abN), "graded calls", this.accColor(abR))}
        ${tile(this.maeText(st.mae), "velo MAE", st.mae == null ? C.dim : this.grd(this.veloBand(st.mae)).fg)}
        ${tile(String(st.games), "games", C.dim)}
      </div>`;

      // Per-day accuracy. One bar per loaded slate, which is not thirty — and
      // the note under it says so rather than letting a three-bar chart read as
      // a month.
      const bars = st.days.length
        // Bars are capped rather than stretched: with one loaded slate a
        // flex:1 bar filled the whole row and read as a solid block instead of
        // a one-day chart.
        ? `<div style="display:flex;align-items:flex-end;gap:4px;height:46px;">
            ${st.days.map((d) => {
              const r = this.rate(d.c, d.n);
              return `<span title="${esc(d.day)} · ${this.ratioPct(d.c, d.n)}" style="flex:1 1 0;min-width:6px;max-width:42px;border-radius:2px 2px 0 0;background:${this.accColor(r)};height:${Math.max(4, Math.round((r || 0) * 44))}px;display:block;"></span>`;
            }).join("")}
            <span style="flex:1 1 auto;"></span>
          </div>
          <div style="display:flex;gap:4px;margin-top:5px;">
            ${st.days.map((d) => `<span style="flex:1 1 0;min-width:6px;max-width:42px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:9px;color:${C.faint};">${esc(d.day.slice(5))}</span>`).join("")}
            <span style="flex:1 1 auto;"></span>
          </div>`
        : `<div style="font-size:12px;color:${C.faint};font-style:italic;">No graded calls in the loaded slates.</div>`;

      // Tendencies. The first three are counted from the rows in memory; the
      // rest come from the warehouse profile and are a genuine 30-day window,
      // so the two groups are labelled separately.
      const pctOf = (k) => (st.mixN ? `${Math.round((st.mix[k] / st.mixN) * 100)}%` : "—");
      const row = (k, v, sub) => `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid ${C.row};">
        <span style="font-size:12px;color:${C.dim};">${esc(k)}${sub ? `<span style="color:${C.faint};font-size:10.5px;"> ${esc(sub)}</span>` : ""}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;">${v}</span>
      </div>`;
      const prof = cached && cached.profile && cached.profile.found
        ? [].concat(cached.profile.pitcher || [], cached.profile.batter || [])
          .find((x) => x.scope === "d30")
        : null;
      const p30 = (v) => (v == null ? "—" : `${Math.round(Number(v) * 100)}%`);
      const warehouse = ent.kind === "TEAM"
        ? `<div style="font-size:11.5px;color:${C.faint};line-height:1.5;">${esc(COPY.entityTeamNote)}</div>`
        : !ent.id
          ? `<div style="font-size:11.5px;color:${C.faint};line-height:1.5;">${esc(COPY.entityNoId)}</div>`
          : cached && cached.pending
            ? `<div style="font-size:11.5px;color:${C.faint};font-style:italic;">Loading the published profile…</div>`
            : prof
              ? row("Zone rate", p30(prof.zone_rate)) + row("Chase rate", p30(prof.chase_rate))
                + row("Whiff rate", p30(prof.whiff_rate)) + row("K rate", p30(prof.k_rate))
                + row("Walk rate", p30(prof.bb_rate))
              : `<div style="font-size:11.5px;color:${C.faint};line-height:1.5;">${esc(COPY.entityNoProfile)}</div>`;

      const section = (title, note, body) => `<div style="margin-bottom:15px;">
        <div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:8px;">
          <span style="font-size:10px;font-weight:800;letter-spacing:.06em;color:${C.faint};">${esc(title)}</span>
          <span style="font-size:10.5px;color:${C.faint};">${esc(note)}</span>
        </div>
        ${body}
      </div>`;

      return `<div style="position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:${mobile ? 12 : 24}px;">
        <div data-act="entityClose" style="position:absolute;inset:0;background:rgba(6,11,20,.72);"></div>
        <div role="dialog" aria-modal="true" style="position:relative;width:min(640px,100%);max-height:88vh;overflow:auto;background:${C.bg};border:1px solid ${C.bd};border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.5);">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:15px 17px 12px;border-bottom:1px solid ${C.bd};position:sticky;top:0;background:${C.bg};">
            <span style="font-size:10px;font-weight:800;letter-spacing:.07em;color:${C.blue};">${esc(ent.kind)}</span>
            <b style="font-size:17px;font-weight:800;letter-spacing:-.01em;">${esc(ent.name)}</b>
            <button data-act="entityClose" style="margin-left:auto;border:1px solid ${C.bd};background:${C.chip};color:${C.dim};font-family:inherit;font-size:11.5px;font-weight:700;padding:5px 12px;border-radius:999px;cursor:pointer;">Close</button>
          </div>
          <div style="padding:15px 17px 18px;">
            ${section("Graded record", scope, tiles + bars)}
            ${section(ent.kind === "TEAM" ? "Pitch outcomes" : "Pitch outcomes seen", scope,
              row("Strike / foul", pctOf("strike_foul")) + row("Ball", pctOf("ball")) + row("In play", pctOf("in_play")))}
            ${section("Tendencies", ent.kind === "TEAM" ? "" : "past 30 days · nightly warehouse", warehouse)}
            <div style="font-size:11px;color:${C.faint};line-height:1.55;">${esc(COPY.entityScopeNote)}</div>
          </div>
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
      // selection. Skip a render while the user is in a filter control —
      // otherwise the 8s poll yanks the cursor out of the box mid-word, or
      // closes an open dropdown mid-choice. The pending state is picked up by
      // the next render after blur.
      const ae = document.activeElement;
      const busy = ae && ae.hasAttribute
        && (ae.hasAttribute("data-feedfilter") || ae.hasAttribute("data-phfilter"));
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
        else if (view === "live") main = this.liveHtml();
        else main = this.dataHtml();
      } catch (e) {
        console.error(`[pitchhawk] ${view} view failed to render`, e);
        main = this.viewErrorHtml(view, e);
      }
      this._bindMq();
      const wide = view !== "home";
      // The overlay is rendered with everything else rather than appended,
      // because the poll replaces this tree wholesale — an appended node would
      // vanish eight seconds after it opened.
      let overlay = "";
      try {
        overlay = this.entityHtml();
      } catch (e) {
        console.error("[pitchhawk] entity overlay failed to render", e);
        this.state.entity = null;
      }
      this.root.innerHTML = `
        ${this.headerHtml()}
        <main class="ph-main${wide ? " phv-wide" : ""}">${main}</main>
        ${wide ? "" : this.footerHtml()}
        ${overlay}`;
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

    // Players the model has read better or worse than its own baseline.
    // Signature-gated on the window plus the row filters, so the 8s poll never
    // re-requests an unchanged panel and changing a chip fetches exactly once.
    //
    // The team filter is sent as an abbreviation and the side/role filters
    // straight through; the player filter is NOT sent, because the route keys
    // on player_id and the board only knows the name — it is applied to the
    // returned page below instead.
    async syncTrends(force) {
      const w = this.dfWindow();
      const f = this.dfFilters();
      const sig = JSON.stringify([w.from, w.to, f.team, f.side, f.role]);
      if (!force && sig === this._trendsSig) return false;
      this._trendsSig = sig;
      try {
        const res = await PH.loadTrends(API_BASE, {
          from: w.from, to: w.to,
          team: f.team || null,
          side: f.side === "all" ? null : f.side,
          role: f.role === "all" ? null : f.role,
          min_graded: this.TRENDS_MIN_GRADED,
          limit: this.TRENDS_LIMIT,
        });
        this.state.trends = {
          rows: res.players || [], baseline: res.baseline || null,
          horizon: res.streak_horizon_days || null,
          loaded: true, err: false,
        };
      } catch (_e) {
        this.state.trends = Object.assign({}, this.state.trends, { loaded: true, err: true });
      }
      this.render();
      return true;
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
        const games = await PH.loadLive(API_BASE);
        if (Array.isArray(games)) {
          PH.games = games;
          // Not awaited: the board must never wait on at-bat history. It
          // re-renders itself when the rows land, and no-ops unless a live
          // game's situation actually moved.
          this.refreshLiveRows()
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
      // The day's calls and the accuracy history, on boot. Both feeds are
      // built from them, and neither should wait for the first poll.
      this.syncDay(true);
      this.loadAccuracy()
        .then((changed) => { if (changed) this.render(); })
        .catch(() => {});
      this.syncTrends(true).catch(() => {});
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
