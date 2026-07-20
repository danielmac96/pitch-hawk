// ════════════════════════════════════════════════════════════════════════
// copy.js — every positioning-sensitive user-facing string in one place.
//
// The app reads window.NP_COPY, never inline literals, for anything that
// carries brand voice or product positioning (hero, tabs, promos, footer,
// disclaimers). Micro-labels that are pure data vocabulary (column headers,
// B/S/O, pitch types) stay inline in nextpitch.js.
//
// Two voices live here:
//   • The base strings position NextPitch as a live analytics board.
//   • WAGERING_OVERRIDES restores the odds/edge/picks framing and its
//     compliance copy; they apply only when NP_FEATURES.wageringInsights is
//     on (see config.js), so the whole repositioning is a one-flag flip.
//
// Loads after config.js and before nextpitch.js.
// ════════════════════════════════════════════════════════════════════════
window.NP_COPY = (function () {
  var C = {
    // header
    tabs: [["home", "Home"], ["live", "Live Board"], ["data", "Data Feed"]],

    // home · hero
    heroBadge: "MLB · Live At-Bat Analytics",
    heroTitle: "The next pitch, called before it's thrown.",
    heroSub:
      "Live pitch-by-pitch data with model-predicted probabilities for every " +
      "at-bat. The board wakes at first pitch and follows every game as it unfolds.",
    heroCta: "Open the live board →",
    heroCompliance: null, // no betting content on the page → no 21+ line

    // home · today's games
    slateTitle: "Today's games",
    slateSub: "Live now first, then up next, then finals — live model reads open with each game window.",

    // home · live-board promo
    promoBadge: "The live board",
    promoTitle: "Watch the game with the model open.",
    promoSub:
      "Real-time reads on every live at-bat — model probabilities, the " +
      "pitch-by-pitch feed, and the broadcast situation at a glance.",
    promoBullets: [
      ["Live at-bat panels", "One panel per game — the count, bases, and the model's read on the next pitch."],
      ["Pitch-by-pitch feed", "Type, velo and result next to predicted speed and strike / ball / in-play probabilities."],
      ["Broadcast situation", "Bases, balls, strikes, outs, score and the model call in a single glance."],
    ],

    // home · how it works
    howTitle: "How it works",
    steps: [
      ["1", "Ingest", "Historical Statcast plus a live MLB feed give us pitch-by-pitch context for every matchup."],
      ["2", "Model", "Dedicated models project the next pitch and at-bat in real time, updating with every pitch."],
      ["3", "Watch", "Every live at-bat gets a model read — probabilities and projections stream to the live board."],
      ["4", "Grade", "Every call is checked against what actually happened, building an open accuracy record."],
    ],

    // live board
    liveTitle: "Live board",
    liveSub: "One panel per live at-bat — game state on the left, the model's pitch-by-pitch read on the right.",
    edgeLegend: null, // wagering-only: explains edge-vs-source highlighting

    // data feed
    dataTitle: "Data feed",
    dataSub: "Pitch-by-pitch and at-bat data, straight from the live feed.",

    // footer
    footerDisclaimer:
      "Live MLB data with model-driven projections, for information and " +
      "entertainment only. Projections are model output, not guarantees. " +
      "Not affiliated with MLB.",
  };

  var WAGERING_OVERRIDES = {
    tabs: [["home", "Home"], ["live", "Live Markets"], ["data", "Data Feed"]],
    heroBadge: "MLB · At-Bat Markets",
    heroSub:
      "Live pitch-by-pitch data with model-predicted probabilities for every " +
      "at-bat. The board wakes at first pitch and follows every game — odds " +
      "comparison and graded picks are on the way.",
    heroCompliance: "21+ · For entertainment · 1-800-GAMBLER",
    promoBullets: [
      ["Live at-bat panels", "One panel per game — the count, bases, and the model's read on the next pitch."],
      ["Pitch-by-pitch feed", "Type, velo and result next to predicted speed and strike / ball / in-play odds."],
      ["Broadcast situation", "Bases, balls, strikes, outs, score and the model call in a single glance."],
    ],
    steps: [
      ["1", "Ingest", "Historical Statcast plus a live MLB feed give us pitch-by-pitch context for every matchup."],
      ["2", "Model", "Per-market models project the next pitch and at-bat in real time, updating with every pitch."],
      ["3", "Watch", "Every live at-bat gets a model read — probabilities and projections stream to the live board."],
      ["4", "Next up", "Live odds comparison, +EV picks, and a public graded record are on the way."],
    ],
    liveTitle: "Live markets",
    edgeLegend: "Model reads with an edge ≥ {threshold} against your selected sources are highlighted.",
    footerDisclaimer:
      "Live MLB data with model-driven projections, for information and " +
      "entertainment only — nothing here is betting advice. 21+ where betting " +
      "is legal. Gambling problem? Call 1-800-GAMBLER.",
  };

  if (window.NP_FEATURES && window.NP_FEATURES.wageringInsights) {
    Object.assign(C, WAGERING_OVERRIDES);
  }
  return C;
})();
