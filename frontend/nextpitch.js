// ════════════════════════════════════════════════════════════════════════
// nextpitch.js — NextPitch single-page app.
//
// One page, three tabs: Home / Live Markets / Data Feed. Vanilla port of the
// design reference's `class Component` (design_handoff_live_markets) — same
// client state and data shaping (homeVals / liveVals / dataVals), rendered to
// the DOM without a framework. Markup mirrors the design's inline-styled
// template so it's pixel-faithful across the light/dark token palette.
//
// Data layer (live-only):
//   • Home shows today's schedule from GET /games, refreshed alongside polls.
//   • Live Markets + Data Feed read window.NEXTPITCH.games, filled exclusively
//     by NEXTPITCH.loadLive (/live + /edge). The board is empty outside game
//     windows. No odds are ingested yet, so price/edge columns render "—";
//     picks and the graded record return to the UI when odds ship.
// ════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  const API_BASE = window.PITCH_EDGE_API || "http://localhost:8080";
  const POLL_MS = 8000;   // backend polls MLB every ~8s (POLL_INTERVAL_SECONDS)

  const NP = window.NEXTPITCH;

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function initialDark() {
    const saved = localStorage.getItem("np-theme");
    if (saved === "dark") return true;
    if (saved === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
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

  class Board {
    constructor(root) {
      this.root = root;
      this.state = {
        view: "home", feedGame: null,
        liveGames: {}, liveSources: { draftkings: true, fanduel: true, kalshi: true, polymarket: true },
        edgeThreshold: 0.03,
        dark: initialDark(), t: 0,
      };
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
        case "theme": {
          const dark = !this.state.dark;
          localStorage.setItem("np-theme", dark ? "dark" : "light");
          return this.setState({ dark });
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
      const liveText = liveCount
        ? `${liveCount} game${liveCount === 1 ? "" : "s"} live · auto-refreshing`
        : "No games live right now";
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
          <p style="margin:0;font-size:.74rem;color:#8a9bb2;max-width:46rem;flex:1;min-width:240px;">Live MLB data with model-driven projections, for information and entertainment only — no odds or betting picks are shown, and nothing here is betting advice. 21+ where betting is legal. Gambling problem? Call 1-800-GAMBLER.</p>
        </div>
      </footer>`;
    }

    // ══ HOME ═════════════════════════════════════════════════════════════
    homeHtml() {
      const slate = SLATE;
      const liveNow = NP.games.filter((g) => !g.stale).length;
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
      const glance = [
        { big: leftToday == null ? "—" : String(leftToday), lbl: "games left today" },
        { big: firstPitch || "—", lbl: "first pitch" },
        { big: String(liveNow), lbl: "live right now" },
      ].map((t) => `
            <div style="display:flex;flex-direction:column;"><span style="font-family:'IBM Plex Mono',monospace;font-size:1.7rem;font-weight:800;">${esc(t.big)}</span><span style="font-size:.76rem;color:#9fb2c9;margin-top:.15rem;">${esc(t.lbl)}</span></div>`).join("");
      const hero = `
      <div style="display:grid;grid-template-columns:1.25fr .9fr;gap:2rem;align-items:center;background:linear-gradient(180deg,var(--surface),var(--bg));border:1px solid var(--border);border-radius:18px;padding:clamp(1.6rem,4vw,2.6rem);margin-bottom:1.4rem;">
        <div>
          <span style="display:inline-block;font-size:.74rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--good-strong);background:var(--good-bg);padding:.3rem .6rem;border-radius:999px;margin-bottom:1rem;">MLB · At-Bat Markets</span>
          <h1 style="font-size:clamp(1.9rem,4vw,3rem);font-weight:800;letter-spacing:-.02em;margin:0;line-height:1.08;">The next pitch, called before it's thrown.</h1>
          <p style="font-size:1.08rem;color:var(--text-2);max-width:34rem;margin:1rem 0 1.4rem;">Live pitch-by-pitch data with model-predicted probabilities for every at-bat. The board wakes at first pitch and follows every game — odds comparison and graded picks are on the way.</p>
          <div style="display:flex;gap:.7rem;flex-wrap:wrap;">
            <button data-act="goLive" style="display:inline-flex;align-items:center;justify-content:center;gap:.4rem;font-weight:600;font-size:.92rem;padding:.62rem 1.05rem;border-radius:9px;border:1px solid transparent;background:var(--accent);color:#fff;cursor:pointer;font-family:inherit;">Open the live board →</button>
          </div>
          <p style="margin-top:1rem;font-size:.8rem;color:var(--muted);letter-spacing:.02em;">21+ · For entertainment · 1-800-GAMBLER</p>
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
        slateCards = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:.8rem;">${cards}</div>`;
      }
      const slateBlock = `
      <div style="margin-bottom:1.6rem;">
        <div style="margin-bottom:1rem;">
          <h2 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0;">Today's games</h2>
          <p style="margin:.35rem 0 0;color:var(--muted);font-size:.95rem;">Live now first, then up next, then finals — live model reads open with each game window.</p>
        </div>
        ${slateCards}
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

      // how it works
      const steps = [
        ["1", "Ingest", "Historical Statcast plus a live MLB feed give us pitch-by-pitch context for every matchup."],
        ["2", "Model", "Per-market models project the next pitch and at-bat in real time, updating with every pitch."],
        ["3", "Watch", "Every live at-bat gets a model read — probabilities and projections stream to the live board."],
        ["4", "Next up", "Live odds comparison, +EV picks, and a public graded record are on the way."],
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

      return hero + slateBlock + promo + how;
    }

    // ══ LIVE MARKETS ═════════════════════════════════════════════════════
    liveHtml() {
      if (!NP.games.length) {
        return `
      <div style="margin-bottom:1.1rem;">
        <h1 style="font-size:clamp(1.5rem,3vw,2.05rem);font-weight:800;letter-spacing:-.02em;margin:0;">Live markets</h1>
        <p style="margin:.3rem 0 0;color:var(--muted);font-size:.95rem;">One panel per live at-bat — game state on the left, the model's pitch-by-pitch read on the right.</p>
      </div>
      <div style="padding:3.5rem 1rem;text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:14px;">
        <div style="font-size:1.05rem;font-weight:700;margin-bottom:.35rem;">No live games right now</div>
        <div style="font-size:.9rem;color:var(--muted);">The board wakes up automatically at first pitch — <button data-act="goHome" style="border:0;background:transparent;color:var(--accent);font-family:inherit;font-weight:700;font-size:.9rem;cursor:pointer;padding:0;">see today's schedule</button>.</div>
      </div>`;
      }
      const thr = this.state.edgeThreshold;
      const sel = this.selLiveSourceSet();
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
          return `
          <div style="display:grid;grid-template-columns:28px 48px 52px minmax(90px,1fr) 52px;gap:.35rem;align-items:center;padding:.42rem .25rem;border-bottom:1px solid var(--row-border);font-size:.8rem;">
            <span style="font-family:'IBM Plex Mono',monospace;color:var(--faint);">${esc(pt.n)}</span>
            <span style="font-weight:700;color:${this.pitchColor(pt.type)};">${esc(pt.type)}</span>
            <span style="${veloStyle}">${esc(speedText)}</span>
            <span style="color:${rm[1]};font-weight:600;">${esc(rm[0])}</span>
            <span style="font-family:'IBM Plex Mono',monospace;color:var(--muted);text-align:right;">${esc(pt.balls)}-${esc(pt.strikes)}</span>
          </div>`;
        }).join("");

        // Next-pitch model read: the model predicts the UPCOMING pitch (result
        // distribution + speed projection) — rendered per game, not per past
        // pitch, because /live only carries the latest prediction per market.
        const pres = g.m.pitch_result || {};
        const spd = g.m.pitch_speed_ou || {};
        const presRows = ["strike_foul", "ball", "in_play"]
          .filter((name) => pres.probs && pres.probs[name] != null)
          .map((name) => {
            const pv = Math.round(pres.probs[name] * 100);
            const isRec = name === pres.recommendation;
            return `
          <div style="display:grid;grid-template-columns:1.1fr 2fr auto;gap:.6rem;align-items:center;padding:.26rem 0;">
            <div style="font-size:.84rem;font-weight:${isRec ? 700 : 500};color:${isRec ? "var(--good-strong)" : "var(--text-2)"};">${esc(NP.OUTCOME_LABEL[name] || name)}</div>
            <div style="height:7px;background:var(--track);border-radius:999px;overflow:hidden;"><div style="height:100%;width:${pv}%;background:${isRec ? "var(--accent)" : "var(--vs)"};border-radius:999px;"></div></div>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:.82rem;font-weight:600;color:var(--text-2);min-width:34px;text-align:right;">${pv}%</span>
          </div>`;
          }).join("");
        const spdLine = spd.predictedValue != null
          ? `<div style="display:flex;justify-content:space-between;gap:.6rem;font-size:.8rem;margin-top:.45rem;"><span style="color:var(--faint);">Speed projection</span><b style="font-family:'IBM Plex Mono',monospace;font-weight:700;">${esc(Number(spd.predictedValue).toFixed(1))} mph${spd.line != null && spd.recommendation ? ` · ${esc(NP.OUTCOME_LABEL[spd.recommendation] || spd.recommendation)} ${esc(spd.line)}` : ""}</b></div>`
          : "";
        const nextPitchBlock = (presRows || spdLine) ? `
              <div style="margin-top:.9rem;padding-top:.75rem;border-top:1px solid var(--border);">
                <div style="font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin-bottom:.6rem;">Next pitch · model read</div>
                ${presRows || `<div style="font-size:.8rem;color:var(--faint);font-style:italic;">Model read pending…</div>`}
                ${spdLine}
              </div>` : "";

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
                <span style="font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);">This at-bat</span>
              </div>
              <div style="overflow-x:auto;"><div style="min-width:300px;">
                <div style="display:grid;grid-template-columns:28px 48px 52px minmax(90px,1fr) 52px;gap:.35rem;font-size:.58rem;text-transform:uppercase;letter-spacing:.03em;color:var(--faint);font-weight:700;padding:0 .25rem .4rem;border-bottom:1px solid var(--border);">
                  <span>#</span><span>Type</span><span>Velo</span><span>Result</span><span style="text-align:right;">Count</span>
                </div>
                ${pitchEmpty ? `<div style="padding:1rem .25rem;color:var(--faint);font-style:italic;font-size:.84rem;">Fresh at-bat — no pitches thrown yet.</div>` : pitchRows}
              </div></div>
              <div style="display:flex;gap:1.4rem;flex-wrap:wrap;margin-top:.85rem;padding-top:.7rem;border-top:1px solid var(--track);font-size:.8rem;color:var(--text-2);">
                <div><span style="color:var(--faint);">Pitches (PA)</span> <b style="font-weight:700;">${esc(g.pitchCountPa)}</b></div>
                <div><span style="color:var(--faint);">AB pitches proj</span> <b style="${abProjStyle}">${esc(abProj)}</b></div>
              </div>
              ${nextPitchBlock}
              <div style="margin-top:.9rem;padding-top:.75rem;border-top:1px solid var(--border);">
                <div style="font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin-bottom:.6rem;">At-bat result · model probability</div>
                ${abOutcomes}
              </div>
            </div>

          </div>
        </div>`;
      }).join("");

      // filters bar
      const chipStyle = (on, accent) => `border:1px solid ${on ? (accent || "var(--pill-active-bg)") : "var(--border-2)"};background:${on ? (accent || "var(--pill-active-bg)") : "var(--surface)"};color:${on ? (accent ? "#fff" : "var(--pill-active-fg)") : "var(--text-2)"};font-family:inherit;font-weight:600;font-size:.76rem;padding:.32rem .7rem;border-radius:999px;cursor:pointer;transition:all .14s;`;
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

      // settled-picks proof points return with the graded record
      const recentBlock = NP.RECENT.length ? `
      <div style="font-size:.66rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:0 0 .6rem;">Recently settled at-bats</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 2px rgba(15,27,45,.04),0 6px 16px rgba(15,27,45,.05);padding:.4rem .6rem;overflow-x:auto;">
        <div style="min-width:560px;">
          <div style="display:grid;grid-template-columns:.6fr 1fr 1.2fr 1.6fr .5fr .7fr auto;gap:.5rem;font-size:.62rem;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);font-weight:700;padding:.5rem .4rem;border-bottom:1px solid var(--border);">
            <span>Date</span><span>Game</span><span>Batter</span><span>Pick</span><span>P</span><span>Price</span><span style="text-align:right;">Result</span>
          </div>
          ${recentRows}
        </div>
      </div>` : "";

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
            <div><span style="color:var(--faint);">Model</span> <b style="font-weight:700;">${esc(sel.modelVersion || "—")}</b></div>
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

      ${recentBlock}`;
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
    // /live can keep serving a finished game for up to ~30 min (its live_state
    // row just goes stale) — the schedule knows "Final" much sooner, so drop
    // any game the slate marks final from the live board and data feed.
    _withoutFinals(games) {
      const finals = new Set((SLATE || []).filter((g) => isFinalStatus(g.status)).map((g) => g.game_pk));
      return games.filter((g) => !finals.has(g.gamePk));
    }
    async poll() {
      try {
        await fetchSlate().catch(() => {}); // throttled to 60s; needed for the finals filter
        const games = await NP.loadLive(API_BASE);
        if (Array.isArray(games)) {
          // [] is a real answer (no live games) — empty the board.
          NP.games = this._withoutFinals(games);
          if (NP.games.length && !NP.games.some((g) => g.gamePk === this.state.feedGame)) {
            this.state.feedGame = NP.games[0].gamePk;
          }
          this.render();
        }
        // loadLive throws on network error → keep last-good board.
      } catch (_e) { console.warn("[nextpitch] live poll failed; keeping last data"); }
    }
    async hydrate() {
      try {
        const changed = await fetchSlate();
        if (changed) {
          NP.games = this._withoutFinals(NP.games); // a game may have just gone final
          this.render();
        }
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
      this._setStaleBanner(!!(h && h.data_fresh === false) && NP.games.length > 0, h);
    }
    _setStaleBanner(stale, h) {
      let el = document.getElementById("np-stale");
      if (!stale) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement("div");
        el.id = "np-stale";
        el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#b9541b;" +
          "color:#fff;text-align:center;font-size:.85rem;padding:.4rem;font-family:inherit;";
        document.body.appendChild(el);
      }
      const age = h && h.jobs && h.jobs["live-poll"] ? h.jobs["live-poll"].age_seconds : null;
      el.textContent = "⚠ Live data delayed" +
        (age != null ? ` (updated ~${Math.round(age / 60)}m ago)` : "") +
        " — showing last known prices.";
    }
    start() {
      this.render();
      this.hydrate();
      this.poll();
      this.checkHealth();
      this._scheduleNextPoll();
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) { clearTimeout(this._pollTo); this._pollTick(); }
      });
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
