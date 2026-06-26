// ════════════════════════════════════════════════════════════════════════
// site.js — Consumer picks site: render + interactions.
//
// Renders today's picks (with expandable supporting-bullet dropdowns and
// affiliate "Bet" CTAs) and the public track record. Data comes from
// picks-data.js by default; loadPicks()/loadRecord() are the single seams to
// swap in the live backend (GET /sportsbooks, a future /picks/today, /record).
// ════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // Point this at the deployed API to go live. Empty string => mock only.
  const API_BASE = "";

  // The Feed section talks to the live backend directly (raw /health, /games,
  // /live), independent of the mock picks/record data above.
  const FEED_API_BASE = window.PITCH_EDGE_API || "http://localhost:8080";
  const FEED_POLL_MS = 8000;

  const D = window.PICKS_DATA;
  const $ = (sel, root) => (root || document).querySelector(sel);

  // ── formatters ───────────────────────────────────────────────────────
  const fmtAmerican = (p) => (p == null ? "—" : p > 0 ? `+${p}` : `${p}`);
  const fmtPct = (v, d = 0) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
  const fmtUnits = (u) => `${u >= 0 ? "+" : "−"}${Math.abs(u).toFixed(1)}u`;
  const fmtSigned = (v, suffix = "") => `${v >= 0 ? "+" : "−"}${Math.abs(v)}${suffix}`;
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // implied probability from American odds — used to show the edge story
  const impliedProb = (am) =>
    am == null ? null : am > 0 ? 100 / (am + 100) : -am / (-am + 100);

  // edge tier drives the accent color
  const edgeTier = (e) =>
    e == null ? "none" : e >= 0.06 ? "hot" : e >= 0.03 ? "warm" : e >= 0 ? "soft" : "neg";

  const handLabel = (h) => (h === "S" ? "Switch" : h === "L" ? "LHP/LHB" : h === "R" ? "RHP/RHB" : "");

  // ── data loading (mock now, API-ready) ───────────────────────────────
  // Each loader resolves to the mock shape so swapping in fetch() is local.
  async function loadBooks() {
    if (!API_BASE) return D.BOOKS;
    try {
      const r = await fetch(`${API_BASE}/sportsbooks`);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      const byKey = {};
      (data.books || []).forEach((b) => (byKey[b.key] = b));
      return Object.keys(byKey).length ? byKey : D.BOOKS;
    } catch (_e) {
      return D.BOOKS; // offline / not deployed yet
    }
  }

  async function loadPicks() {
    if (!API_BASE) return D.PICKS;
    try {
      const r = await fetch(`${API_BASE}/picks/today`);
      if (!r.ok) throw new Error(r.status);
      const picks = await r.json();
      return picks.length ? picks : D.PICKS;
    } catch (_e) {
      return D.PICKS; // offline / not deployed yet
    }
  }

  async function loadRecord() {
    if (!API_BASE) return D.RECORD;
    try {
      const r = await fetch(`${API_BASE}/record`);
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (_e) {
      return D.RECORD; // offline / not deployed yet
    }
  }

  // ── affiliate CTA ────────────────────────────────────────────────────
  // Logs the click to the funnel (POST /track/click, fire-and-forget) then
  // lets the browser follow the affiliate link in a new tab.
  function trackClick(payload) {
    if (!API_BASE) return;
    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(`${API_BASE}/track/click`, new Blob([body], { type: "application/json" }));
      } else {
        fetch(`${API_BASE}/track/click`, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
      }
    } catch (_e) { /* never block the outbound click */ }
  }

  // ── pick card ────────────────────────────────────────────────────────
  function pickCard(p, books) {
    const market = D.MARKETS[p.market] || { label: p.market };
    const book = books[p.book] || { name: p.book, url: "#", short: "", affiliate_configured: false };
    const tier = edgeTier(p.edge);
    const conf = Math.round((p.confidence || 0) * 100);
    const implied = impliedProb(p.price);

    const card = document.createElement("article");
    card.className = "pick-card";
    card.dataset.market = p.market;

    const bullets = (p.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("");
    const detailsId = `why-${p.id}`;

    card.innerHTML = `
      <div class="pick-top">
        <div class="matchup">
          <span class="teams">${esc(p.game.away)} <span class="at">@</span> ${esc(p.game.home)}</span>
          <span class="game-meta">${esc(p.game.first_pitch)} · ${esc(p.game.venue)}</span>
        </div>
        <span class="market-tag">${esc(market.label)}</span>
      </div>

      <div class="matchup-faces">
        <div class="face">
          <span class="face-role">Pitcher</span>
          <span class="face-name">${esc(p.pitcher.name)} <span class="hand">${esc(p.pitcher.hand)}</span></span>
          ${p.pitcher.note ? `<span class="face-note">${esc(p.pitcher.note)}</span>` : ""}
        </div>
        <span class="vs">vs</span>
        <div class="face">
          <span class="face-role">Batter</span>
          <span class="face-name">${esc(p.batter.name)} <span class="hand">${esc(p.batter.hand)}</span></span>
          ${p.batter.note ? `<span class="face-note">${esc(p.batter.note)}</span>` : ""}
        </div>
      </div>

      <div class="pick-line">
        <div class="pick-call">
          <span class="pick-label">Pick</span>
          <span class="pick-value">${esc(p.pick)}</span>
        </div>
        <div class="pick-odds">
          <span class="odds-price">${fmtAmerican(p.price)}</span>
          <span class="odds-book">${esc(book.short || book.name)}</span>
        </div>
      </div>

      <div class="meters">
        <div class="meter">
          <div class="meter-head"><span>Model confidence</span><span>${conf}%</span></div>
          <div class="bar"><div class="bar-fill" style="width:${conf}%"></div></div>
        </div>
        <div class="edge-chip edge-${tier}">
          <span class="edge-val">${fmtSigned(((p.edge || 0) * 100).toFixed(1), "%")}</span>
          <span class="edge-lbl">edge</span>
        </div>
      </div>

      <div class="cta-row">
        <a class="btn btn-primary bet-cta" href="${esc(book.url)}" target="_blank" rel="nofollow noopener sponsored">
          Bet at ${esc(book.name)} <span aria-hidden="true">→</span>
        </a>
        ${book.affiliate_configured ? "" : `<span class="aff-flag" title="Affiliate id not yet configured">demo link</span>`}
      </div>

      <button class="why-toggle" type="button" aria-expanded="false" aria-controls="${detailsId}">
        <span>Why this pick</span>
        <span class="chev" aria-hidden="true">▾</span>
      </button>
      <div class="why-body" id="${detailsId}" hidden>
        <p class="why-intro">${implied != null
          ? `Model: <strong>${conf}%</strong> · Market implies <strong>${fmtPct(implied)}</strong>`
          : "Supporting factors"}</p>
        <ul class="why-bullets">${bullets}</ul>
        <p class="why-foot">Confirm the live line at the book before betting. Illustrative only.</p>
      </div>
    `;

    // expand / collapse the supporting-bullet dropdown
    const toggle = $(".why-toggle", card);
    const body = $(".why-body", card);
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      body.hidden = open;
      card.classList.toggle("is-open", !open);
    });

    // funnel logging on the affiliate click
    $(".bet-cta", card).addEventListener("click", () => {
      trackClick({
        market: p.market, side: p.pick, book: p.book,
        edge: p.edge, affiliate_configured: book.affiliate_configured,
      });
    });

    return card;
  }

  // ── market tabs ──────────────────────────────────────────────────────
  // One tab per market plus a cross-market "Best live opportunities" tab
  // (the default) that ranks every market's picks together, best edge first.
  // Picks and their rendered cards are held at module scope so a tab switch
  // can re-order the grid instead of just toggling visibility.
  const BEST_KEY = "best";
  let allPicks = [];
  let pickCards = {}; // pick id -> rendered <article> (reused across tabs)

  // best edge first; ties fall back to model confidence
  const byEdgeDesc = (a, b) =>
    (b.edge || 0) - (a.edge || 0) || (b.confidence || 0) - (a.confidence || 0);

  function picksForTab(key) {
    const list = key === BEST_KEY ? allPicks.slice() : allPicks.filter((p) => p.market === key);
    return list.sort(byEdgeDesc);
  }

  function tabSubText(key, list) {
    const today = new Date().toLocaleDateString(undefined, { month: "long", day: "numeric" });
    if (!list.length) return "No picks on the board for this market right now.";
    if (key === BEST_KEY) {
      return `Top ${list.length} live opportunities across all markets for ${today}, ranked by model edge — tap “Why this pick” for the reasoning.`;
    }
    const label = (D.MARKETS[key] || {}).label || key;
    return `${list.length} ${label} pick${list.length === 1 ? "" : "s"} for ${today}, best edge first — tap “Why this pick” for the reasoning.`;
  }

  // (re)render the grid for the active tab, ordering cards best edge first
  function renderPicks(key) {
    const grid = $("#picks-grid");
    const list = picksForTab(key);
    grid.innerHTML = "";
    list.forEach((p) => grid.appendChild(pickCards[p.id]));
    const sub = $("#picks-sub");
    if (sub) sub.textContent = tabSubText(key, list);
  }

  function buildFilters() {
    const filters = $("#filters");
    const counts = {};
    allPicks.forEach((p) => (counts[p.market] = (counts[p.market] || 0) + 1));
    // Lead with the cross-market "best" tab, then one tab per known market
    // (in MARKETS order) that currently has at least one pick on the board.
    const tabs = [{ key: BEST_KEY, label: "Best live opportunities", n: allPicks.length }].concat(
      Object.keys(D.MARKETS)
        .filter((k) => counts[k])
        .map((k) => ({ key: k, label: D.MARKETS[k].label, n: counts[k] }))
    );

    filters.innerHTML = "";
    tabs.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "filter" + (i === 0 ? " active" : "");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", i === 0 ? "true" : "false");
      b.dataset.key = t.key;
      b.innerHTML = `${esc(t.label)} <span class="filter-n">${t.n}</span>`;
      b.addEventListener("click", () => {
        filters.querySelectorAll(".filter").forEach((x) => {
          x.classList.remove("active");
          x.setAttribute("aria-selected", "false");
        });
        b.classList.add("active");
        b.setAttribute("aria-selected", "true");
        renderPicks(t.key);
      });
      filters.appendChild(b);
    });
  }

  // ── track record ─────────────────────────────────────────────────────
  function renderRecord(rec) {
    $("#record-sub").textContent =
      `Every graded pick, kept in the open. Updated ${rec.updated}.`;

    const o = rec.overall;
    const winPct = o.wins + o.losses > 0 ? (o.wins / (o.wins + o.losses)) * 100 : 0;
    const tiles = [
      { big: `${o.wins}–${o.losses}${o.pushes ? `–${o.pushes}` : ""}`, lbl: "Overall record", sub: `${o.picks} picks graded` },
      { big: `${winPct.toFixed(1)}%`, lbl: "Win rate", sub: "Wins vs losses" },
      { big: fmtUnits(o.units), lbl: "Net units", sub: "Flat-stake basis", tone: o.units >= 0 ? "pos" : "neg" },
      { big: fmtSigned(o.roi, "%"), lbl: "ROI", sub: "Return on stake", tone: o.roi >= 0 ? "pos" : "neg" },
      { big: fmtUnits(rec.last30.units), lbl: "Last 30 days", sub: `${rec.last30.wins}–${rec.last30.losses}, ${fmtSigned(rec.last30.roi, "%")} ROI`, tone: rec.last30.units >= 0 ? "pos" : "neg" },
    ];
    $("#record-tiles").innerHTML = tiles.map((t) => `
      <div class="rec-tile${t.tone ? " tone-" + t.tone : ""}">
        <span class="rec-big">${esc(t.big)}</span>
        <span class="rec-lbl">${esc(t.lbl)}</span>
        <span class="rec-sub">${esc(t.sub)}</span>
      </div>`).join("");

    // by-market table
    const bm = rec.byMarket.map((m) => {
      const wp = m.wins + m.losses > 0 ? (m.wins / (m.wins + m.losses)) * 100 : 0;
      return `<tr>
        <td>${esc(m.label)}</td>
        <td class="num">${m.wins}–${m.losses}${m.pushes ? `–${m.pushes}` : ""}</td>
        <td class="num">${wp.toFixed(0)}%</td>
        <td class="num ${m.units >= 0 ? "pos" : "neg"}">${fmtUnits(m.units)}</td>
        <td class="num ${m.roi >= 0 ? "pos" : "neg"}">${fmtSigned(m.roi, "%")}</td>
      </tr>`;
    }).join("");
    $("#bymarket-table").innerHTML =
      `<thead><tr><th>Market</th><th class="num">W–L</th><th class="num">Win%</th><th class="num">Units</th><th class="num">ROI</th></tr></thead><tbody>${bm}</tbody>`;

    // recent settled table
    const rr = rec.recent.map((r) => `
      <tr>
        <td class="dim">${esc(r.date.slice(5))}</td>
        <td>${esc(r.pick)}<span class="rec-match">${esc(r.matchup)}</span></td>
        <td class="num dim">${fmtAmerican(r.price)}</td>
        <td class="num"><span class="result result-${esc(r.result)}">${esc(r.result.toUpperCase())}</span></td>
      </tr>`).join("");
    $("#recent-table").innerHTML =
      `<thead><tr><th>Date</th><th>Pick</th><th class="num">Odds</th><th class="num">Result</th></tr></thead><tbody>${rr}</tbody>`;
  }

  function renderHeroStats(rec) {
    const o = rec.overall;
    const winPct = (o.wins / (o.wins + o.losses)) * 100;
    $("#hero-stats").innerHTML = `
      <div class="stat-card">
        <span class="stat-card-title">Verified track record</span>
        <div class="stat-row">
          <div class="stat"><span class="stat-num">${winPct.toFixed(1)}%</span><span class="stat-lbl">win rate</span></div>
          <div class="stat"><span class="stat-num ${o.units >= 0 ? "pos" : "neg"}">${fmtUnits(o.units)}</span><span class="stat-lbl">net units</span></div>
          <div class="stat"><span class="stat-num ${o.roi >= 0 ? "pos" : "neg"}">${fmtSigned(o.roi, "%")}</span><span class="stat-lbl">ROI</span></div>
        </div>
        <a class="stat-link" href="#record">See all ${o.picks} graded picks →</a>
      </div>`;
  }

  // ── live data feed (raw /health, /games, /live — unaugmented) ─────────
  let feedGames = [];
  let feedSelectedPk = null;

  async function fetchJson(path) {
    try {
      const r = await fetch(`${FEED_API_BASE}${path}`);
      return r.ok ? await r.json() : null;
    } catch (_e) {
      return null;
    }
  }

  function renderFeedStatus(health, gamesList) {
    const healthKv = health
      ? `<div class="feed-kv">
          <span><b>status</b> ${esc(health.status)}</span>
          <span><b>model_version</b> ${esc(health.model_version)}</span>
          <span><b>stats_pitchers</b> ${esc(health.stats_pitchers)}</span>
          <span><b>stats_ab_pitchers</b> ${esc(health.stats_ab_pitchers)}</span>
          <span><b>stats_loaded_at</b> ${esc(health.stats_loaded_at)}</span>
          <span><b>timestamp</b> ${esc(health.timestamp)}</span>
        </div>`
      : `<div class="feed-empty">no response yet from ${esc(FEED_API_BASE)}/health</div>`;

    const rosterRows = (gamesList || []).map((g) => `
      <div class="feed-tr">
        <span>${esc(g.game_pk)}</span><span>${esc(g.status)}</span><span>${esc(g.away_team)}</span><span>${esc(g.home_team)}</span>
      </div>`).join("");
    const roster = (gamesList || []).length
      ? `<div class="feed-table">
          <div class="feed-th"><span>game_pk</span><span>status</span><span>away_team</span><span>home_team</span></div>
          ${rosterRows}
        </div>`
      : `<div class="feed-empty">no live games reported</div>`;

    $("#feed-status").innerHTML = `
      <div class="feed-section">
        <div class="feed-section-title">BACKEND STATUS · GET /health</div>
        ${healthKv}
        <div class="feed-section-title">LIVE GAMES ROSTER · GET /games</div>
        ${roster}
      </div>`;
  }

  function feedPaneHtml(g) {
    const sit = g.situation || {};
    const pitches = g.current_pa_pitches || [];
    const markets = g.markets || [];

    const pitchRows = pitches.map((p) => `
      <div class="feed-tr">
        <span>${esc(p.pitch_number)}</span><span>${esc(p.pitch_type ?? "—")}</span>
        <span>${esc(p.start_speed ?? "—")}</span><span>${esc(p.zone ?? "—")}</span>
        <span>${esc(p.description ?? "—")}</span><span>${esc(p.result_category ?? "—")}</span>
        <span>${esc(p.balls)}-${esc(p.strikes)}</span>
      </div>`).join("");

    const marketRows = markets.map((m) => `
      <div class="feed-tr">
        <span>${esc(m.market)}</span><span>${esc(m.predicted_value ?? "—")}</span>
        <span>${m.probs ? esc(JSON.stringify(m.probs)) : "—"}</span><span>${esc(m.confidence ?? "—")}</span>
        <span>${esc(m.sample_size ?? "—")}</span><span>${esc(m.edge ?? "—")}</span>
        <span>${esc(m.line ?? "—")}</span><span>${esc(m.price ?? "—")}</span>
      </div>`).join("");

    return `
      <article class="feed-pane">
        <header class="feed-pane-head">
          <span class="feed-id">#${esc(g.game_pk)}</span>
          <span class="feed-label">${esc(g.game_label)}</span>
          <span class="feed-names">P: ${esc(g.pitcher_name ?? "—")} · B: ${esc(g.batter_name ?? "—")}</span>
          <span class="feed-model">${esc(g.model_version ?? "—")}</span>
        </header>

        <div class="feed-section-title">SITUATION · raw</div>
        <div class="feed-kv">
          <span><b>inning</b> ${esc(sit.inning ?? "—")}</span>
          <span><b>half</b> ${esc(sit.half ?? "—")}</span>
          <span><b>count</b> ${esc(sit.count ?? "—")}</span>
          <span><b>outs</b> ${esc(sit.outs ?? "—")}</span>
          <span><b>pitcher_id</b> ${esc(sit.pitcher_id ?? "—")}</span>
          <span><b>batter_id</b> ${esc(sit.batter_id ?? "—")}</span>
          <span><b>pitch_count_pa</b> ${esc(sit.pitch_count_pa ?? "—")}</span>
          <span><b>last_pitch_ts</b> ${esc(sit.last_pitch_ts ?? "—")}</span>
        </div>

        <div class="feed-section-title">CURRENT_PA_PITCHES · raw (${pitches.length})</div>
        ${pitches.length
          ? `<div class="feed-table">
              <div class="feed-th"><span>#</span><span>type</span><span>speed</span><span>zone</span><span>description</span><span>result_category</span><span>B-S</span></div>
              ${pitchRows}
            </div>`
          : `<div class="feed-empty">no pitches in current at-bat</div>`}

        <div class="feed-section-title">MARKETS · raw (${markets.length})</div>
        ${markets.length
          ? `<div class="feed-table">
              <div class="feed-th"><span>market</span><span>predicted_value</span><span>probs</span><span>confidence</span><span>sample_size</span><span>edge</span><span>line</span><span>price</span></div>
              ${marketRows}
            </div>`
          : `<div class="feed-empty">no markets sent by backend yet</div>`}

        <footer class="feed-pane-foot">
          <span><b>has_edge</b> ${esc(g.has_edge ?? "—")}</span>
          <span><b>top_edge</b> ${esc(g.top_edge ?? "—")}</span>
        </footer>
      </article>`;
  }

  function renderFeedSubtabs(games) {
    const subtabs = $("#feed-subtabs");
    if (!games.length) {
      subtabs.innerHTML = "";
      return;
    }
    if (feedSelectedPk == null || !games.some((g) => g.game_pk === feedSelectedPk)) {
      feedSelectedPk = games[0].game_pk;
    }
    subtabs.innerHTML = games.map((g) => `
      <button class="filter feed-subtab${g.game_pk === feedSelectedPk ? " active" : ""}" type="button"
        role="tab" aria-selected="${g.game_pk === feedSelectedPk}" data-pk="${esc(g.game_pk)}">
        ${esc(g.game_label || g.game_pk)}
      </button>`).join("");
    subtabs.querySelectorAll(".feed-subtab").forEach((btn) => {
      btn.addEventListener("click", () => {
        feedSelectedPk = Number(btn.dataset.pk) || btn.dataset.pk;
        renderFeedSubtabs(games);
        renderFeedPanes(games);
      });
    });
  }

  function renderFeedPanes(games) {
    const panes = $("#feed-panes");
    if (!games.length) {
      panes.innerHTML = `<div class="feed-empty">no live games right now — raw payloads will appear here as games go live</div>`;
      return;
    }
    const selected = games.find((g) => g.game_pk === feedSelectedPk) || games[0];
    panes.innerHTML = feedPaneHtml(selected);
  }

  async function pollFeed() {
    const [health, gamesList, live] = await Promise.all([
      fetchJson("/health"), fetchJson("/games"), fetchJson("/live"),
    ]);
    renderFeedStatus(health, gamesList);
    // /live can hold stale rows for games that have since ended; only offer
    // pills for games /games still reports as currently in progress.
    const liveOnPks = new Set((gamesList || []).map((g) => g.game_pk));
    feedGames = (live || []).filter((g) => liveOnPks.has(g.game_pk));
    renderFeedSubtabs(feedGames);
    renderFeedPanes(feedGames);
  }

  function initFeed() {
    pollFeed();
    setInterval(pollFeed, FEED_POLL_MS);
  }

  // ── database tables (raw GET /admin/tables/preview) ───────────────────
  function dbTableHtml(name, t) {
    if (t.error) {
      return `
        <div class="feed-section">
          <div class="feed-section-title">${esc(name)}</div>
          <div class="feed-empty">${esc(t.error)}</div>
        </div>`;
    }
    if (!t.rows.length) {
      return `
        <div class="feed-section">
          <div class="feed-section-title">${esc(name)} (0)</div>
          <div class="feed-empty">no rows</div>
        </div>`;
    }
    const rows = t.rows.map((r) => `
      <div class="feed-tr">
        ${t.columns.map((c) => `<span>${esc(r[c] === null || r[c] === undefined
          ? "—"
          : typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c])}</span>`).join("")}
      </div>`).join("");
    return `
      <div class="feed-section">
        <div class="feed-section-title">${esc(name)} (${t.rows.length})</div>
        <div class="table-scroll">
          <div class="feed-table">
            <div class="feed-th">${t.columns.map((c) => `<span>${esc(c)}</span>`).join("")}</div>
            ${rows}
          </div>
        </div>
      </div>`;
  }

  async function pollDbTables() {
    const data = await fetchJson("/admin/tables/preview");
    const el = $("#db-tables");
    if (!data) {
      el.innerHTML = `<div class="feed-empty">no response yet from ${esc(FEED_API_BASE)}/admin/tables/preview</div>`;
      return;
    }
    el.innerHTML = Object.keys(data).map((name) => dbTableHtml(name, data[name])).join("");
  }

  function initDbTables() {
    pollDbTables();
    setInterval(pollDbTables, FEED_POLL_MS * 4);
  }

  // ── boot ─────────────────────────────────────────────────────────────
  async function init() {
    $("#year").textContent = new Date().getFullYear();
    $("#disclaimer").textContent = D.DISCLAIMER;

    const [books, picks, rec] = await Promise.all([loadBooks(), loadPicks(), loadRecord()]);

    // hero + record (confidence-building)
    renderHeroStats(rec);
    renderRecord(rec);

    // picks board: render each card once, keyed by id, then let the tabs
    // re-order/filter the grid (default tab = cross-market "best").
    allPicks = picks;
    pickCards = {};
    picks.forEach((p) => (pickCards[p.id] = pickCard(p, books)));
    buildFilters();
    renderPicks(BEST_KEY);

    // live feed: independent best-effort poll, doesn't block the rest of the page
    initFeed();
    initDbTables();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
