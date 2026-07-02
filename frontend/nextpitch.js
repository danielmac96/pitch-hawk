// ════════════════════════════════════════════════════════════════════════
// nextpitch.js — Live edge board.
//
// Vanilla port of the design reference's `class Component` (NextPitch.dc.html):
// same client state, edge-resolution, sort/filter and formatter logic, rendered
// to the DOM without the DC runtime. Markup mirrors the design's inline-styled
// template so the board is pixel-faithful across the light/dark token palette.
//
// Data: window.NEXTPITCH (nextpitch-data.js) is the edge engine. The board boots
// on its bundled sample so it's never blank, then polls the real backend
// (NEXTPITCH.loadLive → GET /live + /edge) and swaps in live games when the API
// answers with live content. If the backend is down or has no games, the sample
// board stays up with its simulated tick.
// ════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // Same default as site.js's live feed: talk to the local backend, override
  // with window.PITCH_EDGE_API to point at a deployed API.
  const API_BASE = window.PITCH_EDGE_API || "http://localhost:8080";
  const POLL_MS = 8000;   // backend polls MLB every ~8s (POLL_INTERVAL_SECONDS)
  const SIM_MS = 5000;    // sample-mode simulated movement

  const NP = window.NEXTPITCH;
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── theme persistence (localStorage + prefers-color-scheme) ────────────
  function initialDark() {
    const saved = localStorage.getItem("np-theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  class Board {
    constructor(root) {
      this.root = root;
      this.state = {
        view: "edges", marketFilter: "all", activeMarket: "ab_result",
        feedGame: null, phase: "live", sortBy: "edge", openMenu: null,
        games: {}, sources: { draftkings: true, fanduel: true, kalshi: true, polymarket: true },
        dark: initialDark(), t: 0,
      };
      this.live = false;        // true once real data has been swapped in
      this._simIv = null;
      this._pollIv = null;
      this.root.addEventListener("click", (e) => this._onClick(e));
    }

    setState(patch) { Object.assign(this.state, patch); this.render(); }

    // ── formatters ───────────────────────────────────────────────────────
    dk() { return this.state.dark; }
    pct(p) { return Math.round((p || 0) * 100) + "%"; }
    pct1(p) { return ((p || 0) * 100).toFixed(1) + "%"; }
    fmtEdge(e) { return e == null ? "—" : (e >= 0 ? "+" : "−") + (Math.abs(e) * 100).toFixed(1) + "%"; }
    am(a) { return a == null ? "—" : (a > 0 ? "+" : "") + a; }
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
    situationText(g) { return `${g.half}${g.inning} · ${g.count} · ${g.outs} out`; }
    player(p) { return p.hand ? `${p.name} (${p.hand})` : p.name; }

    // ── selection helpers ────────────────────────────────────────────────
    gameOn(pk) { return this.state.games[pk] !== false; }
    selectedGames() { return NP.games.filter((g) => this.gameOn(g.gamePk)); }
    selectedSourceSet() {
      const s = this.state.sources;
      const keys = Object.keys(s).filter((k) => s[k]);
      return new Set(keys.length ? keys : ["draftkings", "fanduel", "kalshi", "polymarket"]);
    }

    // resolve a market's best edge among only the selected sources
    resolve(m, sel) {
      if (m.kind === "ou") {
        const src = m.sources.filter((s) => sel.has(s.source));
        const best = src.length ? src.reduce((a, b) => (b.edge > a.edge ? b : a)) : null;
        return { kind: "ou", modelProb: m.modelProb, line: m.line, predictedValue: m.predictedValue,
          recommendation: m.recommendation, best, edge: best ? best.edge : null };
      }
      const outs = m.outcomes.map((o) => {
        const src = o.sources.filter((s) => sel.has(s.source));
        const best = src.length ? src.reduce((a, b) => (b.edge > a.edge ? b : a)) : null;
        return { name: o.name, modelProb: o.modelProb, best, edge: best ? best.edge : null };
      });
      const scored = outs.filter((o) => o.best);
      const rec = scored.length
        ? scored.reduce((a, b) => (b.edge > a.edge ? b : a))
        : outs.reduce((a, b) => (b.modelProb > a.modelProb ? b : a), outs[0] || { modelProb: 0 });
      return { kind: "cat", outcomes: outs, recommendation: rec.name, modelProb: rec.modelProb,
        best: rec.best, edge: rec.best ? rec.best.edge : null };
    }

    pickText(meta, r) {
      if (r.kind === "ou") {
        const side = r.recommendation === "over" ? "Over" : "Under";
        return `${side} ${r.line != null ? r.line : "—"}${meta.unit ? " " + meta.unit : ""}`;
      }
      return NP.OUTCOME_LABEL[r.recommendation] || r.recommendation || "—";
    }
    projText(meta, r) {
      if (r.kind === "ou") return r.predictedValue != null ? `Model projects ${r.predictedValue} ${meta.unit}` : "";
      return "Recommended outcome";
    }
    edgeBoxBig(e, min) {
      const t = this.tier(e);
      return `display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:${min}px;padding:.55rem .5rem;border-radius:12px;background:${t.bg};color:${t.fg};flex:none;`;
    }
    chipSm(e) {
      const t = this.tier(e);
      return `font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:.82rem;padding:.16rem .5rem;border-radius:6px;background:${t.bg};color:${t.fg};white-space:nowrap;`;
    }
    sortVal(r) {
      if (this.state.sortBy === "price") return r.best.price;
      if (this.state.sortBy === "implied") return r.best.impliedProb;
      return r.edge;
    }
    sortList(list) {
      const key = this.state.sortBy;
      return list.sort((a, b) => key === "implied" ? this.sortVal(a.r) - this.sortVal(b.r) : this.sortVal(b.r) - this.sortVal(a.r));
    }

    // ── click delegation ─────────────────────────────────────────────────
    _onClick(e) {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      const act = el.getAttribute("data-act");
      const arg = el.getAttribute("data-arg");
      switch (act) {
        case "view": return this.setState({ view: arg, openMenu: null });
        case "theme": {
          const dark = !this.state.dark;
          localStorage.setItem("np-theme", dark ? "dark" : "light");
          return this.setState({ dark });
        }
        case "phase": return this.setState({ phase: arg });
        case "toggleGames": return this.setState({ openMenu: this.state.openMenu === "games" ? null : "games" });
        case "toggleSources": return this.setState({ openMenu: this.state.openMenu === "sources" ? null : "sources" });
        case "closeMenu": return this.setState({ openMenu: null });
        case "allGames": return this.setState({ games: {} });
        case "game": return this.toggleGame(Number(arg));
        case "source": return this.toggleSource(arg);
        case "sort": return this.setState({ sortBy: arg });
        case "filter": return this.setState({ marketFilter: arg });
        case "edgeCard": return this.setState({ view: "markets", activeMarket: arg });
        case "market": return this.setState({ activeMarket: arg });
        case "feedGame": return this.setState({ feedGame: Number(arg) });
      }
    }
    toggleGame(pk) { const g = Object.assign({}, this.state.games); g[pk] = this.gameOn(pk) ? false : true; this.setState({ games: g }); }
    toggleSource(k) {
      const s = Object.assign({}, this.state.sources);
      const on = Object.keys(s).filter((x) => s[x]);
      if (on.length === 1 && s[k]) return; // keep at least one selected
      s[k] = !s[k]; this.setState({ sources: s });
    }

    // build the raw opportunity list for the current phase
    boardOpps() {
      const sel = this.selectedSourceSet();
      const upcoming = this.state.phase === "upcoming";
      const out = [];
      for (const g of this.selectedGames()) {
        const mset = upcoming ? g.mNext : g.m;
        const batter = upcoming ? g.onDeckBatter : g.batter;
        for (const key of Object.keys(NP.MARKETS)) {
          const r = this.resolve(mset[key], sel);
          if (!r.best) continue;
          out.push({ g, key, meta: NP.MARKETS[key], r, batter, upcoming });
        }
      }
      return out;
    }

    // ══ header + shared control bar ══════════════════════════════════════
    seg(on) {
      return `white-space:nowrap;border:0;cursor:pointer;font-family:inherit;font-weight:700;border-radius:999px;transition:all .14s;background:${on ? "var(--seg-active-bg)" : "transparent"};color:${on ? "var(--seg-active-fg)" : "var(--muted)"};box-shadow:${on ? "0 1px 2px rgba(15,27,45,.14)" : "none"};`;
    }
    headerHtml() {
      const view = this.state.view;
      const tabs = [["edges", "Edges"], ["markets", "Markets"], ["data", "Data Feed"]].map(([k, label]) => {
        const on = view === k;
        const style = `border:0;cursor:pointer;font-family:inherit;font-weight:700;font-size:.84rem;padding:.4rem .85rem;border-radius:999px;transition:all .14s;background:${on ? "var(--seg-active-bg)" : "transparent"};color:${on ? "var(--seg-active-fg)" : "var(--muted)"};box-shadow:${on ? "0 1px 2px rgba(15,27,45,.14)" : "none"};`;
        return `<button data-act="view" data-arg="${k}" style="${style}">${label}</button>`;
      }).join("");
      const dark = this.dk();
      const liveCount = NP.games.filter((g) => !g.stale).length;
      const liveText = `${liveCount} game${liveCount === 1 ? "" : "s"} live · ${this.live ? "auto-refreshing" : "sample board"}`;
      return `
      <header style="position:sticky;top:0;z-index:50;background:var(--header-bg);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);">
        <div style="width:min(1220px,95vw);margin:0 auto;display:flex;align-items:center;gap:.7rem 1.1rem;flex-wrap:wrap;padding:.7rem 0;">
          <a href="index.html" style="display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:1.16rem;letter-spacing:-.02em;color:inherit;text-decoration:none;">
            <span style="color:var(--accent);font-size:.85rem;">◆</span>
            <span>Next<span style="color:var(--accent);">Pitch</span></span>
          </a>
          <div style="display:flex;align-items:center;gap:.42rem;font-size:.78rem;color:var(--muted);font-weight:600;">
            <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:np-pulse 1.8s ease-in-out infinite;"></span>
            ${esc(liveText)}
          </div>
          <nav style="margin-left:auto;display:flex;gap:.22rem;background:var(--track);border:1px solid var(--border);border-radius:999px;padding:.25rem;">${tabs}</nav>
          <button data-act="theme" title="Toggle light / dark" style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:999px;border:1px solid var(--border-2);background:var(--surface);color:var(--text-2);cursor:pointer;font-size:.95rem;line-height:1;">${dark ? "☀" : "☾"}</button>
          <a href="index.html" style="display:inline-flex;align-items:center;gap:.35rem;font-size:.82rem;font-weight:600;color:var(--text-2);text-decoration:none;border:1px solid var(--border-2);border-radius:999px;padding:.4rem .8rem;">← Home</a>
        </div>
      </header>`;
    }

    controlBarHtml() {
      const st = this.state;
      const phaseTabs = [["live", "Live"], ["upcoming", "Upcoming"]].map(([k, label]) => {
        const on = st.phase === k;
        return `<button data-act="phase" data-arg="${k}" style="${this.seg(on)}font-size:.82rem;padding:.35rem .85rem;">${label}</button>`;
      }).join("");

      const sel = this.selectedGames();
      const gameBtnStyle = `white-space:nowrap;display:inline-flex;align-items:center;gap:.4rem;border:1px solid ${st.openMenu === "games" ? "var(--text)" : "var(--border-2)"};background:var(--surface);color:var(--text-2);font-family:inherit;font-weight:600;font-size:.82rem;padding:.42rem .8rem;border-radius:8px;cursor:pointer;`;
      const gameMenuLabel = sel.length === NP.games.length ? "All games" : `${sel.length} game${sel.length === 1 ? "" : "s"}`;
      const checkBox = (on) => `display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:5px;font-size:.7rem;color:#fff;border:1.5px solid ${on ? "var(--accent)" : "var(--border-2)"};background:${on ? "var(--accent)" : "var(--surface)"};flex:none;`;
      const gameItems = NP.games.map((g) => {
        const on = this.gameOn(g.gamePk);
        return `<div data-act="game" data-arg="${g.gamePk}" style="display:flex;align-items:center;gap:.55rem;padding:.4rem .45rem;border-radius:7px;cursor:pointer;font-size:.86rem;font-weight:600;color:var(--text);">
          <span style="${checkBox(on)}">${on ? "✓" : ""}</span>${esc(g.label)}</div>`;
      }).join("");
      const gamesMenu = st.openMenu === "games" ? `
        <div style="position:absolute;z-index:60;top:calc(100% + 6px);left:0;background:var(--surface);border:1px solid var(--border);border-radius:11px;box-shadow:0 12px 30px rgba(15,27,45,.16);padding:.4rem;min-width:210px;">
          <div style="display:flex;justify-content:space-between;padding:.2rem .45rem .4rem;font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:700;">
            <span>Games</span><button data-act="allGames" style="border:0;background:none;color:var(--blue);font-weight:700;font-size:.7rem;cursor:pointer;font-family:inherit;">All</button>
          </div>${gameItems}
        </div>` : "";

      const srcSel = Object.keys(st.sources).filter((k) => st.sources[k]);
      const srcBtnStyle = `white-space:nowrap;display:inline-flex;align-items:center;gap:.4rem;border:1px solid ${st.openMenu === "sources" ? "var(--text)" : "var(--border-2)"};background:var(--surface);color:var(--text-2);font-family:inherit;font-weight:600;font-size:.82rem;padding:.42rem .8rem;border-radius:8px;cursor:pointer;`;
      const srcMenuLabel = srcSel.length === 4 ? "All sources" : `${srcSel.length} source${srcSel.length === 1 ? "" : "s"}`;
      const sourceItems = Object.keys(NP.SOURCES).map((k) => {
        const s = NP.SOURCES[k]; const on = !!st.sources[k];
        const tagStyle = `margin-left:auto;font-size:.6rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:${s.type === "book" ? "var(--blue)" : "var(--purple)"};background:${s.type === "book" ? "var(--blue-bg)" : "var(--purple-bg)"};padding:.1rem .38rem;border-radius:4px;`;
        return `<div data-act="source" data-arg="${k}" style="display:flex;align-items:center;gap:.55rem;padding:.4rem .45rem;border-radius:7px;cursor:pointer;font-size:.86rem;font-weight:600;color:var(--text);">
          <span style="${checkBox(on)}">${on ? "✓" : ""}</span>${esc(s.name)}
          <span style="${tagStyle}">${s.type === "book" ? "Book" : "Market"}</span></div>`;
      }).join("");
      const sourcesMenu = st.openMenu === "sources" ? `
        <div style="position:absolute;z-index:60;top:calc(100% + 6px);left:0;background:var(--surface);border:1px solid var(--border);border-radius:11px;box-shadow:0 12px 30px rgba(15,27,45,.16);padding:.4rem;min-width:230px;">
          <div style="padding:.2rem .45rem .4rem;font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:700;">Compare sources</div>${sourceItems}
        </div>` : "";

      const sortTabs = [["edge", "Edge"], ["price", "Price"], ["implied", "Implied"]].map(([k, label]) => {
        const on = st.sortBy === k;
        return `<button data-act="sort" data-arg="${k}" style="${this.seg(on).replace("999px", "6px")}font-size:.78rem;padding:.32rem .7rem;">${label}</button>`;
      }).join("");

      const overlay = st.openMenu != null ? `<div data-act="closeMenu" style="position:fixed;inset:0;z-index:55;"></div>` : "";

      return `
      ${overlay}
      <div style="display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;margin-bottom:1.1rem;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.6rem .7rem;box-shadow:0 1px 2px rgba(15,27,45,.04);">
        <div style="display:flex;gap:.2rem;background:var(--track);border-radius:999px;padding:.22rem;">${phaseTabs}</div>
        <div style="width:1px;align-self:stretch;background:var(--border);margin:.1rem .1rem;"></div>
        <div style="position:relative;">
          <button data-act="toggleGames" style="${gameBtnStyle}">${esc(gameMenuLabel)} <span style="opacity:.5;">▾</span></button>${gamesMenu}
        </div>
        <div style="position:relative;">
          <button data-act="toggleSources" style="${srcBtnStyle}">${esc(srcMenuLabel)} <span style="opacity:.5;">▾</span></button>${sourcesMenu}
        </div>
        <div style="margin-left:auto;display:flex;align-items:center;gap:.45rem;">
          <span style="font-size:.72rem;color:var(--faint);font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Sort</span>
          <div style="display:flex;gap:.2rem;background:var(--track);border-radius:8px;padding:.22rem;">${sortTabs}</div>
        </div>
      </div>`;
    }

    boardHeadingHtml() {
      const view = this.state.view;
      const upcoming = this.state.phase === "upcoming";
      let title, sub;
      if (view === "markets") {
        const meta = NP.MARKETS[this.state.activeMarket];
        title = "Markets";
        sub = `${meta.label} · ${upcoming ? "on-deck batter" : "live at-bat"} · best edge from your selected sources`;
      } else {
        const n = this.boardOpps().length;
        title = upcoming ? "Upcoming edges" : "Live edges";
        sub = upcoming
          ? `${n} on-deck opportunities · pre-scout the next batter before the at-bat`
          : `${n} opportunities · model probability vs the best available price`;
      }
      return `
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
        <div>
          <h1 style="font-size:clamp(1.5rem,3vw,2.05rem);font-weight:800;letter-spacing:-.02em;margin:0;">${esc(title)}</h1>
          <p style="margin:.3rem 0 0;color:var(--muted);font-size:.95rem;">${esc(sub)}</p>
        </div>
      </div>`;
    }

    // ══ EDGES board ══════════════════════════════════════════════════════
    edgesHtml() {
      const opps = this.boardOpps();
      const counts = { all: 0 };
      Object.keys(NP.MARKETS).forEach((k) => (counts[k] = 0));
      opps.forEach((o) => { if (o.r.edge >= 0.01) { counts.all++; counts[o.key]++; } });
      const filter = this.state.marketFilter;
      const filterDefs = [["all", "All"]].concat(Object.keys(NP.MARKETS).map((k) => [k, NP.MARKETS[k].short]));
      const filters = filterDefs.map(([k, label]) => {
        const active = filter === k;
        const style = `border:1px solid ${active ? "var(--pill-active-bg)" : "var(--border-2)"};background:${active ? "var(--pill-active-bg)" : "var(--surface)"};color:${active ? "var(--pill-active-fg)" : "var(--text-2)"};font-family:inherit;font-weight:600;font-size:.82rem;padding:.4rem .82rem;border-radius:999px;cursor:pointer;transition:all .14s;`;
        return `<button data-act="filter" data-arg="${k}" style="${style}">${esc(label)}<span style="opacity:.5;margin-left:.34rem;font-family:'IBM Plex Mono',monospace;">${counts[k] || 0}</span></button>`;
      }).join("");

      const rows = this.sortList(opps.filter((o) => filter === "all" || o.key === filter));
      const cards = rows.map((o) => {
        const r = o.r, g = o.g, meta = o.meta;
        const cardStyle = `background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1rem 1.1rem;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);cursor:pointer;opacity:${g.stale ? 0.74 : 1};`;
        const upBadge = o.upcoming ? `<span style="font-size:.6rem;font-weight:700;letter-spacing:.06em;color:var(--purple);background:var(--purple-bg);padding:.14rem .44rem;border-radius:5px;">ON DECK</span>` : "";
        const staleBadge = g.stale ? `<span style="font-size:.6rem;font-weight:700;color:var(--amber);background:var(--amber-bg);padding:.14rem .44rem;border-radius:5px;">STALE</span>` : "";
        const proj = r.kind === "ou" ? this.projText(meta, r) : "";
        return `
        <div class="np-card-hover" data-act="edgeCard" data-arg="${o.key}" style="${cardStyle}">
          <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.6rem;">
            <span style="font-size:.7rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--blue);background:var(--blue-bg);padding:.2rem .5rem;border-radius:6px;">${esc(meta.short)}</span>
            <span style="font-weight:700;font-size:.92rem;">${esc(g.label)}</span>
            <span style="font-size:.78rem;color:var(--faint);font-family:'IBM Plex Mono',monospace;">${esc(this.situationText(g))}</span>
            ${upBadge}${staleBadge}
          </div>
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.9rem;">
            <div style="min-width:0;">
              <div style="font-weight:800;font-size:1.5rem;letter-spacing:-.01em;line-height:1.1;">${esc(this.pickText(meta, r))}</div>
              <div style="font-size:.86rem;color:var(--text-2);margin-top:.3rem;">${esc(this.player(g.pitcher))} <span style="color:var(--vs);">vs</span> ${esc(this.player(o.batter))}</div>
              <div style="font-size:.78rem;color:var(--faint);margin-top:.12rem;">${esc(proj)}</div>
            </div>
            <div style="${this.edgeBoxBig(r.edge, 108)}">
              <span style="font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:1.55rem;line-height:1;">${esc(this.fmtEdge(r.edge))}</span>
              <span style="font-size:.6rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;margin-top:.3rem;opacity:.85;">Edge · ${esc(this.tier(r.edge).label)}</span>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin-top:.85rem;">
            <div style="background:var(--good-bg);border:1px solid var(--good-border);border-radius:10px;padding:.6rem .7rem;">
              <div style="font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--good-label);">Model predicts</div>
              <div style="font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:1.7rem;line-height:1;color:var(--good-strong);margin-top:.25rem;">${esc(this.pct(r.modelProb))}</div>
              <div style="font-size:.72rem;color:var(--good-sub);margin-top:.2rem;">fair ${esc(this.am(NP.americanFromImplied(r.modelProb)))}</div>
            </div>
            <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:.6rem .7rem;">
              <div style="display:flex;justify-content:space-between;align-items:baseline;"><span style="font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);">Market implies</span><span style="font-size:.68rem;font-weight:700;color:var(--blue);">${esc(r.best.short)}</span></div>
              <div style="font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:1.7rem;line-height:1;color:var(--text);margin-top:.25rem;">${esc(this.pct1(r.best.impliedProb))}</div>
              <div style="font-size:.72rem;color:var(--muted);margin-top:.2rem;">${r.best.type === "book" ? "Sportsbook" : "Prediction mkt"} · ${esc(this.am(r.best.price))}</div>
            </div>
          </div>
        </div>`;
      }).join("");

      const empty = rows.length === 0
        ? `<div style="padding:3rem 0;text-align:center;color:var(--faint);font-size:.95rem;">No opportunities match these filters.</div>` : "";

      return `
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1.1rem;">${filters}</div>
      ${empty}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(500px,1fr));gap:.9rem;">${cards}</div>`;
    }

    // ══ MARKETS ══════════════════════════════════════════════════════════
    marketsHtml() {
      const active = this.state.activeMarket;
      const meta = NP.MARKETS[active];
      const sel = this.selectedSourceSet();
      const upcoming = this.state.phase === "upcoming";
      const marketTabs = Object.keys(NP.MARKETS).map((k) => {
        const on = active === k;
        const style = `border:1px solid ${on ? "var(--accent)" : "var(--border-2)"};background:${on ? "var(--accent)" : "var(--surface)"};color:${on ? "#fff" : "var(--text-2)"};font-family:inherit;font-weight:600;font-size:.84rem;padding:.46rem .9rem;border-radius:9px;cursor:pointer;transition:all .14s;`;
        return `<button data-act="market" data-arg="${k}" style="${style}">${esc(NP.MARKETS[k].label)}</button>`;
      }).join("");

      let opps = this.selectedGames().map((g) => {
        const mset = upcoming ? g.mNext : g.m;
        const r = this.resolve(mset[active], sel);
        const batter = upcoming ? g.onDeckBatter : g.batter;
        if (!r.best) return null;
        return { g, r, batter };
      }).filter(Boolean);
      opps.sort((a, b) => this.state.sortBy === "implied" ? this.sortVal(a.r) - this.sortVal(b.r) : this.sortVal(b.r) - this.sortVal(a.r));

      const cards = opps.map(({ g, r, batter }) => {
        const cardStyle = `background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.05rem 1.15rem;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);opacity:${g.stale ? 0.78 : 1};`;
        const upBadge = upcoming ? `<span style="font-size:.6rem;font-weight:700;letter-spacing:.06em;color:var(--purple);background:var(--purple-bg);padding:.14rem .44rem;border-radius:5px;">ON DECK</span>` : "";
        const staleBadge = g.stale ? `<span style="font-size:.6rem;font-weight:700;color:var(--amber);background:var(--amber-bg);padding:.14rem .44rem;border-radius:5px;">STALE</span>` : "";
        const proj = r.kind === "ou" ? this.projText(meta, r) : "";
        let dist = "";
        if (r.kind === "cat") {
          const rows = r.outcomes.slice().sort((a, b) => b.modelProb - a.modelProb).map((o) => {
            const isRec = o.name === r.recommendation;
            const nameStyle = `font-size:.84rem;font-weight:${isRec ? 700 : 500};color:${isRec ? "var(--good-strong)" : "var(--text-2)"};`;
            const barW = `height:100%;width:${Math.round(o.modelProb * 100)}%;background:${isRec ? "var(--accent)" : "var(--vs)"};border-radius:999px;`;
            return `<div style="display:grid;grid-template-columns:1.1fr 2fr auto;gap:.6rem;align-items:center;padding:.24rem 0;">
              <div style="${nameStyle}">${esc(NP.OUTCOME_LABEL[o.name] || o.name)}</div>
              <div style="height:7px;background:var(--track);border-radius:999px;overflow:hidden;"><div style="${barW}"></div></div>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:.82rem;font-weight:600;color:var(--text-2);min-width:34px;text-align:right;">${esc(this.pct(o.modelProb))}</span>
            </div>`;
          }).join("");
          dist = `<div style="margin-top:.85rem;padding-top:.7rem;border-top:1px solid var(--border);">
            <div style="font-size:.64rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);margin-bottom:.5rem;">Model distribution</div>${rows}</div>`;
        }
        return `
        <div style="${cardStyle}">
          <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.55rem;">
            <span style="font-weight:800;font-size:1.05rem;letter-spacing:-.01em;">${esc(g.label)}</span>
            <span style="font-size:.76rem;color:var(--faint);font-family:'IBM Plex Mono',monospace;">${esc(this.situationText(g))}</span>
            ${upBadge}${staleBadge}
          </div>
          <div style="font-size:.84rem;color:var(--text-2);margin-bottom:.7rem;">${esc(this.player(g.pitcher))} <span style="color:var(--vs);">vs</span> ${esc(this.player(batter))}</div>
          <div style="display:flex;align-items:stretch;gap:.7rem;">
            <div style="flex:1;display:flex;flex-direction:column;justify-content:center;">
              <div style="font-weight:800;font-size:1.35rem;letter-spacing:-.01em;line-height:1.1;">${esc(this.pickText(meta, r))}</div>
              <div style="font-size:.78rem;color:var(--faint);margin-top:.25rem;">${esc(proj)}</div>
            </div>
            <div style="${this.edgeBoxBig(r.edge, 96)}">
              <span style="font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:1.45rem;line-height:1;">${esc(this.fmtEdge(r.edge))}</span>
              <span style="font-size:.58rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;margin-top:.28rem;opacity:.85;">Best edge</span>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin-top:.8rem;">
            <div style="background:var(--good-bg);border:1px solid var(--good-border);border-radius:10px;padding:.55rem .7rem;">
              <div style="font-size:.64rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--good-label);">Predicted (model)</div>
              <div style="font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:1.55rem;line-height:1;color:var(--good-strong);margin-top:.22rem;">${esc(this.pct(r.modelProb))}</div>
              <div style="font-size:.7rem;color:var(--good-sub);margin-top:.18rem;">fair ${esc(this.am(NP.americanFromImplied(r.modelProb)))}</div>
            </div>
            <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:.55rem .7rem;">
              <div style="display:flex;justify-content:space-between;align-items:baseline;"><span style="font-size:.64rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);">Implied (${esc(r.best.short)})</span></div>
              <div style="font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:1.55rem;line-height:1;color:var(--text);margin-top:.22rem;">${esc(this.pct1(r.best.impliedProb))}</div>
              <div style="font-size:.7rem;color:var(--muted);margin-top:.18rem;">${r.best.type === "book" ? "Sportsbook" : "Prediction mkt"} · ${esc(this.am(r.best.price))}</div>
            </div>
          </div>
          ${dist}
        </div>`;
      }).join("");

      const empty = opps.length === 0
        ? `<div style="padding:3rem 0;text-align:center;color:var(--faint);font-size:.95rem;">No games match these filters.</div>` : "";

      return `
      <div style="display:flex;gap:.45rem;flex-wrap:wrap;margin-bottom:1.2rem;">${marketTabs}</div>
      ${empty}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(500px,1fr));gap:.9rem;">${cards}</div>`;
    }

    // ══ DATA FEED ════════════════════════════════════════════════════════
    dataHtml() {
      if (!NP.games.length) return `<div style="padding:3rem 0;text-align:center;color:var(--faint);">No live games right now.</div>`;
      const sel = NP.games.find((g) => g.gamePk === this.state.feedGame) || NP.games[0];
      const gameSel = NP.games.map((g) => {
        const on = g.gamePk === sel.gamePk;
        const style = `display:flex;align-items:center;gap:.4rem;border:1px solid ${on ? "var(--pill-active-bg)" : "var(--border-2)"};background:${on ? "var(--pill-active-bg)" : "var(--surface)"};color:${on ? "var(--pill-active-fg)" : "var(--text-2)"};font-family:inherit;font-weight:600;font-size:.8rem;padding:.4rem .72rem;border-radius:999px;cursor:pointer;transition:all .14s;`;
        const dot = `width:7px;height:7px;border-radius:50%;background:${g.stale ? "#c9a23a" : "var(--accent)"};`;
        return `<button data-act="feedGame" data-arg="${g.gamePk}" style="${style}"><span style="${dot}"></span>${esc(g.label)}</button>`;
      }).join("");

      // pitch log
      const pitchEmpty = sel.pitches.length === 0;
      const pitchRows = sel.pitches.map((p) => {
        const [label, tone] = this.resultMeta(p.desc);
        const speedText = p.speed != null ? p.speed.toFixed(1) : "—";
        return `<div style="display:grid;grid-template-columns:38px 56px 64px 46px 1fr 56px;gap:.4rem;align-items:center;padding:.42rem .3rem;border-bottom:1px solid var(--row-border);font-size:.84rem;">
          <span style="font-family:'IBM Plex Mono',monospace;color:var(--faint);">${esc(p.n)}</span>
          <span style="font-weight:600;">${esc(p.type)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;color:var(--text-2);">${esc(speedText)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;color:var(--faint);">${esc(p.zone)}</span>
          <span style="color:${tone};font-weight:600;">${esc(label)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;color:var(--text-2);text-align:right;">${esc(p.balls)}-${esc(p.strikes)}</span>
        </div>`;
      }).join("");

      const abr = sel.m.ab_result, abp = sel.m.ab_pitches_ou;
      const abProj = abp.line != null
        ? `${abp.recommendation === "over" ? "Over" : "Under"} ${abp.line} (proj ${abp.predictedValue != null ? abp.predictedValue : "—"})`
        : "—";

      // broadcast scoreboard
      const cnt = (sel.count || "0-0").split("-").map(Number);
      const balls = cnt[0] || 0, strikes = cnt[1] || 0;
      const dots = (n, filled, color) => Array.from({ length: n }, (_, i) =>
        `<span style="width:11px;height:11px;border-radius:50%;background:${i < filled ? color : "#22344d"};"></span>`).join("");
      const basePos = { two: "left:50%;top:2px;transform:translateX(-50%) rotate(45deg);", three: "left:2px;top:50%;transform:translateY(-50%) rotate(45deg);", one: "right:2px;top:50%;transform:translateY(-50%) rotate(45deg);" };
      const baseStyle = (onBase, pos) => `position:absolute;${pos}width:22px;height:22px;border-radius:4px;background:${onBase ? "#4ade80" : "#16263d"};border:2px solid ${onBase ? "#4ade80" : "#3a4c66"};`;
      const abConf = abr.conf != null ? abr.conf : abr.modelProb;
      const abCall = NP.OUTCOME_LABEL[abr.recommendation] || abr.recommendation || "—";

      const liveAtBats = NP.games.map((g) => {
        const m = g.m.ab_result;
        return `<div style="opacity:${g.stale ? 0.6 : 1};">
          <div style="display:grid;grid-template-columns:1fr 1.2fr 1.2fr .6fr .5fr .9fr auto;gap:.5rem;align-items:center;padding:.5rem .4rem;border-bottom:1px solid var(--row-border);font-size:.82rem;">
            <span style="font-weight:700;">${esc(g.label)}</span>
            <span style="color:var(--text-2);">${esc(g.pitcher.name)}</span>
            <span style="color:var(--text-2);">${esc(g.batter.name)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;color:var(--muted);">${esc(g.count)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;color:var(--muted);">${esc(g.pitchCountPa)}</span>
            <span style="font-weight:600;">${esc(NP.OUTCOME_LABEL[m.recommendation] || m.recommendation || "—")} <span style="color:var(--faint);font-weight:500;font-family:'IBM Plex Mono',monospace;font-size:.74rem;">${esc(this.pct(m.modelProb))}</span></span>
            <span style="text-align:right;"><span style="${this.chipSm(m.edge)}">${esc(this.fmtEdge(m.edge))}</span></span>
          </div>
        </div>`;
      }).join("");

      const d = this.dk();
      const recentRows = NP.RECENT.map((r) => {
        const tone = r.result === "win" ? (d ? ["#5fe093", "#123020"] : ["#0f7a44", "#e7f4ed"])
          : r.result === "loss" ? (d ? ["#ff7b6b", "#3a1c1a"] : ["#c0392f", "#fbece9"])
            : (d ? ["#e0a83a", "#33280d"] : ["#b07d12", "#fbf2dc"]);
        const style = `color:${tone[0]};background:${tone[1]};font-weight:700;font-size:.68rem;padding:.16rem .45rem;border-radius:5px;letter-spacing:.03em;`;
        return `<div style="display:grid;grid-template-columns:.6fr 1fr 1.2fr 1.6fr .5fr .7fr auto;gap:.5rem;align-items:center;padding:.5rem .4rem;border-bottom:1px solid var(--row-border);font-size:.82rem;">
          <span style="font-family:'IBM Plex Mono',monospace;color:var(--faint);">${esc(r.date.slice(5))}</span>
          <span style="font-weight:600;">${esc(r.matchup)}</span>
          <span style="color:var(--text-2);">${esc(r.batter)}</span>
          <span style="color:var(--text-2);">${esc(r.pick)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;color:var(--muted);">${esc(r.pitches)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;color:var(--text-2);">${esc(this.am(r.price))}</span>
          <span style="text-align:right;"><span style="${style}">${esc(r.result.toUpperCase())}</span></span>
        </div>`;
      }).join("");

      return `
      <div style="margin-bottom:.9rem;">
        <h1 style="font-size:clamp(1.5rem,3vw,2.05rem);font-weight:800;letter-spacing:-.02em;margin:0;">Data feed</h1>
        <p style="margin:.3rem 0 0;color:var(--muted);font-size:.95rem;">Pitch-by-pitch and at-bat data, straight from the live feed.</p>
      </div>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1.1rem;">${gameSel}</div>

      <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:stretch;margin-bottom:1.4rem;">
        <div style="flex:1;min-width:290px;background:var(--bc-bg);color:#eaf1f8;border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 2px rgba(15,27,45,.06),0 8px 22px rgba(15,27,45,.14);padding:1.1rem 1.2rem;display:flex;flex-direction:column;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
            <div style="font-size:.66rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#7fa0c4;">Live situation</div>
            <div style="font-size:.72rem;color:#7fa0c4;font-family:'IBM Plex Mono',monospace;">${esc(sel.venue)}</div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:.6rem;background:var(--bc-inner);border-radius:11px;padding:.7rem .9rem;">
            <div style="display:flex;flex-direction:column;align-items:center;min-width:52px;">
              <span style="font-size:.74rem;color:#9fb6d1;font-weight:700;letter-spacing:.03em;">${esc(sel.away)}</span>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:1.8rem;font-weight:600;line-height:1.1;">${esc(sel.score.away)}</span>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:.15rem;">
              <span style="font-size:1.1rem;line-height:1;color:#4ade80;">${esc(sel.half)}</span>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:.9rem;font-weight:600;color:#eaf1f8;">Inn ${esc(sel.inning)}</span>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;min-width:52px;">
              <span style="font-size:.74rem;color:#9fb6d1;font-weight:700;letter-spacing:.03em;">${esc(sel.home)}</span>
              <span style="font-family:'IBM Plex Mono',monospace;font-size:1.8rem;font-weight:600;line-height:1.1;">${esc(sel.score.home)}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:1.2rem;margin-top:1rem;">
            <div style="position:relative;width:96px;height:96px;flex:none;">
              <div style="${baseStyle(sel.runners.second, basePos.two)}"></div>
              <div style="${baseStyle(sel.runners.third, basePos.three)}"></div>
              <div style="${baseStyle(sel.runners.first, basePos.one)}"></div>
              <div style="position:absolute;bottom:2px;left:50%;transform:translateX(-50%) rotate(45deg);width:15px;height:15px;border-radius:2px;background:#eaf1f8;border:2px solid #eaf1f8;"></div>
            </div>
            <div style="display:flex;flex-direction:column;gap:.5rem;flex:1;">
              <div style="display:flex;align-items:center;gap:.6rem;"><span style="font-size:.68rem;font-weight:700;color:#9fb6d1;width:14px;">B</span><div style="display:flex;gap:.32rem;">${dots(3, balls, "#4ade80")}</div></div>
              <div style="display:flex;align-items:center;gap:.6rem;"><span style="font-size:.68rem;font-weight:700;color:#9fb6d1;width:14px;">S</span><div style="display:flex;gap:.32rem;">${dots(2, strikes, "#facc15")}</div></div>
              <div style="display:flex;align-items:center;gap:.6rem;"><span style="font-size:.68rem;font-weight:700;color:#9fb6d1;width:14px;">O</span><div style="display:flex;gap:.32rem;">${dots(2, sel.outs, "#fb7185")}</div></div>
            </div>
          </div>
          <div style="margin-top:1rem;padding-top:.85rem;border-top:1px solid #24354e;display:flex;flex-direction:column;gap:.5rem;">
            <div style="display:flex;justify-content:space-between;gap:.6rem;font-size:.86rem;"><span style="color:#7fa0c4;">Pitcher</span><span style="font-weight:700;">${esc(this.player(sel.pitcher))}</span></div>
            <div style="display:flex;justify-content:space-between;gap:.6rem;font-size:.86rem;"><span style="color:#7fa0c4;">At bat</span><span style="font-weight:700;">${esc(this.player(sel.batter))}</span></div>
          </div>
          <div style="margin-top:.85rem;background:var(--bc-inner);border-radius:11px;padding:.7rem .9rem;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;"><span style="font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#7fa0c4;">Model AB call</span><span style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:#4ade80;font-size:.9rem;">${esc(this.pct(abr.modelProb))}</span></div>
            <div style="font-weight:800;font-size:1.2rem;margin-top:.15rem;">${esc(abCall)}</div>
            <div style="height:6px;background:#0f1b2d;border-radius:999px;overflow:hidden;margin-top:.5rem;"><div style="height:100%;width:${Math.round((abConf || 0) * 100)}%;background:#4ade80;border-radius:999px;"></div></div>
            <div style="font-size:.72rem;color:#7fa0c4;margin-top:.3rem;">${esc(this.pct(abConf))} model confidence · on deck ${esc(sel.onDeckBatter.name)}</div>
          </div>
        </div>

        <div style="flex:1.5;min-width:340px;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);padding:1rem 1.1rem;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:.6rem;flex-wrap:wrap;margin-bottom:.7rem;">
            <div style="font-weight:800;font-size:1rem;">${esc(sel.label)}</div>
            <span style="font-size:.66rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);">This at-bat</span>
          </div>
          <div style="overflow-x:auto;"><div style="min-width:400px;">
            <div style="display:grid;grid-template-columns:38px 56px 64px 46px 1fr 56px;gap:.4rem;font-size:.62rem;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);font-weight:700;padding:0 .3rem .4rem;border-bottom:1px solid var(--border);">
              <span>#</span><span>Type</span><span>Velo</span><span>Zone</span><span>Result</span><span style="text-align:right;">Count</span>
            </div>
            ${pitchEmpty ? `<div style="padding:1.1rem .3rem;color:var(--faint);font-style:italic;font-size:.84rem;">Fresh at-bat — no pitches thrown yet.</div>` : pitchRows}
          </div></div>
          <div style="display:flex;gap:1.4rem;flex-wrap:wrap;margin-top:.9rem;padding-top:.7rem;border-top:1px solid var(--track);font-size:.78rem;color:var(--text-2);">
            <div><span style="color:var(--faint);">Pitches (PA)</span> <b style="font-weight:700;">${esc(sel.pitchCountPa)}</b></div>
            <div><span style="color:var(--faint);">AB pitches proj</span> <b style="font-weight:700;color:var(--accent);">${esc(abProj)}</b></div>
            <div><span style="color:var(--faint);">Model</span> <b style="font-weight:700;">freq_v2</b></div>
          </div>
        </div>
      </div>

      <div style="font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:0 0 .6rem;">Live at-bats · all games</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);padding:.4rem .6rem;overflow-x:auto;margin-bottom:1.6rem;">
        <div style="min-width:540px;">
          <div style="display:grid;grid-template-columns:1fr 1.2fr 1.2fr .6fr .5fr .9fr auto;gap:.5rem;font-size:.62rem;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);font-weight:700;padding:.5rem .4rem;border-bottom:1px solid var(--border);">
            <span>Game</span><span>Pitcher</span><span>Batter</span><span>Count</span><span>P</span><span>Model call</span><span style="text-align:right;">Edge</span>
          </div>
          ${liveAtBats}
        </div>
      </div>

      <div style="font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:0 0 .6rem;">Recently settled at-bats</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);padding:.4rem .6rem;overflow-x:auto;">
        <div style="min-width:560px;">
          <div style="display:grid;grid-template-columns:.6fr 1fr 1.2fr 1.6fr .5fr .7fr auto;gap:.5rem;font-size:.62rem;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);font-weight:700;padding:.5rem .4rem;border-bottom:1px solid var(--border);">
            <span>Date</span><span>Game</span><span>Batter</span><span>Pick</span><span>P</span><span>Price</span><span style="text-align:right;">Result</span>
          </div>
          ${recentRows}
        </div>
      </div>`;
    }

    footerHtml() {
      return `
      <footer style="background:#0f1b2d;color:#c4d1e0;padding:1.8rem 0;">
        <div style="width:min(1220px,95vw);margin:0 auto;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:center;">
          <a href="index.html" style="display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:1.05rem;color:inherit;text-decoration:none;"><span style="color:#4ade80;">◆</span> Next<span style="color:#4ade80;">Pitch</span></a>
          <p style="margin:0;font-size:.74rem;color:#8a9bb2;max-width:46rem;flex:1;min-width:240px;">Illustrative model + market data — not real odds, not betting advice. 21+ and present where betting is legal. Confirm the live price at the book before wagering. Gambling problem? Call 1-800-GAMBLER.</p>
        </div>
      </footer>`;
    }

    render() {
      this.root.setAttribute("data-theme", this.dk() ? "dark" : "light");
      const view = this.state.view;
      let main;
      if (view === "data") main = this.dataHtml();
      else main = this.boardHeadingHtml() + this.controlBarHtml() + (view === "markets" ? this.marketsHtml() : this.edgesHtml());
      this.root.innerHTML = `
        ${this.headerHtml()}
        <main style="width:min(1220px,95vw);margin:0 auto;padding:1.4rem 0 3rem;flex:1;align-self:stretch;">${main}</main>
        ${this.footerHtml()}`;
    }

    // ── data lifecycle ────────────────────────────────────────────────────
    startSim() {
      clearInterval(this._simIv);
      this._simIv = setInterval(() => {
        if (this.live) return;
        NP.tick(NP.games);
        this.setState({ t: this.state.t + 1 });
      }, SIM_MS);
    }
    async poll() {
      try {
        const games = await NP.loadLive(API_BASE);
        if (games && games.length) {
          NP.games = games;
          if (!this.live) { this.live = true; clearInterval(this._simIv); }
          // keep feedGame valid across refreshes
          if (!games.some((g) => g.gamePk === this.state.feedGame)) this.state.feedGame = games[0].gamePk;
          this.render();
        } else if (this.live) {
          // backend reachable but no games now — leave last render in place
        }
      } catch (_e) {
        // backend unreachable → stay on the sample board (sim keeps it moving)
      }
    }
    start() {
      this.render();
      this.startSim();
      this.poll();
      this._pollIv = setInterval(() => this.poll(), POLL_MS);
    }
  }

  function boot() {
    const root = document.getElementById("np-root");
    if (!window.NEXTPITCH) {
      root.innerHTML = `<div style="padding:4.5rem 0;text-align:center;color:#7a879c;font-size:.95rem;">Loading live edges…</div>`;
      return;
    }
    const board = new Board(root);
    board.state.feedGame = NP.games[0] ? NP.games[0].gamePk : null;
    board.start();
    window.__npBoard = board;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
