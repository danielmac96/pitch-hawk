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
    // TODO: when a curated GET /picks/today exists, fetch and map it here.
    return D.PICKS;
  }

  async function loadRecord() {
    // TODO: wire to GET /record once it serves graded history.
    return D.RECORD;
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

  // ── filters ──────────────────────────────────────────────────────────
  function buildFilters(picks, onPick) {
    const filters = $("#filters");
    const counts = {};
    picks.forEach((p) => (counts[p.market] = (counts[p.market] || 0) + 1));
    const tabs = [{ key: "all", label: "All", n: picks.length }].concat(
      Object.keys(counts).map((k) => ({ key: k, label: (D.MARKETS[k] || {}).label || k, n: counts[k] }))
    );

    filters.innerHTML = "";
    tabs.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "filter" + (i === 0 ? " active" : "");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.dataset.key = t.key;
      b.innerHTML = `${esc(t.label)} <span class="filter-n">${t.n}</span>`;
      b.addEventListener("click", () => {
        filters.querySelectorAll(".filter").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        onPick(t.key);
      });
      filters.appendChild(b);
    });
  }

  function applyFilter(key) {
    document.querySelectorAll(".pick-card").forEach((c) => {
      c.style.display = key === "all" || c.dataset.market === key ? "" : "none";
    });
  }

  // ── track record ─────────────────────────────────────────────────────
  function renderRecord(rec) {
    $("#record-sub").textContent =
      `Every graded pick, kept in the open. Updated ${rec.updated}.`;

    const o = rec.overall;
    const winPct = (o.wins / (o.wins + o.losses)) * 100;
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
      const wp = (m.wins / (m.wins + m.losses)) * 100;
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

  // ── boot ─────────────────────────────────────────────────────────────
  async function init() {
    $("#year").textContent = new Date().getFullYear();
    $("#disclaimer").textContent = D.DISCLAIMER;

    const [books, picks, rec] = await Promise.all([loadBooks(), loadPicks(), loadRecord()]);

    // hero + record (confidence-building)
    renderHeroStats(rec);
    renderRecord(rec);

    // picks board
    const grid = $("#picks-grid");
    grid.innerHTML = "";
    picks.forEach((p) => grid.appendChild(pickCard(p, books)));
    $("#picks-sub").textContent =
      `${picks.length} model-backed picks for ${new Date().toLocaleDateString(undefined, { month: "long", day: "numeric" })} — tap “Why this pick” for the reasoning.`;
    buildFilters(picks, applyFilter);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
