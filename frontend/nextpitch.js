// ════════════════════════════════════════════════════════════════════════
// nextpitch.js — NextPitch single-page app.
//
// One page, three tabs: Home / Live Markets / Data Feed. Vanilla port of the
// design reference's `class Component` (design_handoff_live_markets) — same
// client state and data shaping (homeVals / liveVals / dataVals), rendered to
// the DOM without a framework. Markup mirrors the design's inline-styled
// template so it's pixel-faithful across the light/dark token palette.
//
// Data layer:
//   • Home reads window.PICKS_DATA, best-effort hydrated from the backend
//     (/sportsbooks, /picks/today, /record) with sample fallback.
//   • Live Markets + Data Feed read window.NEXTPITCH.games — the bundled sample
//     engine, swapped for real games via NEXTPITCH.loadLive (/live + /edge) when
//     a backend answers. The live backend has no per-pitch model reads, so those
//     feed columns render "—" in live mode (no synthetic betting edges).
// ════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  const API_BASE = window.PITCH_EDGE_API || "http://localhost:8080";
  const POLL_MS = 8000;   // backend polls MLB every ~8s (POLL_INTERVAL_SECONDS)
  const SIM_MS = 5000;    // sample-mode simulated movement

  const NP = window.NEXTPITCH;
  let PD = window.PICKS_DATA;   // Home data (hydrated from the API when reachable)

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function initialDark() {
    const saved = localStorage.getItem("np-theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  // ── Home data loaders (mirror the old site.js seams; sample fallback) ────
  async function fetchJson(path, init) {
    try {
      const r = await fetch(`${API_BASE}${path}`, init);
      return r.ok ? await r.json() : null;
    } catch (_e) { return null; }
  }
  async function hydrateHome() {
    const base = window.PICKS_DATA;
    if (!base) return null;
    const [books, picks, record] = await Promise.all([
      fetchJson("/sportsbooks"), fetchJson("/picks/today"), fetchJson("/record"),
    ]);
    let changed = false;
    const next = Object.assign({}, base);
    if (books && Array.isArray(books.books) && books.books.length) {
      const byKey = {};
      books.books.forEach((b) => (byKey[b.key] = b));
      next.BOOKS = byKey; changed = true;
    }
    if (Array.isArray(picks) && picks.length) { next.PICKS = picks; changed = true; }
    if (record && record.overall) { next.RECORD = record; changed = true; }
    return changed ? next : null;
  }

  class Board {
    constructor(root) {
      this.root = root;
      this.state = {
        view: "home", feedGame: null,
        homeFilter: "best", openPicks: {},
        liveGames: {}, liveSources: { draftkings: true, fanduel: true, kalshi: true, polymarket: true },
        edgeThreshold: 0.03,
        dark: initialDark(), t: 0,
      };
      this.live = false;
      this._simIv = null;
      this._pollIv = null;
      this.root.addEventListener("click", (e) => this._onClick(e));
    }
    setState(patch) { Object.assign(this.state, patch); this.render(); }

    // ── formatters ───────────────────────────────────────────────────────
    dk() { return this.state.dark; }
    pct(p) { return Math.round((p || 0) * 100) + "%"; }
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
    homeEdgeChip(t) {
      const map = { hot: ["var(--good-bg)", "var(--good-strong)"], warm: ["var(--good-bg)", "var(--good-label)"], soft: ["var(--surface-2)", "var(--muted)"], neg: ["var(--bad-bg)", "var(--bad)"] };
      const c = map[t] || map.soft;
      return `display:flex;flex-direction:column;align-items:center;justify-content:center;padding:.34rem .6rem;border-radius:9px;min-width:66px;background:${c[0]};color:${c[1]};flex:none;`;
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
        case "scrollPicks": {
          const t = document.getElementById("home-picks");
          if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 72, behavior: "smooth" });
          return;
        }
        case "theme": {
          const dark = !this.state.dark;
          localStorage.setItem("np-theme", dark ? "dark" : "light");
          return this.setState({ dark });
        }
        case "homeFilter": return this.setState({ homeFilter: arg });
        case "togglePick": {
          const o = Object.assign({}, this.state.openPicks); o[arg] = !o[arg];
          return this.setState({ openPicks: o });
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
        case "feedGame": return this.setState({ feedGame: Number(arg) });
      }
    }

    // ══ HEADER / FOOTER ══════════════════════════════════════════════════
    headerHtml() {
      const view = this.state.view;
      const tabs = [["home", "Home"], ["live", "Live Markets"], ["data", "Data Feed"]].map(([k, label]) => {
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
          <div data-act="goHome" style="display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:1.16rem;letter-spacing:-.02em;color:inherit;cursor:pointer;">
            <span style="color:var(--accent);font-size:.85rem;">◆</span>
            <span>Next<span style="color:var(--accent);">Pitch</span></span>
          </div>
          <div style="display:flex;align-items:center;gap:.42rem;font-size:.78rem;color:var(--muted);font-weight:600;">
            <span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:np-pulse 1.8s ease-in-out infinite;"></span>
            ${esc(liveText)}
          </div>
          <nav style="margin-left:auto;display:flex;gap:.22rem;background:var(--track);border:1px solid var(--border);border-radius:999px;padding:.25rem;">${tabs}</nav>
          <button data-act="theme" title="Toggle light / dark" style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:999px;border:1px solid var(--border-2);background:var(--surface);color:var(--text-2);cursor:pointer;font-size:.95rem;line-height:1;">${dark ? "☀" : "☾"}</button>
        </div>
      </header>`;
    }
    footerHtml() {
      return `
      <footer style="background:#0f1b2d;color:#c4d1e0;padding:1.8rem 0;">
        <div style="width:min(1220px,95vw);margin:0 auto;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:center;">
          <div data-act="goHome" style="display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:1.05rem;color:inherit;cursor:pointer;"><span style="color:#4ade80;">◆</span> Next<span style="color:#4ade80;">Pitch</span></div>
          <p style="margin:0;font-size:.74rem;color:#8a9bb2;max-width:46rem;flex:1;min-width:240px;">Illustrative model + market data — not real odds, not betting advice. 21+ and present where betting is legal. Confirm the live price at the book before wagering. Gambling problem? Call 1-800-GAMBLER.</p>
        </div>
      </footer>`;
    }

    // ══ HOME ═════════════════════════════════════════════════════════════
    homeHtml() {
      const D = PD;
      if (!D) return `<div style="padding:4.5rem 0;text-align:center;color:var(--muted);">Loading…</div>`;
      const o = D.RECORD.overall, l = D.RECORD.last30;
      const winPct = (o.wins / (o.wins + o.losses) * 100).toFixed(1);
      const units = (u) => `${u >= 0 ? "+" : "−"}${Math.abs(u).toFixed(1)}u`;
      const signed = (v, suf) => `${v >= 0 ? "+" : "−"}${Math.abs(v)}${suf || ""}`;
      const implied = (a) => (a == null ? null : a > 0 ? 100 / (a + 100) : -a / (-a + 100));

      const heroUnitsStyle = `font-family:'IBM Plex Mono',monospace;font-size:1.7rem;font-weight:800;color:${o.units >= 0 ? "#4ade80" : "#fb7185"};`;
      const heroRoiStyle = `font-family:'IBM Plex Mono',monospace;font-size:1.7rem;font-weight:800;color:${o.roi >= 0 ? "#4ade80" : "#fb7185"};`;

      // hero
      const hero = `
      <div style="display:grid;grid-template-columns:1.25fr .9fr;gap:2rem;align-items:center;background:linear-gradient(180deg,var(--surface),var(--bg));border:1px solid var(--border);border-radius:18px;padding:clamp(1.6rem,4vw,2.6rem);margin-bottom:1.4rem;">
        <div>
          <span style="display:inline-block;font-size:.74rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--good-strong);background:var(--good-bg);padding:.3rem .6rem;border-radius:999px;margin-bottom:1rem;">MLB · At-Bat Markets</span>
          <h1 style="font-size:clamp(1.9rem,4vw,3rem);font-weight:800;letter-spacing:-.02em;margin:0;line-height:1.08;">The next pitch, called before it's thrown.</h1>
          <p style="font-size:1.08rem;color:var(--text-2);max-width:34rem;margin:1rem 0 1.4rem;">Model-driven picks on strikeouts, pitch speed, and at-bat outcomes — each with the reasoning laid out and a track record you can check before you trust it.</p>
          <div style="display:flex;gap:.7rem;flex-wrap:wrap;">
            <button data-act="goLive" style="display:inline-flex;align-items:center;justify-content:center;gap:.4rem;font-weight:600;font-size:.92rem;padding:.62rem 1.05rem;border-radius:9px;border:1px solid transparent;background:var(--accent);color:#fff;cursor:pointer;font-family:inherit;">Open the live board →</button>
            <button data-act="scrollPicks" style="display:inline-flex;align-items:center;justify-content:center;gap:.4rem;font-weight:600;font-size:.92rem;padding:.62rem 1.05rem;border-radius:9px;border:1px solid var(--border-2);background:var(--surface);color:var(--text);cursor:pointer;font-family:inherit;">See today's picks</button>
          </div>
          <p style="margin-top:1rem;font-size:.8rem;color:var(--muted);letter-spacing:.02em;">21+ · For entertainment · 1-800-GAMBLER</p>
        </div>
        <div style="background:var(--bc-bg);color:#fff;border-radius:14px;padding:1.4rem 1.5rem;box-shadow:0 12px 40px rgba(15,27,45,.18);">
          <span style="font-size:.78rem;font-weight:600;color:#9fb2c9;letter-spacing:.04em;text-transform:uppercase;">Verified track record</span>
          <div style="display:flex;gap:1.3rem;margin:1.1rem 0 1.2rem;flex-wrap:wrap;">
            <div style="display:flex;flex-direction:column;"><span style="font-family:'IBM Plex Mono',monospace;font-size:1.7rem;font-weight:800;">${esc(winPct)}%</span><span style="font-size:.76rem;color:#9fb2c9;margin-top:.15rem;">win rate</span></div>
            <div style="display:flex;flex-direction:column;"><span style="${heroUnitsStyle}">${esc(units(o.units))}</span><span style="font-size:.76rem;color:#9fb2c9;margin-top:.15rem;">net units</span></div>
            <div style="display:flex;flex-direction:column;"><span style="${heroRoiStyle}">${esc(signed(o.roi, "%"))}</span><span style="font-size:.76rem;color:#9fb2c9;margin-top:.15rem;">ROI</span></div>
          </div>
          <div style="font-size:.88rem;font-weight:600;color:#8fd3ad;">Based on ${esc(o.picks)} graded picks</div>
        </div>
      </div>`;

      // today's picks
      const byEdge = (a, b) => (b.edge - a.edge) || (b.confidence - a.confidence);
      const counts = {}; D.PICKS.forEach((p) => (counts[p.market] = (counts[p.market] || 0) + 1));
      const filter = this.state.homeFilter;
      const fdefs = [["best", "Best", D.PICKS.length]].concat(Object.keys(D.MARKETS).filter((k) => counts[k]).map((k) => [k, D.MARKETS[k].label, counts[k]]));
      const homeFilters = fdefs.map(([k, label, n]) => {
        const on = filter === k;
        const style = `display:inline-flex;align-items:center;gap:.4rem;border:1px solid ${on ? "var(--pill-active-bg)" : "var(--border-2)"};background:${on ? "var(--pill-active-bg)" : "var(--surface)"};color:${on ? "var(--pill-active-fg)" : "var(--text-2)"};font-family:inherit;font-weight:600;font-size:.82rem;padding:.42rem .82rem;border-radius:999px;cursor:pointer;transition:all .14s;`;
        return `<button data-act="homeFilter" data-arg="${k}" style="${style}">${esc(label)} <span style="opacity:.6;font-family:'IBM Plex Mono',monospace;">${esc(n)}</span></button>`;
      }).join("");
      const list = (filter === "best" ? D.PICKS.slice() : D.PICKS.filter((p) => p.market === filter)).sort(byEdge);
      const today = new Date().toLocaleDateString(undefined, { month: "long", day: "numeric" });
      const picksSub = filter === "best"
        ? `Top ${list.length} live opportunities across all markets for ${today}, ranked by model edge — tap "Why this pick" for the reasoning.`
        : `${list.length} ${(D.MARKETS[filter] || {}).label || filter} pick${list.length === 1 ? "" : "s"} for ${today}, best edge first.`;

      const cards = list.map((p) => {
        const conf = Math.round((p.confidence || 0) * 100);
        const imp = implied(p.price);
        const tv = p.edge >= 0.06 ? "hot" : p.edge >= 0.03 ? "warm" : p.edge >= 0 ? "soft" : "neg";
        const open = !!this.state.openPicks[p.id];
        const book = (D.BOOKS[p.book] || {});
        const bookLbl = book.short || book.name || p.book;
        const pn = p.pitcher.note, bn = p.batter.note;
        const why = open ? `
          <div style="padding-top:.5rem;">
            <p style="font-size:.82rem;color:var(--text-2);margin:0 0 .55rem;">${imp != null ? `Model ${conf}% · Market implies ${Math.round(imp * 100)}%` : "Supporting factors"}</p>
            <ul style="margin:0;padding-left:1.05rem;display:flex;flex-direction:column;gap:.4rem;">
              ${(p.bullets || []).map((b) => `<li style="font-size:.86rem;color:var(--text-2);">${esc(b)}</li>`).join("")}
            </ul>
            <p style="font-size:.72rem;color:var(--faint);margin:.7rem 0 0;">Confirm the live line at the book before betting. Illustrative only.</p>
          </div>` : "";
        return `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.15rem 1.2rem;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);display:flex;flex-direction:column;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem;">
            <div style="display:flex;flex-direction:column;">
              <span style="font-weight:800;font-size:1rem;">${esc(p.game.away)} <span style="color:var(--vs);font-weight:500;">@</span> ${esc(p.game.home)}</span>
              <span style="font-size:.78rem;color:var(--muted);margin-top:.12rem;">${esc(p.game.first_pitch)} · ${esc(p.game.venue)}</span>
            </div>
            <span style="font-size:.7rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--blue);background:var(--blue-bg);padding:.26rem .55rem;border-radius:6px;white-space:nowrap;">${esc((D.MARKETS[p.market] || {}).label || p.market)}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.6rem;margin:.95rem 0;padding:.75rem;background:var(--surface-2);border-radius:9px;">
            <div style="display:flex;flex-direction:column;min-width:0;">
              <span style="font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);">Pitcher</span>
              <span style="font-weight:700;font-size:.9rem;margin-top:.1rem;">${esc(p.pitcher.name)} <span style="font-size:.7rem;color:var(--muted);">${esc(p.pitcher.hand)}</span></span>
              ${pn ? `<span style="font-size:.74rem;color:var(--muted);margin-top:.1rem;">${esc(pn)}</span>` : ""}
            </div>
            <span style="font-size:.72rem;font-weight:700;color:var(--vs);">vs</span>
            <div style="display:flex;flex-direction:column;min-width:0;">
              <span style="font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);">Batter</span>
              <span style="font-weight:700;font-size:.9rem;margin-top:.1rem;">${esc(p.batter.name)} <span style="font-size:.7rem;color:var(--muted);">${esc(p.batter.hand)}</span></span>
              ${bn ? `<span style="font-size:.74rem;color:var(--muted);margin-top:.1rem;">${esc(bn)}</span>` : ""}
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;">
            <div style="display:flex;flex-direction:column;">
              <span style="font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);">Pick</span>
              <span style="font-size:1.3rem;font-weight:800;color:var(--text);letter-spacing:-.01em;">${esc(p.pick)}</span>
            </div>
            <div style="text-align:right;">
              <span style="display:block;font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:1.2rem;">${esc(this.am(p.price))}</span>
              <span style="font-size:.72rem;color:var(--muted);font-weight:600;">${esc(bookLbl)}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:1rem;margin:1rem 0 .35rem;">
            <div style="flex:1;">
              <div style="display:flex;justify-content:space-between;font-size:.76rem;color:var(--text-2);font-weight:600;margin-bottom:.3rem;"><span>Model confidence</span><span>${conf}%</span></div>
              <div style="height:7px;background:var(--track);border-radius:999px;overflow:hidden;"><div style="height:100%;width:${conf}%;background:linear-gradient(90deg,var(--accent),var(--good-strong));border-radius:999px;"></div></div>
            </div>
            <div style="${this.homeEdgeChip(tv)}">
              <span style="font-family:'IBM Plex Mono',monospace;font-weight:800;font-size:1rem;line-height:1;">${esc(signed(((p.edge || 0) * 100).toFixed(1), "%"))}</span>
              <span style="font-size:.62rem;text-transform:uppercase;letter-spacing:.05em;margin-top:.15rem;opacity:.8;">edge</span>
            </div>
          </div>
          <button data-act="togglePick" data-arg="${esc(p.id)}" style="display:flex;align-items:center;justify-content:space-between;width:100%;background:transparent;border:0;border-top:1px solid var(--border);margin-top:.7rem;padding:.7rem .1rem .1rem;cursor:pointer;font-family:inherit;font-size:.9rem;font-weight:600;color:var(--text-2);">
            <span>Why this pick</span><span style="color:var(--muted);">${open ? "▴" : "▾"}</span>
          </button>
          ${why}
        </div>`;
      }).join("");

      const picks = `
      <div id="home-picks" style="margin-bottom:1.6rem;">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.1rem;">
          <div>
            <h2 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0;">Today's quick picks</h2>
            <p style="margin:.35rem 0 0;color:var(--muted);font-size:.95rem;max-width:44rem;">${esc(picksSub)}</p>
          </div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;">${homeFilters}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:1.1rem;">${cards}</div>
      </div>`;

      // live board promo
      const promo = `
      <div style="display:grid;grid-template-columns:1.05fr .95fr;gap:2rem;align-items:center;background:var(--bc-bg);border:1px solid var(--bc-inner);border-radius:18px;padding:clamp(1.6rem,4vw,2.6rem);margin-bottom:1.6rem;color:#fff;">
        <div>
          <span style="display:inline-block;font-size:.74rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6ee7a0;background:rgba(74,222,128,.13);padding:.3rem .6rem;border-radius:999px;margin-bottom:.9rem;">The live board</span>
          <h2 style="color:#fff;font-size:clamp(1.5rem,3vw,2.1rem);font-weight:800;letter-spacing:-.02em;margin:0;">Watch the game with the model open.</h2>
          <p style="color:#b7c6da;font-size:1.02rem;line-height:1.6;margin:.9rem 0 1.5rem;max-width:34rem;">Real-time reads on every live at-bat — model probabilities, the pitch-by-pitch feed, and the broadcast situation at a glance.</p>
          <button data-act="goLive" style="display:inline-flex;align-items:center;justify-content:center;gap:.4rem;font-weight:600;font-size:.92rem;padding:.62rem 1.05rem;border-radius:9px;border:1px solid transparent;background:var(--accent);color:#fff;cursor:pointer;font-family:inherit;">Open the live board →</button>
        </div>
        <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.9rem;">
          <li style="display:flex;flex-direction:column;gap:.2rem;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:9px;padding:.85rem 1rem;"><b style="color:#fff;font-size:.96rem;">Live at-bat panels</b><span style="color:#93a6bd;font-size:.86rem;line-height:1.5;">One panel per game — the count, bases, and the model's read on the next pitch.</span></li>
          <li style="display:flex;flex-direction:column;gap:.2rem;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:9px;padding:.85rem 1rem;"><b style="color:#fff;font-size:.96rem;">Pitch-by-pitch feed</b><span style="color:#93a6bd;font-size:.86rem;line-height:1.5;">Type, velo and result next to predicted speed and strike / ball / in-play odds.</span></li>
          <li style="display:flex;flex-direction:column;gap:.2rem;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:9px;padding:.85rem 1rem;"><b style="color:#fff;font-size:.96rem;">Broadcast situation</b><span style="color:#93a6bd;font-size:.86rem;line-height:1.5;">Bases, balls, strikes, outs, score and the model call in a single glance.</span></li>
        </ul>
      </div>`;

      // track record
      const tileMeta = (tone) => ({
        cardStyle: `background:var(--surface);border:1px solid var(--border);border-top:3px solid ${tone === "pos" ? "var(--accent)" : tone === "neg" ? "var(--bad)" : "var(--border)"};border-radius:14px;padding:1.1rem 1.15rem;display:flex;flex-direction:column;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);`,
        bigStyle: `font-family:'IBM Plex Mono',monospace;font-weight:800;font-size:1.55rem;color:${tone === "pos" ? "var(--good-strong)" : tone === "neg" ? "var(--bad)" : "var(--text)"};`,
      });
      const recTiles = [
        { big: `${o.wins}–${o.losses}${o.pushes ? "–" + o.pushes : ""}`, lbl: "Overall record", sub: `${o.picks} picks graded`, tone: "" },
        { big: winPct + "%", lbl: "Win rate", sub: "Wins vs losses", tone: "" },
        { big: units(o.units), lbl: "Net units", sub: "Flat-stake basis", tone: o.units >= 0 ? "pos" : "neg" },
        { big: signed(o.roi, "%"), lbl: "ROI", sub: "Return on stake", tone: o.roi >= 0 ? "pos" : "neg" },
        { big: units(l.units), lbl: "Last 30 days", sub: `${l.wins}–${l.losses}, ${signed(l.roi, "%")} ROI`, tone: l.units >= 0 ? "pos" : "neg" },
      ].map((t) => {
        const meta = tileMeta(t.tone);
        return `<div style="${meta.cardStyle}"><span style="${meta.bigStyle}">${esc(t.big)}</span><span style="font-size:.86rem;font-weight:600;color:var(--text-2);margin-top:.25rem;">${esc(t.lbl)}</span><span style="font-size:.76rem;color:var(--muted);margin-top:.1rem;">${esc(t.sub)}</span></div>`;
      }).join("");

      const byMarket = (D.RECORD.byMarket || []).map((m) => {
        const wp = m.wins + m.losses > 0 ? (m.wins / (m.wins + m.losses) * 100) : 0;
        const unitsStyle = `text-align:right;font-family:'IBM Plex Mono',monospace;color:${m.units >= 0 ? "var(--good-strong)" : "var(--bad)"};`;
        const roiStyle = `text-align:right;font-family:'IBM Plex Mono',monospace;color:${m.roi >= 0 ? "var(--good-strong)" : "var(--bad)"};`;
        return `<div style="display:grid;grid-template-columns:2fr 1fr .8fr 1fr 1fr;gap:.5rem;padding:.6rem .85rem;border-bottom:1px solid var(--row-border);font-size:.86rem;align-items:center;">
          <span>${esc(m.label)}</span>
          <span style="text-align:right;font-family:'IBM Plex Mono',monospace;">${esc(m.wins)}–${esc(m.losses)}${m.pushes ? "–" + esc(m.pushes) : ""}</span>
          <span style="text-align:right;font-family:'IBM Plex Mono',monospace;color:var(--text-2);">${wp.toFixed(0)}%</span>
          <span style="${unitsStyle}">${esc(units(m.units))}</span>
          <span style="${roiStyle}">${esc(signed(m.roi, "%"))}</span>
        </div>`;
      }).join("");

      const recentSettled = (D.RECORD.recent || []).map((r) => {
        const tone = r.result === "win" ? ["var(--good-strong)", "var(--good-bg)"] : r.result === "loss" ? ["var(--bad)", "var(--bad-bg)"] : ["var(--amber)", "var(--amber-bg)"];
        const rs = `font-size:.66rem;font-weight:800;padding:.2rem .5rem;border-radius:6px;letter-spacing:.03em;color:${tone[0]};background:${tone[1]};`;
        return `<div style="display:grid;grid-template-columns:.6fr 2.2fr .8fr .8fr;gap:.5rem;padding:.6rem .85rem;border-bottom:1px solid var(--row-border);font-size:.84rem;align-items:center;">
          <span style="font-family:'IBM Plex Mono',monospace;color:var(--muted);">${esc(r.date.slice(5))}</span>
          <span>${esc(r.pick)}<span style="display:block;font-size:.74rem;color:var(--muted);margin-top:.05rem;">${esc(r.matchup)}</span></span>
          <span style="text-align:right;font-family:'IBM Plex Mono',monospace;color:var(--muted);">${esc(this.am(r.price))}</span>
          <span style="text-align:right;"><span style="${rs}">${esc(r.result.toUpperCase())}</span></span>
        </div>`;
      }).join("");

      const record = `
      <div style="margin-bottom:1.6rem;">
        <div style="margin-bottom:1rem;">
          <h2 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0;">Track record</h2>
          <p style="margin:.35rem 0 0;color:var(--muted);font-size:.95rem;">Every graded pick, kept in the open. Updated ${esc(D.RECORD.updated)}.</p>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.9rem;margin-bottom:1.4rem;">${recTiles}</div>
        <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:1.4rem;">
          <div>
            <h3 style="font-size:1.05rem;font-weight:700;margin:0 0 .7rem;">By market</h3>
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);">
              <div style="display:grid;grid-template-columns:2fr 1fr .8fr 1fr 1fr;gap:.5rem;padding:.6rem .85rem;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:.66rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;">
                <span>Market</span><span style="text-align:right;">W–L</span><span style="text-align:right;">Win%</span><span style="text-align:right;">Units</span><span style="text-align:right;">ROI</span>
              </div>${byMarket}
            </div>
          </div>
          <div>
            <h3 style="font-size:1.05rem;font-weight:700;margin:0 0 .7rem;">Recently settled</h3>
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);">
              <div style="display:grid;grid-template-columns:.6fr 2.2fr .8fr .8fr;gap:.5rem;padding:.6rem .85rem;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:.66rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;">
                <span>Date</span><span>Pick</span><span style="text-align:right;">Odds</span><span style="text-align:right;">Result</span>
              </div>${recentSettled}
            </div>
          </div>
        </div>
      </div>`;

      // how it works
      const steps = [
        ["1", "Ingest", "Historical Statcast plus a live MLB feed give us pitch-by-pitch context for every matchup."],
        ["2", "Model", "Per-market models project the next pitch and at-bat, then compare to the live line to find an edge."],
        ["3", "Publish", "Only +EV picks make the board — each with the supporting reasons and a one-tap link to the book."],
        ["4", "Grade", "Every pick is settled win / loss / push and added to the public record. No deleting cold streaks."],
      ].map(([n, title, body]) => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.3rem;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:var(--bc-bg);color:#fff;font-weight:800;margin-bottom:.8rem;">${n}</span>
          <h3 style="font-size:1.05rem;font-weight:700;margin:0 0 .35rem;">${esc(title)}</h3>
          <p style="margin:0;color:var(--text-2);font-size:.92rem;">${esc(body)}</p>
        </div>`).join("");
      const how = `
      <div>
        <h2 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0 0 1rem;">How it works</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.1rem;">${steps}</div>
      </div>`;

      return hero + picks + promo + record + how;
    }

    // ══ LIVE MARKETS ═════════════════════════════════════════════════════
    liveHtml() {
      const thr = this.state.edgeThreshold;
      const sel = this.selLiveSourceSet();
      // per-source edge adjustment: books carry vig (worse), markets near-fair
      const SRC_ADJ = { draftkings: -0.012, fanduel: -0.008, kalshi: 0.004, polymarket: 0.008 };
      const adjBest = (base) => { if (base == null) return null; let best = null; sel.forEach((k) => { const e = base + (SRC_ADJ[k] || 0); if (best == null || e > best) best = e; }); return best; };
      const bestOfSources = (sources) => { let best = null; (sources || []).forEach((s) => { if (sel.has(s.source) && (best == null || s.edge > best)) best = s.edge; }); return best; };
      const hot = (best) => (best != null && best >= thr);
      const chip = (best) => hot(best)
        ? `font-family:'IBM Plex Mono',monospace;justify-self:end;padding:.08rem .4rem;border-radius:6px;background:var(--good-bg);color:var(--good-strong);font-weight:700;`
        : `font-family:'IBM Plex Mono',monospace;justify-self:end;color:var(--text-2);`;
      const dot = (on, color) => `width:11px;height:11px;border-radius:50%;background:${on ? color : "var(--track)"};border:1px solid ${on ? color : "var(--border-2)"};`;
      const bs = (on, pos) => `position:absolute;${pos}width:14px;height:14px;border-radius:3px;background:${on ? "var(--good-strong)" : "var(--track)"};border:1.5px solid ${on ? "var(--good-strong)" : "var(--border-2)"};`;

      const games = NP.games.filter((g) => this.liveGameOn(g.gamePk));
      const panels = games.map((g) => {
        const cnt = (g.count || "0-0").split("-").map(Number);
        const balls = cnt[0] || 0, strikes = cnt[1] || 0;
        const ballDots = [0, 1, 2].map((i) => `<span style="${dot(i < balls, "var(--good-strong)")}"></span>`).join("");
        const strikeDots = [0, 1].map((i) => `<span style="${dot(i < strikes, "var(--amber)")}"></span>`).join("");
        const outDots = [0, 1].map((i) => `<span style="${dot(i < g.outs, "var(--bad)")}"></span>`).join("");

        const typesSeen = [];
        const zoneDots = g.pitches.map((pt) => {
          const pos = this.zonePos(pt.zone);
          const col = this.pitchColor(pt.type);
          if (!typesSeen.includes(pt.type)) typesSeen.push(pt.type);
          return `<span style="position:absolute;left:${pos[0]}%;top:${pos[1]}%;transform:translate(-50%,-50%);width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:#fff;background:${col};box-shadow:0 1px 3px rgba(0,0,0,.28);">${esc(pt.n)}</span>`;
        }).join("");
        const typeLegend = typesSeen.map((t) => `<span style="display:inline-flex;align-items:center;gap:.3rem;font-size:.72rem;color:var(--text-2);"><span style="width:9px;height:9px;border-radius:50%;background:${this.pitchColor(t)};flex:none;"></span>${esc(t)}</span>`).join("");

        const pitchEmpty = g.pitches.length === 0;
        const pitchRows = g.pitches.map((pt) => {
          const rm = this.resultMeta(pt.desc);
          const speedText = pt.speed != null ? pt.speed.toFixed(1) : "—";
          const veloStyle = pt.speed != null
            ? `font-family:'IBM Plex Mono',monospace;font-weight:600;color:${this.veloColor(pt.speed)};`
            : `font-family:'IBM Plex Mono',monospace;font-weight:600;color:var(--faint);`;
          const predText = pt.predSpeed != null ? pt.predSpeed.toFixed(1) : "—";
          const pS = pt.pStrike != null ? Math.round(pt.pStrike * 100) + "%" : "—";
          const pB = pt.pBall != null ? Math.round(pt.pBall * 100) + "%" : "—";
          const pIP = pt.pInPlay != null ? Math.round(pt.pInPlay * 100) + "%" : "—";
          return `
          <div style="display:grid;grid-template-columns:28px 44px 48px minmax(70px,1fr) 44px 48px 40px 40px 40px;gap:.35rem;align-items:center;padding:.42rem .25rem;border-bottom:1px solid var(--row-border);font-size:.8rem;">
            <span style="font-family:'IBM Plex Mono',monospace;color:var(--faint);">${esc(pt.n)}</span>
            <span style="font-weight:700;color:${this.pitchColor(pt.type)};">${esc(pt.type)}</span>
            <span style="${veloStyle}">${esc(speedText)}</span>
            <span style="color:${rm[1]};font-weight:600;">${esc(rm[0])}</span>
            <span style="font-family:'IBM Plex Mono',monospace;color:var(--muted);text-align:right;">${esc(pt.balls)}-${esc(pt.strikes)}</span>
            <span style="${chip(adjBest(pt.predSpeedEdge))}">${esc(predText)}</span>
            <span style="${chip(adjBest(pt.pStrikeEdge))}">${esc(pS)}</span>
            <span style="${chip(adjBest(pt.pBallEdge))}">${esc(pB)}</span>
            <span style="${chip(adjBest(pt.pInPlayEdge))}">${esc(pIP)}</span>
          </div>`;
        }).join("");

        const abr = g.m.ab_result, abp = g.m.ab_pitches_ou;
        const order = ["out", "hit", "strikeout", "walk"];
        const abOutcomes = order.map((name) => {
          const oc = (abr.outcomes || []).find((x) => x.name === name) || { modelProb: 0, sources: [] };
          const pctv = Math.round(oc.modelProb * 100);
          const isRec = name === abr.recommendation;
          const best = bestOfSources(oc.sources);
          const nameStyle = `font-size:.84rem;font-weight:${isRec ? 700 : 500};color:${isRec ? "var(--good-strong)" : "var(--text-2)"};`;
          const barW = `height:100%;width:${pctv}%;background:${isRec ? "var(--accent)" : "var(--vs)"};border-radius:999px;`;
          const pctStyle = hot(best)
            ? `font-family:'IBM Plex Mono',monospace;font-size:.82rem;font-weight:700;justify-self:end;padding:.08rem .4rem;border-radius:6px;background:var(--good-bg);color:var(--good-strong);`
            : `font-family:'IBM Plex Mono',monospace;font-size:.82rem;font-weight:600;color:var(--text-2);min-width:34px;text-align:right;`;
          return `
          <div style="display:grid;grid-template-columns:1.1fr 2fr auto;gap:.6rem;align-items:center;padding:.26rem 0;">
            <div style="${nameStyle}">${esc(NP.OUTCOME_LABEL[name] || name)}</div>
            <div style="height:7px;background:var(--track);border-radius:999px;overflow:hidden;"><div style="${barW}"></div></div>
            <span style="${pctStyle}">${pctv}%</span>
          </div>`;
        }).join("");

        const abProjBest = bestOfSources(abp.sources);
        const abProj = abp.line != null
          ? `${abp.recommendation === "over" ? "Over" : "Under"} ${abp.line} · proj ${abp.predictedValue != null ? abp.predictedValue : "—"}`
          : "—";
        const abProjStyle = hot(abProjBest)
          ? `font-weight:700;padding:.06rem .4rem;border-radius:6px;background:var(--good-bg);color:var(--good-strong);`
          : `font-weight:700;color:var(--text-2);`;

        const cardStyle = `background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.15rem 1.25rem;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);opacity:${g.stale ? 0.72 : 1};`;
        const pausedTag = g.stale ? `<span style="font-size:.6rem;font-weight:700;color:var(--amber);background:var(--amber-bg);padding:.14rem .44rem;border-radius:5px;">PAUSED</span>` : "";
        const typesBlock = typeLegend ? `
          <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin:.75rem 0 .4rem;">Pitch types</div>
          <div style="display:flex;flex-wrap:wrap;gap:.3rem .6rem;">${typeLegend}</div>` : "";

        return `
        <div style="${cardStyle}">
          <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.9rem;padding-bottom:.8rem;border-bottom:1px solid var(--border);">
            <span style="font-weight:800;font-size:1.1rem;">${esc(g.label)}</span>${pausedTag}
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1.2rem;">

            <!-- LEFT: game state -->
            <div style="display:flex;flex-direction:column;gap:1rem;">
              <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;background:var(--surface-2);border:1px solid var(--border);border-radius:11px;padding:.75rem .95rem;">
                <div style="display:flex;flex-direction:column;gap:.15rem;">
                  <div style="display:flex;align-items:baseline;gap:.4rem;font-family:'IBM Plex Mono',monospace;">
                    <span style="font-size:1.7rem;font-weight:700;line-height:1;">${esc(g.score.away)}</span>
                    <span style="font-size:1.2rem;color:var(--vs);font-weight:600;">–</span>
                    <span style="font-size:1.7rem;font-weight:700;line-height:1;">${esc(g.score.home)}</span>
                  </div>
                  <span style="font-size:.68rem;color:var(--muted);font-weight:600;letter-spacing:.03em;">${esc(g.away)} vs ${esc(g.home)}</span>
                </div>
                <div style="display:flex;flex-direction:column;align-items:center;gap:.12rem;">
                  <span style="font-size:1.05rem;line-height:1;color:var(--good-strong);">${esc(g.half)}</span>
                  <span style="font-family:'IBM Plex Mono',monospace;font-size:.78rem;font-weight:600;color:var(--text-2);">Inn ${esc(g.inning)}</span>
                </div>
                <div style="position:relative;width:52px;height:52px;flex:none;">
                  <div style="${bs(g.runners.second, "left:50%;top:2px;transform:translateX(-50%) rotate(45deg);")}"></div>
                  <div style="${bs(g.runners.third, "left:2px;top:50%;transform:translateY(-50%) rotate(45deg);")}"></div>
                  <div style="${bs(g.runners.first, "right:2px;top:50%;transform:translateY(-50%) rotate(45deg);")}"></div>
                  <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%) rotate(45deg);width:10px;height:10px;border-radius:2px;background:var(--vs);"></div>
                </div>
                <div style="display:flex;flex-direction:column;gap:.32rem;margin-left:auto;">
                  <div style="display:flex;align-items:center;gap:.5rem;"><span style="font-size:.64rem;font-weight:700;color:var(--faint);width:9px;">B</span><div style="display:flex;gap:.28rem;">${ballDots}</div></div>
                  <div style="display:flex;align-items:center;gap:.5rem;"><span style="font-size:.64rem;font-weight:700;color:var(--faint);width:9px;">S</span><div style="display:flex;gap:.28rem;">${strikeDots}</div></div>
                  <div style="display:flex;align-items:center;gap:.5rem;"><span style="font-size:.64rem;font-weight:700;color:var(--faint);width:9px;">O</span><div style="display:flex;gap:.28rem;">${outDots}</div></div>
                </div>
              </div>

              <div style="display:flex;flex-direction:column;gap:.5rem;font-size:.86rem;">
                <div style="display:flex;justify-content:space-between;gap:.6rem;"><span style="color:var(--muted);">Pitcher</span><span style="font-weight:700;">${esc(this.player(g.pitcher))}</span></div>
                <div style="display:flex;justify-content:space-between;gap:.6rem;"><span style="color:var(--muted);">At bat</span><span style="font-weight:700;">${esc(this.player(g.batter))}</span></div>
              </div>

              <div style="display:flex;gap:1.1rem;align-items:flex-start;flex-wrap:wrap;">
                <div style="flex:none;">
                  <div style="font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin-bottom:.5rem;">Pitch locations</div>
                  <div style="position:relative;width:150px;height:158px;">
                    <div style="position:absolute;left:25%;top:23%;width:50%;height:54%;border:1.5px solid var(--border-2);border-radius:3px;background:var(--surface-2);"></div>
                    <div style="position:absolute;left:41.67%;top:23%;width:1px;height:54%;background:var(--border);"></div>
                    <div style="position:absolute;left:58.33%;top:23%;width:1px;height:54%;background:var(--border);"></div>
                    <div style="position:absolute;left:25%;top:41%;width:50%;height:1px;background:var(--border);"></div>
                    <div style="position:absolute;left:25%;top:59%;width:50%;height:1px;background:var(--border);"></div>
                    ${pitchEmpty ? `<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:.72rem;color:var(--faint);font-style:italic;">no pitches yet</div>` : zoneDots}
                  </div>
                </div>
                <div style="flex:1;min-width:150px;padding-top:1.25rem;">
                  <div style="font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin-bottom:.4rem;">Ballpark</div>
                  <div style="font-weight:700;font-size:.92rem;">${esc(g.venue)}</div>
                  <div style="font-size:.82rem;color:var(--text-2);margin-top:.3rem;line-height:1.5;">${esc(g.weather)}</div>
                  ${typesBlock}
                </div>
              </div>
            </div>

            <!-- RIGHT: pitch feed + model read -->
            <div style="display:flex;flex-direction:column;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:.6rem;flex-wrap:wrap;margin-bottom:.6rem;">
                <span style="font-weight:800;font-size:1rem;">Pitch feed</span>
                <span style="font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);">This at-bat · model read</span>
              </div>
              <div style="overflow-x:auto;"><div style="min-width:520px;">
                <div style="display:grid;grid-template-columns:28px 44px 48px minmax(70px,1fr) 44px 48px 40px 40px 40px;gap:.35rem;font-size:.58rem;text-transform:uppercase;letter-spacing:.03em;color:var(--faint);font-weight:700;padding:0 .25rem .4rem;border-bottom:1px solid var(--border);">
                  <span>#</span><span>Type</span><span>Velo</span><span>Result</span><span style="text-align:right;">Count</span><span style="text-align:right;">Pred</span><span style="text-align:right;">Str</span><span style="text-align:right;">Ball</span><span style="text-align:right;">IP</span>
                </div>
                ${pitchEmpty ? `<div style="padding:1rem .25rem;color:var(--faint);font-style:italic;font-size:.84rem;">Fresh at-bat — no pitches thrown yet.</div>` : pitchRows}
              </div></div>
              <div style="display:flex;gap:1.4rem;flex-wrap:wrap;margin-top:.85rem;padding-top:.7rem;border-top:1px solid var(--track);font-size:.8rem;color:var(--text-2);">
                <div><span style="color:var(--faint);">Pitches (PA)</span> <b style="font-weight:700;">${esc(g.pitchCountPa)}</b></div>
                <div><span style="color:var(--faint);">AB pitches proj</span> <b style="${abProjStyle}">${esc(abProj)}</b></div>
              </div>
              <div style="margin-top:.9rem;padding-top:.75rem;border-top:1px solid var(--border);">
                <div style="font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin-bottom:.6rem;">At-bat result · model probability</div>
                ${abOutcomes}
              </div>
            </div>

          </div>
        </div>`;
      }).join("");

      // filters bar
      const chipStyle = (on, accent) => `border:1px solid ${on ? (accent || "var(--pill-active-bg)") : "var(--border-2)"};background:${on ? (accent || "var(--pill-active-bg)") : "var(--surface)"};color:${on ? "#fff" : "var(--text-2)"};font-family:inherit;font-weight:600;font-size:.76rem;padding:.32rem .7rem;border-radius:999px;cursor:pointer;transition:all .14s;`;
      const allOn = NP.games.every((g) => this.liveGameOn(g.gamePk));
      const gameChips = NP.games.map((g) => `<button data-act="liveGame" data-arg="${g.gamePk}" style="${chipStyle(this.liveGameOn(g.gamePk))}">${esc(g.label)}</button>`).join("");
      const sourceChips = Object.keys(NP.SOURCES).map((k) => {
        const s = NP.SOURCES[k]; const on = !!this.state.liveSources[k];
        const accent = s.type === "book" ? "var(--blue)" : "var(--purple)";
        return `<button data-act="liveSource" data-arg="${k}" style="${chipStyle(on, on ? accent : null)}">${esc(s.short)}</button>`;
      }).join("");
      const thresholdText = (thr * 100).toFixed(1) + "%";

      const filters = `
      <div style="display:flex;flex-direction:column;gap:.55rem;margin-bottom:1.1rem;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.75rem .85rem;box-shadow:0 1px 2px rgba(15,27,45,.04);">
        <div style="display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;">
          <span style="font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);width:54px;">Games</span>
          <button data-act="liveAllGames" style="${chipStyle(allOn)}">All</button>${gameChips}
        </div>
        <div style="display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;">
          <span style="font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);width:54px;">Sources</span>${sourceChips}
        </div>
        <div style="display:flex;align-items:center;gap:.45rem;font-size:.72rem;color:var(--muted);flex-wrap:wrap;">
          <span style="width:13px;height:13px;border-radius:4px;background:var(--good-bg);border:1px solid var(--good-strong);display:inline-block;flex:none;"></span>
          Model reads with an edge ≥ ${esc(thresholdText)} against your selected sources are highlighted.
        </div>
      </div>`;

      const empty = panels.length === 0
        ? `<div style="padding:3rem 0;text-align:center;color:var(--faint);font-size:.95rem;">No games selected — pick a game above.</div>` : "";

      return `
      <div style="margin-bottom:1.1rem;">
        <h1 style="font-size:clamp(1.5rem,3vw,2.05rem);font-weight:800;letter-spacing:-.02em;margin:0;">Live markets</h1>
        <p style="margin:.3rem 0 0;color:var(--muted);font-size:.95rem;">One panel per live at-bat — game state on the left, the model's pitch-by-pitch read on the right.</p>
      </div>
      ${filters}
      ${empty}
      <div style="display:flex;flex-direction:column;gap:1rem;">${panels}</div>`;
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
      const abCall = NP.OUTCOME_LABEL[abr.recommendation] || abr.recommendation || "—";
      const abConf = abr.conf != null ? abr.conf : abr.modelProb;

      const cnt = (sel.count || "0-0").split("-").map(Number);
      const balls = cnt[0] || 0, strikes = cnt[1] || 0;
      const dots = (n, filled, color) => Array.from({ length: n }, (_, i) => `<span style="width:11px;height:11px;border-radius:50%;background:${i < filled ? color : "#22344d"};"></span>`).join("");
      const basePos = { two: "left:50%;top:2px;transform:translateX(-50%) rotate(45deg);", three: "left:2px;top:50%;transform:translateY(-50%) rotate(45deg);", one: "right:2px;top:50%;transform:translateY(-50%) rotate(45deg);" };
      const baseStyle = (onBase, pos) => `position:absolute;${pos}width:22px;height:22px;border-radius:4px;background:${onBase ? "#4ade80" : "#16263d"};border:2px solid ${onBase ? "#4ade80" : "#3a4c66"};`;

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

    render() {
      this.root.setAttribute("data-theme", this.dk() ? "dark" : "light");
      const view = this.state.view;
      let main;
      if (view === "home") main = this.homeHtml();
      else if (view === "live") main = this.liveHtml();
      else main = this.dataHtml();
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
          if (!games.some((g) => g.gamePk === this.state.feedGame)) this.state.feedGame = games[0].gamePk;
          this.render();
        }
      } catch (_e) { /* backend down → keep the sample board */ }
    }
    async hydrate() {
      try {
        const next = await hydrateHome();
        if (next) { PD = next; if (this.state.view === "home") this.render(); }
      } catch (_e) { /* keep sample Home data */ }
    }
    start() {
      this.render();
      this.startSim();
      this.hydrate();
      this.poll();
      this._pollIv = setInterval(() => this.poll(), POLL_MS);
    }
  }

  function boot() {
    const root = document.getElementById("np-root");
    if (!window.NEXTPITCH) {
      root.innerHTML = `<div style="padding:4.5rem 0;text-align:center;color:#7a879c;font-size:.95rem;">Loading NextPitch…</div>`;
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
