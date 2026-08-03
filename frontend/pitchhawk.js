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

  class Board {
    constructor(root) {
      this.root = root;
      this.state = {
        view: "home", feedGame: null,
        focusGame: null, dfGame: "all", mkt: "all", openLog: null,
        liveGames: {}, liveSources: { draftkings: true, fanduel: true, kalshi: true, polymarket: true },
        edgeThreshold: 0.03,
        dark: initialDark(), t: 0,
        // Phase 4 aggregates. `loaded` stays false until the first fetch
        // settles, so the panels are absent rather than flashing empty.
        scout: { seed: null, ctx: null, profile: null, fatigue: null, matchup: null, loaded: false },
      };
      this._pollIv = null;
      // Client-side plate-appearance history (see trackAtBats): /live only
      // carries the current PA, so finished at-bats are archived here.
      this.paHist = {};
      this.paWatch = {};
      // Session-graded prediction log powering the Data Feed (see trackGradedLog).
      this.gradedLog = [];
      this._seenPitch = {};
      // Warehouse-backed scouting panels. Durable across reloads, unlike the
      // graded log above. `_scoutSigs` gates re-fetching per panel, so a new
      // batter does not re-request the pitcher profile or the game context.
      this._scoutSigs = {};
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
    // ── at-bat history (accumulated client-side) ─────────────────────────
    // The backend exposes only the CURRENT plate appearance, so the "Earlier
    // at-bats" strip is built by watching the live PA each poll and archiving a
    // graded one-line summary when the batter changes. Rows therefore fill in
    // while the tab is open (and reset on reload) until a per-game PA history
    // endpoint exists — see notes in github.md.
    trackAtBats(games) {
      (games || []).forEach((g) => {
        const w = this.paWatch[g.gamePk];
        const sig = `${g.batter.name}|${g.inning}${g.half}`;
        if (w && w.sig !== sig && w.pitches.length) {
          const hist = this.paHist[g.gamePk] || (this.paHist[g.gamePk] = []);
          hist.unshift(this.summarizePa(w));
          if (hist.length > 8) hist.pop();
        }
        if (!w || w.sig !== sig) {
          const abp = g.m.ab_pitches_ou || {}, abr = g.m.ab_result || {};
          this.paWatch[g.gamePk] = {
            sig, batter: g.batter.name, pitches: g.pitches.slice(),
            projPitches: abp.predictedValue != null ? +abp.predictedValue : null,
            call: abr.recommendation || null,
            callProb: abr.modelProb != null ? abr.modelProb : null,
          };
        } else if (g.pitches.length >= w.pitches.length) {
          w.pitches = g.pitches.slice();
        }
      });
    }
    // Only what a finished PA's pitches can honestly tell us: a ball in play is
    // resolvable to hit vs out by the settle job, not here, so it stays ungraded.
    summarizePa(w) {
      const ps = w.pitches;
      const last = ps[ps.length - 1] || {};
      const outcome = last.desc === "hit_by_pitch" ? null
        : last.cat === "in_play" ? "in_play"
          : last.cat === "ball" && (last.balls || 0) >= 3 ? "walk"
            : last.cat === "strike_foul" && last.desc !== "foul" && (last.strikes || 0) >= 2 ? "strikeout"
              : null;
      const graded = ps.filter((p) => p.pred && p.pred.resultOk != null);
      const right = graded.filter((p) => p.pred.resultOk).length;
      const errs = ps.filter((p) => p.pred && p.pred.speed != null && p.speed != null)
        .map((p) => p.pred.speed - p.speed);
      const avgErr = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
      const ratio = graded.length ? right / graded.length : null;
      return {
        batter: w.batter, pitches: ps.length, projPitches: w.projPitches,
        pitchBand: w.projPitches == null ? null : this.countBand(w.projPitches - ps.length),
        outcomeLabel: outcome ? (PH.OUTCOME_LABEL[outcome] || outcome) : "Unresolved",
        call: w.call, callProb: w.callProb,
        callOk: outcome == null || outcome === "in_play" ? null : w.call === outcome,
        avgErr, veloBand: this.veloBand(avgErr),
        right, gradedN: graded.length,
        pickBand: ratio == null ? null : ratio >= 0.6 ? "good" : ratio >= 0.4 ? "amber" : "bad",
      };
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
        case "focusGame": return this.setState({ focusGame: Number(arg) });
        case "dfGame": return this.setState({ dfGame: arg === "all" ? "all" : Number(arg) });
        case "mkt": return this.setState({ mkt: arg });
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
    focused() {
      if (!PH.games.length) return null;
      return PH.games.find((g) => g.gamePk === this.state.focusGame) || PH.games[0];
    }

    // ── Live Board · game rail (1c) / focus strip (1b) ────────────────────
    gameRailHtml(focusPk, mobile) {
      const C = this.C;
      const items = PH.games.map((g) => {
        const on = g.gamePk === focusPk;
        const nc = this.nextCall(g);
        const mini = `${g.score.away}–${g.score.home} ${g.half}${g.inning}`;
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
          <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:${C.mut};min-width:0;">
            <span style="font-family:'IBM Plex Mono',monospace;">${esc(g.count)}</span>
            <span style="width:1px;height:10px;background:${C.bd2};"></span>
            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(this.shortName(g.batter.name))}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:10px;font-weight:800;letter-spacing:.04em;color:${on ? C.grn : C.dim};background:${on ? "rgba(74,222,128,.16)" : C.chip};padding:2px 6px;border-radius:5px;white-space:nowrap;">${esc(nc.label)} ${esc(nc.pct)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${C.faint};">${esc(nc.velo)}</span>
          </div>
        </button>`;
      }).join("");
      if (mobile) {
        return `<div class="phv-sc" style="flex:none;display:flex;gap:6px;overflow-x:auto;padding:10px 14px;border-bottom:1px solid ${C.bd};background:${C.rail};">${items}</div>`;
      }
      return `<div class="phv-sc" style="border-right:1px solid ${C.bd};background:${C.rail};overflow-y:auto;padding:14px 12px;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;padding:0 2px;">
          <span style="font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">Live games</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">${PH.games.length}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">${items}</div>
      </div>`;
    }

    // ── Live Board · broadcast situation strip ────────────────────────────
    situationHtml(g, mobile) {
      const C = this.C;
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
            <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;color:${C.grn};">${esc(g.half)} ${esc(g.inning)}</span>
            <div style="margin-left:auto;">${this.diamondHtml(g, 36, 12)}</div>
            ${this.bsoHtml(g, 8)}
          </div>
          <div style="display:flex;gap:14px;margin-top:9px;font-size:12.5px;">
            <div><span style="color:${C.blue};font-size:10.5px;font-weight:700;">PITCHING</span> <b style="font-weight:700;">${esc(this.player(g.pitcher))}</b></div>
            <div><span style="color:${C.blue};font-size:10.5px;font-weight:700;">AT BAT</span> <b style="font-weight:700;">${esc(this.player(g.batter))}</b></div>
          </div>
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
        <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
          <span style="font-size:16px;line-height:1;color:${C.grn};">${esc(g.half)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;color:${C.dim};">Inn ${esc(g.inning)}</span>
        </div>
        ${this.diamondHtml(g, 52, 16)}
        ${this.bsoHtml(g, 11)}
        <div style="display:flex;flex-direction:column;gap:6px;margin-left:auto;font-size:13.5px;">
          <div style="display:flex;gap:10px;"><span style="color:${C.blue};width:60px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">Pitching</span><b style="font-weight:700;">${esc(this.player(g.pitcher))}</b></div>
          <div style="display:flex;gap:10px;"><span style="color:${C.blue};width:60px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">At bat</span><b style="font-weight:700;">${esc(this.player(g.batter))}</b><span style="color:${C.faint};font-family:'IBM Plex Mono',monospace;font-size:12px;">on deck ${esc(this.shortName(g.onDeckBatter && g.onDeckBatter.name))}</span></div>
        </div>
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

    // ── Live Board · earlier at-bats (client-accumulated) ─────────────────
    earlierRows(g, mobile) {
      const C = this.C;
      const hist = this.paHist[g.gamePk] || [];
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
      }).join("");
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

    // ══ LIVE BOARD (1b mobile · 1c desktop) ══════════════════════════════
    liveHtml() {
      const C = this.C;
      if (!PH.games.length) {
        return `<div style="padding:0 14px;">
          <div style="margin:18px 0 12px;">
            <h1 style="font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.02em;margin:0;">${esc(COPY.liveTitle)}</h1>
            <p style="margin:.3rem 0 0;color:${C.mut};font-size:.95rem;">${esc(COPY.liveSub)}</p>
          </div>
          <div style="padding:3.5rem 1rem;text-align:center;background:${C.panel};border:1px solid ${C.bd};border-radius:14px;">
            <div style="font-size:1.05rem;font-weight:700;margin-bottom:.35rem;">No live games right now</div>
            <div style="font-size:.9rem;color:${C.mut};">The board wakes up automatically at first pitch — <button data-act="goHome" style="border:0;background:transparent;color:${C.grn};font-family:inherit;font-weight:700;font-size:.9rem;cursor:pointer;padding:0;">see today's schedule</button>.</div>
          </div>
        </div>`;
      }
      const g = this.focused();
      const mobile = this.mob();
      const hist = this.paHist[g.gamePk] || [];

      if (mobile) {
        return `<div style="display:flex;flex-direction:column;min-height:0;">
          ${this.gameRailHtml(g.gamePk, true)}
          ${this.situationHtml(g, true)}
          <div style="padding:12px 14px 20px;">
            ${this.predPanelHtml(g, true)}
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:7px;">
              <span style="font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};">Pitch log · newest first</span>
              <span style="font-size:10.5px;color:${C.faint};">shading = call accuracy</span>
            </div>
            <div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};overflow:hidden;">
              ${this.pitchLogHtml(g, true)}
              ${hist.length ? `
              <div style="display:grid;grid-template-columns:1fr 50px 42px 34px;gap:6px;padding:7px 10px;border-top:1px solid ${C.bd};border-bottom:1px solid ${C.bd};background:${C.panel2};font-size:9.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:${C.faint};">
                <span>Earlier at-bats</span><span style="text-align:center;">P·pred</span><span style="text-align:center;">Velo</span><span style="text-align:center;">Picks</span>
              </div>
              ${this.earlierRows(g, true)}` : ""}
            </div>
            <div style="font-size:10.5px;color:${C.faint};padding:8px 2px 0;line-height:1.5;">Velo shading — <span style="color:${this.GRD.good.fg};font-weight:700;">green</span> within 1.5 mph, <span style="color:${this.GRD.amber.fg};font-weight:700;">amber</span> within 3, <span style="color:${this.GRD.bad.fg};font-weight:700;">red</span> beyond. Class calls are green when right, red when wrong.</div>
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
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:12px;color:${C.faint};">model ${esc(g.modelVersion || "—")} · ${g.stale ? "paused (no pitch 30s+)" : "live"}</span>
          </div>
          ${this.situationHtml(g, false)}
          <div style="display:grid;grid-template-columns:${nar ? "minmax(0,1fr)" : "minmax(0,1fr) 380px"};gap:16px;align-items:start;">
            <div style="display:flex;flex-direction:column;gap:12px;min-width:0;">
              <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;">
                <span style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">At-bat feed · newest first</span>
                <span style="font-size:11.5px;color:${C.faint};">shading = call accuracy · green ≤1.5 mph · amber ≤3 · red beyond</span>
              </div>
              <div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel};overflow:hidden;">${this.pitchLogHtml(g, false)}</div>
              <div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${C.faint};">Earlier at-bats</span>
                <span style="font-size:11.5px;color:${C.faint};">${hist.length ? `${hist.length} seen since this tab opened` : "none yet this session"}</span>
              </div>
              <div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel2};overflow:hidden;">
                <div style="display:grid;grid-template-columns:92px 2fr 74px 62px 50px;gap:12px;padding:9px 14px;border-bottom:1px solid ${C.bd};background:${C.panel3};font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.faint};">
                  <span>Batter</span><span>Result · called</span><span style="text-align:center;">P pred/act</span><span style="text-align:center;">Avg velo err</span><span style="text-align:center;">Picks</span>
                </div>
                ${hist.length ? this.earlierRows(g, false) : `<div style="padding:14px;font-size:12.5px;color:${C.faint};font-style:italic;">Finished at-bats land here as the game goes on — the feed only serves the current plate appearance, so this list starts empty on reload.</div>`}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:14px;">
              ${this.predPanelHtml(g, false)}
              ${this.zonePanelHtml(g)}
            </div>
          </div>
        </div>
      </div>`;
    }

    // ══ GRADED LOG (session-accumulated, feeds the Data Feed) ═════════════
    // /live exposes only the current plate appearance and no prediction history,
    // so the Data Feed's log and analytics are built by grading each pitch as
    // it arrives and keeping the result for this tab's session. A per-game (or
    // per-day) graded-prediction endpoint would make all of it durable.
    trackGradedLog(games) {
      if (!this.gradedLog) { this.gradedLog = []; this._seenPitch = {}; }
      (games || []).forEach((g) => {
        (g.pitches || []).forEach((p) => {
          const key = `${g.gamePk}|${g.inning}${g.half}|${g.batter.name}|${p.n}`;
          if (this._seenPitch[key]) return;
          this._seenPitch[key] = 1;
          const base = {
            t: Date.now(), pk: g.gamePk, game: g.label, inning: g.inning,
            pitcher: g.pitcher.name, batter: g.batter.name,
            matchup: `${this.shortName(g.pitcher.name)} → ${this.shortName(g.batter.name)}`,
            count: `${p.balls}-${p.strikes}`, outs: g.outs, type: p.type, speed: p.speed,
            model: g.modelVersion || "—",
          };
          if (p.pred && p.pred.speed != null && p.speed != null) {
            const err = p.pred.speed - p.speed;
            this.gradedLog.unshift(Object.assign({}, base, {
              id: key + "|v", mkt: "VELO",
              pred: `${p.pred.speed.toFixed(1)} mph`, predRaw: p.pred.speed.toFixed(1),
              actual: `${p.speed.toFixed(1)}`, actualRaw: p.speed.toFixed(1),
              err: (err >= 0 ? "+" : "−") + Math.abs(err).toFixed(1), errAbs: Math.abs(err),
              band: this.veloBand(err), hit: Math.abs(err) <= 1.5,
            }));
          }
          if (p.pred && p.pred.resultCat && p.desc) {
            const ok = p.pred.resultOk;
            this.gradedLog.unshift(Object.assign({}, base, {
              id: key + "|c", mkt: "CLASS",
              pred: PH.OUTCOME_LABEL[p.pred.resultCat] || p.pred.resultCat,
              predRaw: `${p.pred.resultCat} ${p.pred.resultProb != null ? Math.round(p.pred.resultProb * 100) + "%" : ""}`,
              conf: p.pred.resultProb, actual: this.resultMeta(p.desc)[0], actualRaw: p.desc,
              err: ok == null ? "ungraded" : ok ? "correct" : "miss",
              band: ok == null ? null : ok ? "good" : "bad", hit: ok === true,
            }));
          }
        });
      });
      if (this.gradedLog.length > 400) this.gradedLog.length = 400;
    }
    dfRows() {
      const scope = this.state.dfGame;
      let rows = (this.gradedLog || []);
      if (scope !== "all") rows = rows.filter((r) => r.pk === scope);
      return rows;
    }
    dfStats(rows) {
      const velo = rows.filter((r) => r.mkt === "VELO");
      const cls = rows.filter((r) => r.mkt === "CLASS" && r.band != null);
      const mae = velo.length ? velo.reduce((a, r) => a + r.errAbs, 0) / velo.length : null;
      const within = velo.length ? velo.filter((r) => r.hit).length / velo.length : null;
      const clsHit = cls.length ? cls.filter((r) => r.hit).length / cls.length : null;
      return { velo, cls, mae, within, clsHit, n: rows.length };
    }
    fmtTime(t) {
      const d = new Date(t);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    }

    // ══ DATA FEED (1e mobile · 1d desktop) ═══════════════════════════════
    // ══ WAREHOUSE SCOUTING (durable — survives a reload) ══════════════════
    // The graded log above is session-only and stays that way: nothing stores
    // per-pitch prediction history, and the holdout store that would is
    // explicitly deferred. These panels instead come from the Phase 4 nightly
    // aggregates in R2, so the Data Feed has real content on a cold load for
    // the first time. Everything here degrades to a note — a warehouse outage
    // must never blank the live board.
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

    // Seed from the live board when it has games, otherwise from the last
    // session. This is what makes the tab survive a refresh.
    syncScouting() {
      const g = PH.games.find((x) => x.gamePk === this.state.feedGame)
        || PH.games[0];
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

    dataHtml() {
      const C = this.C;
      const mobile = this.mob();
      if (!PH.games.length) {
        // Cold load with no live games. Before Phase 4 this was the whole
        // tab, which is why it lost everything on refresh; the scouting
        // panels are restored from the last session and render here.
        return `${this.scoutingHtml()}<div style="padding:2.5rem 14px;text-align:center;color:${C.faint};">No live games right now — the graded log fills as pitches arrive.</div>`;
      }
      const rows = this.dfRows();
      const st = this.dfStats(rows);
      const scopeLabel = this.state.dfGame === "all"
        ? "all live games"
        : (PH.games.find((x) => x.gamePk === this.state.dfGame) || {}).label || "all live games";

      // ── game panels ────────────────────────────────────────────────────
      const allOn = this.state.dfGame === "all";
      const allChip = `<button data-act="dfGame" data-arg="all" style="border:1px solid ${allOn ? C.acc : C.bd};background:${allOn ? "#12301f" : C.chip};color:${allOn ? C.grn : C.dim};font-family:inherit;font-weight:600;font-size:${mobile ? 11.5 : 12}px;padding:${mobile ? "4px 11px" : "5px 12px"};border-radius:999px;cursor:pointer;">All${mobile ? "" : " games"}</button>`;
      const panels = PH.games.map((g) => {
        const on = g.gamePk === this.state.dfGame;
        const nc = this.nextCall(g);
        return `<button data-act="dfGame" data-arg="${g.gamePk}" style="${mobile ? "flex:none;width:158px;" : ""}display:flex;flex-direction:column;gap:6px;text-align:left;border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.panel};border-radius:12px;padding:${mobile ? "9px 10px" : "10px 11px"};font-family:inherit;color:${C.txt};cursor:pointer;opacity:${g.stale ? 0.7 : 1};">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:${mobile ? 12 : 12.5}px;font-weight:800;color:${on ? C.grn : C.txt};">${esc(g.label)}</span>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 10.5 : 11}px;font-weight:600;color:${on ? C.gsub : C.dim};">${esc(g.score.away)}–${esc(g.score.home)} ${esc(g.half)}${esc(g.inning)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:7px;font-size:${mobile ? 11 : 11.5}px;color:${C.mut};min-width:0;">
            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(this.shortName(g.batter.name))}</span>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;color:${C.dim};">${esc(g.count)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:${mobile ? 9.5 : 10}px;font-weight:800;letter-spacing:.03em;color:${on ? C.grn : C.dim};background:${on ? "rgba(74,222,128,.16)" : C.chip};padding:2px ${mobile ? 5 : 6}px;border-radius:5px;white-space:nowrap;">${esc(nc.label)} ${esc(nc.pct)}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:${mobile ? 10 : 10.5}px;color:${C.faint};">${esc(nc.velo)}</span>
          </div>
        </button>`;
      }).join("");

      // ── KPI tiles ──────────────────────────────────────────────────────
      const kpiDefs = [
        { label: "Velo MAE", value: st.mae == null ? "—" : st.mae.toFixed(2), unit: "mph", c: st.mae == null ? C.dim : this.grd(this.veloBand(st.mae)).fg, sub: `mean |called − actual| · n=${st.velo.length}` },
        { label: "Velo within 1.5", value: st.within == null ? "—" : Math.round(st.within * 100) + "%", c: st.within == null ? C.dim : st.within >= 0.5 ? this.GRD.good.fg : this.GRD.amber.fg, sub: `green band share · n=${st.velo.length}` },
        { label: "Class hit rate", value: st.clsHit == null ? "—" : Math.round(st.clsHit * 100) + "%", c: st.clsHit == null ? C.dim : st.clsHit >= 0.5 ? this.GRD.good.fg : this.GRD.amber.fg, sub: `strike/ball/in-play · n=${st.cls.length}` },
        { label: "Graded this session", value: String(st.n), c: C.txt, sub: `${scopeLabel} · resets on reload` },
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
      const logRows = rows.filter((r) => mkt === "all" || r.mkt === mkt);
      const mktChips = [["all", "All"], ["VELO", "Pitch velo"], ["CLASS", "Pitch result"]].map(([k, label]) => {
        const on = mkt === k;
        return `<button data-act="mkt" data-arg="${k}" style="border:1px solid ${on ? C.acc : C.bd};background:${on ? "#12301f" : C.chip};color:${on ? C.grn : C.dim};font-family:inherit;font-weight:600;font-size:12px;padding:6px 12px;border-radius:999px;cursor:pointer;">${label}</button>`;
      }).join("");
      const mktTag = (m) => m === "VELO"
        ? `background:rgba(106,162,255,.16);color:#6aa2ff;`
        : `background:rgba(164,123,255,.16);color:#a37bff;`;

      const logCols = "66px 92px minmax(0,1.25fr) 44px minmax(0,1.15fr) minmax(0,1.35fr)";
      const desktopLog = logRows.slice(0, 60).map((r) => {
        const gr = this.grd(r.band);
        return `<div style="display:grid;grid-template-columns:${logCols};gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid ${C.row};font-size:12.5px;">
          <span style="font-family:'IBM Plex Mono',monospace;color:${C.faint};">${esc(this.fmtTime(r.t))}</span>
          <span style="font-weight:700;font-size:12px;">${esc(r.game)}</span>
          <span style="color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.matchup)}</span>
          <span style="font-family:'IBM Plex Mono',monospace;color:${C.mut};">${esc(r.count)}</span>
          <span style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="font-size:9.5px;font-weight:800;letter-spacing:.04em;${mktTag(r.mkt)}padding:2px 5px;border-radius:4px;margin-right:6px;">${r.mkt}</span><b style="font-family:'IBM Plex Mono',monospace;font-weight:600;">${esc(r.pred)}</b></span>
          <span style="display:flex;align-items:baseline;gap:9px;border-radius:8px;background:${gr.bg};padding:5px 10px;min-width:0;">
            <b style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:${gr.fg};white-space:nowrap;">${esc(r.actual)}</b>
            <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.mut};white-space:nowrap;">${esc(r.err)}</span>
          </span>
        </div>`;
      }).join("");

      const mobileLog = logRows.slice(0, 40).map((r) => {
        const gr = this.grd(r.band);
        const open = this.state.openLog === r.id;
        const kv = (k, v) => `<div style="display:flex;justify-content:space-between;gap:10px;"><span style="color:${C.faint};">${k}</span><span>${esc(v)}</span></div>`;
        return `<div style="border-bottom:1px solid ${C.row};">
          <div data-act="logRow" data-arg="${esc(r.id)}" style="display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;align-items:center;padding:10px 12px;cursor:pointer;">
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:${C.faint};">${esc(this.fmtTime(r.t))}</span>
            <span style="min-width:0;">
              <span style="display:block;font-size:12.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.game)} · ${r.mkt}</span>
              <span style="display:block;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.mut};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">called ${esc(r.pred)}</span>
            </span>
            <span style="display:block;border-radius:7px;background:${gr.bg};padding:4px 8px;text-align:right;">
              <span style="display:block;font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${gr.fg};white-space:nowrap;">${esc(r.actual)}</span>
              <span style="display:block;font-family:'IBM Plex Mono',monospace;font-size:10px;color:${C.mut};white-space:nowrap;">${esc(r.err)}</span>
            </span>
          </div>
          ${open ? `<div style="padding:0 12px 12px;display:flex;flex-direction:column;gap:6px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.dim};">
            ${kv("matchup", r.matchup)}${kv("count · outs", `${r.count} · ${r.outs}`)}${kv("predicted", r.predRaw)}${kv("actual", r.actualRaw)}${kv("error", r.err)}${kv("model", r.model)}${kv("graded", this.fmtTime(r.t))}
          </div>` : ""}
        </div>`;
      }).join("");

      const logEmpty = `<div style="padding:16px 14px;font-size:12.5px;color:${C.faint};font-style:italic;line-height:1.55;">Nothing graded yet this session. A row lands as soon as a pitch arrives with a prediction attached — the feed carries no prediction history, so the log starts empty on reload.</div>`;

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
      const calib = modCard("Calibration by market · this session",
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
        const src = st.velo.filter((r) => r.speed != null);
        const byInn = {};
        src.forEach((r) => { (byInn[r.inning] = byInn[r.inning] || []).push(r.speed); });
        const innings = Object.keys(byInn).map(Number).sort((a, b) => a - b);
        if (innings.length < 2) return null;
        const bars = innings.map((i) => ({ inn: i, v: byInn[i].reduce((a, b) => a + b, 0) / byInn[i].length, n: byInn[i].length }));
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
        }).join("")}</div>` : thin("Needs pitches from two or more innings this session."),
        trend ? `Average actual velocity per inning across ${esc(scopeLabel)}.` : null,
        trend ? `<span style="font-size:12px;font-weight:700;">${trend.drop >= 0 ? "+" : "−"}<span style="font-family:'IBM Plex Mono',monospace;color:${trend.drop < -1 ? C.red : C.dim};font-weight:600;">${Math.abs(trend.drop).toFixed(1)} mph</span></span>` : "");

      // pitch mix by count bucket
      const mix = (() => {
        const src = rows.filter((r) => r.mkt === "VELO" && r.type);
        if (src.length < 8) return null;
        const bucket = (c) => {
          const [b, s] = c.split("-").map(Number);
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
        </div>` : thin("Needs at least 8 graded pitches this session."),
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
        }).join("") : thin("Needs at least 4 graded class calls this session."),
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
            body: "Averaged per inning across the pitches graded this session.",
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
          <div style="border:1px solid ${C.bd};border-radius:12px;background:${C.panel};overflow:hidden;margin-bottom:16px;">${mobileLog || logEmpty}</div>

          <div style="display:flex;flex-direction:column;gap:12px;">${calib}${veloTrend}${confCard}</div>
        </div>`;
      }

      return `<div style="padding:20px 24px 28px;">
        <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:14px;">
          <h1 style="margin:0;font-size:27px;font-weight:800;letter-spacing:-.02em;">${esc(COPY.dataTitle)}</h1>
          <p style="margin:0;font-size:13.5px;color:${C.mut};">${esc(COPY.dataSub)}</p>
          <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.faint};">graded live as pitches land · session-scoped</span>
        </div>

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
              <span style="font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};margin-right:2px;">Market</span>
              ${mktChips}
              <span style="margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:${C.faint};">${logRows.length} rows</span>
            </div>
            <div style="border:1px solid ${C.bd};border-radius:14px;background:${C.panel};overflow:hidden;">
              <div style="display:grid;grid-template-columns:${logCols};gap:10px;padding:10px 14px;border-bottom:1px solid ${C.bd};background:${C.panel2};font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.faint};">
                <span>Time</span><span>Game</span><span>Matchup</span><span>Cnt</span><span>Prediction</span><span>Actual · error</span>
              </div>
              ${desktopLog || logEmpty}
              ${desktopLog ? `<div style="padding:11px 14px;font-size:11.5px;color:${C.faint};line-height:1.5;">Streaming — a row lands the moment a pitch arrives with a prediction attached. Errors are signed: called minus actual. Shading grades the call — green within 1.5 mph, amber ≤3, red beyond; class calls green when right, red when wrong.</div>` : ""}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px;">${calib}${veloTrend}${mixCard}${confCard}</div>
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
      this._bindMq();
      const wide = view !== "home";
      this.root.innerHTML = `
        ${this.headerHtml()}
        <main class="ph-main${wide ? " phv-wide" : ""}">${main}</main>
        ${wide ? "" : this.footerHtml()}`;
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
        const games = await PH.loadLive(API_BASE);
        if (Array.isArray(games)) {
          // [] is a real answer (no live games) — empty the board.
          PH.games = this._withoutFinals(games);
          this.trackAtBats(PH.games);
          this.trackGradedLog(PH.games);
          if (PH.games.length && !PH.games.some((g) => g.gamePk === this.state.feedGame)) {
            this.state.feedGame = PH.games[0].gamePk;
          }
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
        if (changed) {
          PH.games = this._withoutFinals(PH.games); // a game may have just gone final
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
      this._setStaleBanner(!!(h && h.data_fresh === false) && PH.games.length > 0, h);
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
    board.state.feedGame = PH.games[0] ? PH.games[0].gamePk : null;
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
