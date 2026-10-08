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
      "empty slate. Retrying automatically, a little less often each time.",
    // shell · live poller behind while games are on (GET /health data_fresh=false)
    staleTitle: "Live data delayed",
    staleBody: "The live feed has not updated recently. Everything shown is the last data received.",
    apiDownLastGood: "last good update",
    apiDownNever: "no update received yet",

    // shell · ★ WATCHING row
    watchingLabel: "★ Watching",
    watchUnpin: "Stop watching",
    // A pin whose game or batter is not on today's board (yesterday's pin,
    // or projections still loading). Kept visible so it can still be removed.
    watchUnresolved: "not on today's board",
    alertsOnTip: "Alert me when a batter I'm watching comes up or a game I'm watching swings",
    alertsOffTip: "Turn alerts off",
    alertsOnTitle: "Alerts on",
    alertsOnBody: "You'll hear about your pinned batters coming up and big swings in pinned games while this tab is open.",
    alertsFinalBody: "A game you were watching just ended.",
    alertsDenied: "notifications blocked — alerts show on this page",

    // predictions
    predTitle: "Predictions",
    predSub: "Every model-fair probability on today's slate, ranked by lift over the league rate.",
    predTableTitle: {
      hit: "1+ Hit · batter reads", hr: "1+ Home run · batter reads", hrr: "1+ Hits + Runs + RBI · batter reads",
      wp: "Win probability · games", tot: "Totals · games", sp: "Starting pitchers",
    },
    predSubBatPre: "Pregame mode: sorted by lift over the league rate at the batter's xPA",
    predSubBatLive: "Live mode: in-progress games first, then by your sort · reads froze at first pitch",
    predSubWpLive: "Live mode: biggest swing since first pitch first",
    predSubGame: "sorted by strength of the pregame read",
    predSubSp: "every starter · props reserved until modeled · supporting form served",
    predLoading: "Loading today's projections…",
    predLoadError:
      "Couldn't load today's projections. A connection problem, not an empty " +
      "slate — retrying automatically.",
    predEmptyTitle: "No predictions match these filters",
    predEmptyBody: "Lower the minimum lift, include pending lineups, or widen the status and team filters.",
    predNoneTitle: "No predictions today",
    // Off day: the tab shows the next slate (see /games is_today).
    predSubNext: "No games today. Every model-fair probability on the next slate, ranked by lift over the league rate.",
    predNoneTitleNext: "No predictions yet for the next slate",
    predNoneBody: "Nothing is scheduled, so there is nothing to rank.",

    // home · 2026-09 redesign
    homeTitle: "Today's slate",
    // Off day: Home shows the next date with games instead of an empty board.
    homeTitleNext: "Next slate",
    homeNextSub: "no games today",
    // Only reached when there is no slate in the next two weeks (offseason).
    homeNoGames: "No MLB games scheduled in the next two weeks.",
    homeLoading: "Loading today's slate…",
    // Only reached when nothing has ever loaded; the banner above says why.
    homeUnreachable: "Couldn't reach the schedule feed. A connection problem, not an empty slate.",
    stripSubLive: "what moves right now · tap a card for its full context",
    stripSubPre: "strongest reads before first pitch across {n} games not yet final · ranked by lift",
    stripEmptyLive: "Nothing live right now. Switch to Pregame for the strongest reads before first pitch.",
    stripEmptyPre:
      "No pregame reads yet. Batter reads post around 10 AM ET on game days and " +
      "re-score every hour until first pitch.",
    marketsNote: "model-fair probabilities · not prices",
    finalGradedNote:
      "Graded after the final out. DNP means the batter did not bat (late scratch) " +
      "and is excluded from accuracy. Pending is never a miss.",
    lineupPending:
      "{team} lineup posts about 3 h before first pitch. Until then every batter is " +
      "scored at 4.04 xPA and re-scored each hour.",
    noProjections: "No {team} batter reads yet. They post around 10 AM ET on game days and re-score hourly until first pitch.",
    tickLegend: "▎ tick = league rate at the batter's xPA · lift = value − tick",
    startersNote:
      "Starter props are BASE models (league rates × the starter's 30-day form, " +
      "Poisson counts): placeholders until trained models replace them. O = over the " +
      "line. Supporting form is the 30-day rolling window, refreshed nightly · fatigue = " +
      "FB velo change at pitches 75–99.",
    // The bases diamond is always empty because the live feed carries no
    // runners. Said out loud rather than letting an empty diamond read as a
    // claim that the bases are clear.
    runnersNote: "Runners on base are not in the live feed yet — every base shown empty.",
    // The PRE value beside a live game-level call. Named so it cannot be read
    // as a second live number.
    pregameCallNote: "The call the model opened with, before first pitch — not a live number.",

    // shell · search, player / team panels, guide
    searchHint: "Type a player or team — today's batters, starters and all 30 clubs.",
    searchNone: "Nothing on today's slate matches. Try a last name or a team.",
    playerNone: "No read for this player on today's slate.",
    teamNotToday: "{team} isn't on today's slate.",
    teamNoNext: "No upcoming {team} game in the schedule.",
    readsTiming: "Batter reads post around 10 AM ET on game days.",
    hintTitle: "New here?",
    hintBody:
      "Every number is a model probability set against the league rate for the " +
      "same spot — the lift is how far above or below it the model leans.",
    guideIntro:
      "Pitch Hawk publishes model probabilities for every at-bat and grades each " +
      "one against what happened. Nothing here is a price or a pick.",
    glossary: [
      ["Read", "A model probability for one outcome — a batter getting a hit, the next pitch being a ball, the home team winning."],
      ["League rate", "How often that outcome happens league-wide in the same spot. The white tick on each bar."],
      ["Lift (pts)", "The read minus the league rate, in percentage points. +8 pts means the model gives 8 points more than average."],
      ["xPA", "Expected plate appearances for the batter today, from his lineup slot. More trips to the plate, more chances."],
      ["Per-PA", "The chance per plate appearance. The game number (1+ hit) compounds it over his xPA."],
      ["30d form", "The batter's hit and home-run rate per plate appearance over the last 30 days, and what the opposing starter has allowed."],
      ["Frozen", "Pregame batter reads stop updating at first pitch, so they can be graded fairly."],
      ["Base", "A simple placeholder model (league rates × 30-day form) until a trained model replaces it."],
      ["Win prob", "The home or away team's chance to win: a pregame model before first pitch, MLB's live win probability during the game."],
      ["Calibration", "Whether reads land as often as they say. 30% reads should land about 30% of the time."],
      ["Brier skill", "How much better the reads are than always predicting the average. Above 0% is better than guessing."],
      ["Pending · DNP", "Pending is not graded yet and never counts as a miss. DNP: the batter didn't bat, so the read is voided."],
    ],

    postseasonNote:
      "Postseason: batter reads come from a regular-season model and run hot " +
      "against playoff pitching (Division Series hit reads landed 46% vs 64% " +
      "predicted). Treat hit and HR reads as optimistic.",

    // live
    // The selected game has no scored call on the current at-bat yet.
    heroNoCallInGame:
      "This game is live but the model has not scored a market into the " +
      "current at-bat yet. It fills in on the next poll.",
    liveNothingTitle: "Nothing live right now",
    liveNothingBody:
      "The live view returns the moment a game is in progress. Pregame reads " +
      "are on Home and Predictions.",
    railNoProjection:
      "No pregame projection for this batter — he was not in the lineup the model " +
      "scored, or projections have not run for this game.",
    railPropsNote: "base models · line and P(over) from league rates × 30-day form",
    railPropsNone: "props are scored for the probable starter; this pitcher has none",

    // data feed
    dataTitle: "Data Feed",
    dataSub: "How resolved predictions have landed. Pick a scenario to see the model's record on it.",
    dCaption:
      "A read lands when the model's pick happens. Each read is graded once, at the " +
      "probability it carried when the market locked. DNP reads are voided.",
    dSplitsNote:
      "Win prob and totals have no pitcher hand, batting side or lineup slot, so " +
      "these splits leave them out. Filtering on hand or side does the same.",
    dEmptyTitle: "Nothing graded for this scenario",
    dEmptyBody:
      "Widen the timeframe or clear a filter. Win prob and totals have no hand " +
      "or side, so those filters hide them.",
    dFeedEmpty: "No resolved reads for this scenario.",
    dOutage:
      "Grading was paused on {days}: the model made its calls, but they were " +
      "not graded, so those days are missing here rather than empty.",
    dAccNote:
      "Rates are calls that landed among those decided (pushes left out). Live " +
      "win prob is graded on every at-bat, so its counts are large. Pitch-speed " +
      "accuracy is the average miss in mph — lower is better.",
    dLoading: "Loading graded reads…",
    dLoadError: "Couldn't load graded reads. A connection problem, not an empty record.",
    // Production, before /graded is deployed: say so rather than draw nothing.
    dMissingTitle: "The graded-reads route isn't live yet",
    dMissingBody:
      "The Data Feed reads /api/graded, which has not been deployed to this " +
      "environment. Nothing here is estimated in the meantime.",
    // Localhost only, when /graded is missing and the dev fixture is in use.
    dFixtureNote: "SAMPLE DATA — /api/graded isn't deployed here, so this page is drawn from the dev fixture. None of these reads are real.",

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
