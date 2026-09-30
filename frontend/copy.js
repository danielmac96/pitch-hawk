// ════════════════════════════════════════════════════════════════════════
// copy.js — every positioning-sensitive user-facing string in one place.
//
// The app reads window.PH_COPY, never inline literals, for anything that
// carries brand voice or product positioning (hero, tabs, promos, footer,
// disclaimers). Micro-labels that are pure data vocabulary (column headers,
// B/S/O, pitch types) stay inline in pitchhawk.js.
//
// Two voices live here:
//   • The base strings position Pitch Hawk as a live analytics board.
//   • WAGERING_OVERRIDES restores the odds/edge/picks framing and its
//     compliance copy; they apply only when PH_FEATURES.wageringInsights is
//     on (see config.js), so the whole repositioning is a one-flag flip.
//
// Loads after config.js and before pitchhawk.js.
// ════════════════════════════════════════════════════════════════════════
window.PH_COPY = (function () {
  var C = {
    // header
    tabs: [["home", "Home"], ["pred", "Predictions"], ["live", "Live"], ["data", "Data Feed"]],
    liveCount: "{n} game{s} live · auto-refreshing",
    noLive: "No games live right now",

    // shell · API unreachable. Worded so it cannot be read as an empty slate.
    apiDownTitle: "✗ Feed unreachable",
    apiDownBody:
      "Couldn't reach the Pitch Hawk API. This is a connection problem, not an " +
      "empty slate. Retrying on the 8-second poll.",
    apiDownLastGood: "last good update",
    apiDownNever: "no update received yet",

    // shell · ★ WATCHING row
    watchingLabel: "★ Watching",
    watchUnpin: "Stop watching",
    // A pin whose game or batter is not on today's board (yesterday's pin,
    // or projections still loading). Kept visible so it can still be removed.
    watchUnresolved: "not on today's board",

    // predictions (filled in phase 3)
    predTitle: "Predictions",
    predSub: "Every model-fair probability on today's slate, ranked by lift over the league rate.",

    // home · 2026-09 redesign
    homeTitle: "Today's slate",
    homeNoGames: "No MLB games on today's schedule. The board wakes with tomorrow's slate.",
    homeLoading: "Loading today's slate…",
    // Only reached when nothing has ever loaded; the banner above says why.
    homeUnreachable: "Couldn't reach the schedule feed. A connection problem, not an empty slate.",
    stripSubLive: "what moves right now · tap a card for its full context",
    stripSubPre: "strongest reads before first pitch across {n} games not yet final · ranked by lift",
    stripEmptyLive: "Nothing live right now. Switch to Pregame for the strongest reads before first pitch.",
    stripEmptyPre: "No pregame reads yet. Batter projections land when game-predict runs, hourly before first pitch.",
    marketsNote: "model-fair probabilities · not prices",
    finalGradedNote:
      "Graded after the final out. DNP means the batter did not bat (late scratch) " +
      "and is excluded from accuracy. Pending is never a miss.",
    lineupPending:
      "{team} lineup posts about 3 h before first pitch. Until then every batter is " +
      "scored at 4.04 xPA and re-scored each hour.",
    noProjections: "No {team} batter projections yet. They land when game-predict runs, hourly before first pitch.",
    tickLegend: "▎ tick = league rate at the batter's xPA · lift = value − tick",
    startersNote:
      "Pitcher props have no model yet. Supporting form is the 30-day rolling window, " +
      "refreshed nightly · fatigue = FB velo change at pitches 75–99.",
    // The bases diamond is always empty because the live feed carries no
    // runners. Said out loud rather than letting an empty diamond read as a
    // claim that the bases are clear.
    runnersNote: "Runners on base are not in the live feed yet — every base shown empty.",
    // The PRE value beside a live game-level call. Named so it cannot be read
    // as a second live number.
    pregameCallNote: "The call the model opened with, before first pitch — not a live number.",

    // live feed
    // The Showing selector sits above the hero, so the hero still needs no
    // title of its own -- the selected call IS the top of the page.
    liveListHint:
      "live games expand to at-bat calls · pregame games show the opening-at-bat read",
    heroNothingLive:
      "The hero returns the moment a game is in progress. Today's record is " +
      "below either way.",
    heroNoCallInGame:
      "This game is live but the model has not scored a market into the " +
      "current at-bat yet. It fills in on the next poll.",
    // Shown on a scheduled game's opening calls. Says what the numbers are and
    // what they are not: a read on a league-average hitter, because a pregame
    // call cannot know who bats first.
    openingCallNote:
      "scored against both probable starters and a league-average hitter · " +
      "per-batter reads open when the lineup posts",
    // A live or finished game whose graded rows could not be loaded. Not the
    // same as a game that was never called.
    noGradedRows:
      "No graded calls loaded for this game yet. That is a loading gap, not a " +
      "game the model said nothing about — the game lines above are unaffected.",

    // data feed
    dataTitle: "Data feed",
    dataSub: "Model performance first, then the graded record — day by day, down to the pitch.",
    dfHistoryHint: "open a day for its games, a game for its at-bats, an at-bat for pitch by pitch",
    // The server-backed game-level log below the accordion. Retitled because
    // the accordion above it is now the prediction history — this panel is a
    // different record: one row per game-level call, including the two
    // game markets the accordion has no at-bat to hang off.
    feedPanelTitle: "Game-level call log",
    feedPanelSub: "moneyline and total included · stored server-side, survives reload",
    // A day older than the raw-prediction retention horizon. Its record still
    // stands (the nightly rollup is never pruned) but the individual calls
    // behind it are gone, which is a different thing from a day with no calls.
    dfAgedOut:
      "The individual calls for this slate have aged past the prediction " +
      "retention window. The day's record above comes from the nightly rollup, " +
      "which is kept permanently.",
    // The three charts built from raw per-pitch rows. Those rows are paged one
    // slate at a time, so a multi-day window has nothing to draw them from.
    // The accordion is the record; the filters above it are a lens on the
    // analytics. Saying so stops a filtered page reading as a filtered record.
    dfHistoryUnfiltered:
      "The team, player, split and role filters scope the analytics above. The " +
      "record below follows the window only — it is the whole graded history " +
      "for these days.",
    // Entity overlay. Each note names a specific limit rather than leaving an
    // empty panel to be read as "this player has no tendencies".
    entityTeamNote:
      "Zone, chase and whiff rates are published per player, not per team — " +
      "open a batter or a pitcher for those.",
    entityNoId:
      "This name arrived without a player id, so the published profile can't " +
      "be looked up for it.",
    entityNoProfile:
      "No published 30-day profile for this player yet. Profiles need 30+ " +
      "pitches in the window and are rebuilt nightly.",
    entityScopeNote:
      "The record and the pitch outcomes above are counted from the slates " +
      "currently loaded, not from a fixed 30 days — open more days in the " +
      "Data Feed history to widen them. The tendencies are a true 30-day " +
      "window from the nightly warehouse.",
    // Profitable trends.
    trendsNote:
      "players the model has read better — or worse — than its own baseline, under the filters above",
    trendsFloorNote:
      "Ranked on win rate against the window baseline. A player needs {n} or " +
      "more graded calls to appear, so a short hot streak cannot top the table.",
    trendsStreakNote:
      "Streaks look back {d} days; a dash means no call settled in that window.",
    dfNoMatch:
      "No calls in the loaded slates match these filters. Relax one, or open " +
      "another day in the record below.",
    dfRowChartWide:
      "Built from raw per-pitch calls, which are held one slate at a time — " +
      "pick the Today window, or open a day below, to see this.",

    // shown when a view throws while rendering (see viewErrorHtml)
    viewError:
      "Something in this view failed to draw. The data behind it is fine and " +
      "the other tabs still work — this is a bug on our side, and the details " +
      "below are what we need to fix it.",

    // footer
    footerDisclaimer:
      "Live MLB data with model-driven projections, for information and " +
      "entertainment only. Projections are model output, not guarantees. " +
      "Not affiliated with MLB.",
  };

  var WAGERING_OVERRIDES = {
    tabs: [["home", "Home"], ["pred", "Predictions"], ["live", "Live Markets"], ["data", "Data Feed"]],
    footerDisclaimer:
      "Live MLB data with model-driven projections, for information and " +
      "entertainment only — nothing here is betting advice. 21+ where betting " +
      "is legal. Gambling problem? Call 1-800-GAMBLER.",
  };

  if (window.PH_FEATURES && window.PH_FEATURES.wageringInsights) {
    Object.assign(C, WAGERING_OVERRIDES);
  }
  return C;
})();
