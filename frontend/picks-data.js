// ════════════════════════════════════════════════════════════════════════
// picks-data.js — Mock data for the consumer picks site.
//
// Shapes here intentionally mirror the backend so the UI can swap to live
// data with minimal change:
//   • A pick row mirrors GET /edge/{game_pk} rows (market, recommendation,
//     line, price, edge, confidence) plus presentation fields (matchup,
//     pitcher/batter, supporting bullets, settle status).
//   • BOOKS mirrors GET /sportsbooks (key/name/short/url/affiliate_configured).
//   • RECORD is the track-record summary a future GET /record would return.
//
// Until those endpoints serve a curated "today's picks" feed, site.js renders
// this module and falls back to it if the API is unreachable. Everything is
// illustrative sample data — not real odds, not betting advice.
// ════════════════════════════════════════════════════════════════════════

window.PICKS_DATA = (function () {
  // ── Markets (mirror backend keys) ────────────────────────────────────
  const MARKETS = {
    ab_result:      { key: "ab_result",      label: "At-Bat Result",   group: "At-Bat" },
    ab_pitches_ou:  { key: "ab_pitches_ou",  label: "Pitches in AB",   group: "At-Bat" },
    pitch_speed_ou: { key: "pitch_speed_ou", label: "Next Pitch Speed", group: "Pitch" },
    pitch_result:   { key: "pitch_result",   label: "Next Pitch Result", group: "Pitch" },
  };

  // ── Sportsbooks (mirror GET /sportsbooks; affiliate_configured=false
  //    until a real affiliate id is set in the backend env) ─────────────
  const BOOKS = {
    draftkings: { key: "draftkings", name: "DraftKings", short: "DK",
      url: "https://sportsbook.draftkings.com/leagues/baseball/mlb", affiliate_configured: false },
    fanduel:    { key: "fanduel", name: "FanDuel", short: "FD",
      url: "https://sportsbook.fanduel.com/navigation/mlb", affiliate_configured: false },
    caesars:    { key: "caesars", name: "Caesars", short: "CZR",
      url: "https://sportsbook.caesars.com/us/bet/baseball", affiliate_configured: false },
    bet365:     { key: "bet365", name: "bet365", short: "B365",
      url: "https://www.bet365.com/#/AS/B16/", affiliate_configured: false },
  };

  const DISCLAIMER =
    "21+ and present in a state where betting is legal. Odds are illustrative and " +
    "change constantly at the book — confirm the live price before wagering. Not " +
    "financial advice. If you or someone you know has a gambling problem, call " +
    "1-800-GAMBLER.";

  // ── Today's picks ────────────────────────────────────────────────────
  // edge & confidence are 0..1. price is American odds. units is the staked
  // size we publish for track-record honesty (1u flat by default here).
  const PICKS = [
    {
      id: "p1",
      market: "ab_result",
      pick: "Strikeout",
      line: null,
      price: -115,
      confidence: 0.64,
      edge: 0.082,
      units: 1,
      book: "draftkings",
      status: "pending",
      game: { away: "NYY", home: "BOS", venue: "Fenway Park", first_pitch: "7:10 PM ET" },
      pitcher: { name: "Gerrit Cole", hand: "R", note: "2.71 ERA · 33% K%" },
      batter:  { name: "Rafael Devers", hand: "L", note: "29% K vs RHP this yr" },
      bullets: [
        "Cole is running a 33% strikeout rate over his last 6 starts, top-5 among qualified RHP.",
        "Devers strikes out 29% of the time vs right-handed pitching — well above his career mark.",
        "Platoon edge: Cole's slider has a 41% whiff rate vs left-handed bats in 2-strike counts.",
        "Fenway plays neutral for strikeouts; weather is calm with no wind aiding contact.",
        "Model projects 64% strikeout probability vs a -115 line that implies 53.5% — an 8.2% edge.",
      ],
    },
    {
      id: "p2",
      market: "pitch_speed_ou",
      pick: "Over 97.5",
      line: 97.5,
      price: -110,
      confidence: 0.61,
      edge: 0.064,
      units: 1,
      book: "fanduel",
      status: "pending",
      game: { away: "LAD", home: "SFG", venue: "Oracle Park", first_pitch: "9:45 PM ET" },
      pitcher: { name: "Tyler Glasnow", hand: "R", note: "avg FB 97.9 mph" },
      batter:  { name: "Patrick Bailey", hand: "S", note: "" },
      bullets: [
        "Glasnow's four-seam averages 97.9 mph and ticks up early in counts.",
        "First-pitch fastball rate of 58% makes a heater the likeliest next-pitch type here.",
        "Velocity holds in cool SF night air — no fatigue signal through 70 pitches.",
        "Line of 97.5 sits below his season average; model lands at 61% to clear it.",
      ],
    },
    {
      id: "p3",
      market: "ab_pitches_ou",
      pick: "Under 4.5",
      line: 4.5,
      price: -105,
      confidence: 0.59,
      edge: 0.051,
      units: 1,
      book: "caesars",
      status: "pending",
      game: { away: "HOU", home: "SEA", venue: "T-Mobile Park", first_pitch: "10:10 PM ET" },
      pitcher: { name: "Logan Gilbert", hand: "R", note: "62% first-pitch strikes" },
      batter:  { name: "Jose Altuve", hand: "R", note: "swings early, 3.6 P/PA" },
      bullets: [
        "Altuve is one of the most aggressive hitters in baseball at 3.6 pitches per plate appearance.",
        "Gilbert pounds the zone early — 62% first-pitch strike rate keeps counts short.",
        "Both profiles point to a quick at-bat; model gives Under 4.5 a 59% chance.",
        "Day-game fatigue not a factor; this is an early-inning matchup.",
      ],
    },
    {
      id: "p4",
      market: "ab_result",
      pick: "Hit",
      line: null,
      price: +135,
      confidence: 0.47,
      edge: 0.043,
      units: 1,
      book: "bet365",
      status: "pending",
      game: { away: "ATL", home: "PHI", venue: "Citizens Bank Park", first_pitch: "7:05 PM ET" },
      pitcher: { name: "Ranger Suárez", hand: "L", note: "soft contact, low K" },
      batter:  { name: "Ronald Acuña Jr.", hand: "R", note: ".330 vs LHP" },
      bullets: [
        "Acuña hits .330 with a .390 xwOBA against left-handed pitching this season.",
        "Suárez is a low-strikeout, contact-allowing lefty — favorable for a hit prop.",
        "Citizens Bank Park is a hitter-friendly park, boosting BABIP on hard contact.",
        "At +135 the market implies 42.6%; model sees 47% — a +EV underdog hit.",
      ],
    },
    {
      id: "p5",
      market: "pitch_result",
      pick: "Strike or Foul",
      line: null,
      price: -130,
      confidence: 0.58,
      edge: 0.025,
      units: 1,
      book: "draftkings",
      status: "pending",
      game: { away: "SD", home: "AZ", venue: "Chase Field", first_pitch: "9:40 PM ET" },
      pitcher: { name: "Yu Darvish", hand: "R", note: "0-2 count, 6-pitch mix" },
      batter:  { name: "Corbin Carroll", hand: "L", note: "protects in 2 strikes" },
      bullets: [
        "Darvish is ahead 0-2 with his full arsenal available — expect a chase pitch.",
        "Carroll expands the zone in two-strike counts, raising whiff/foul probability.",
        "Model leans Strike-or-Foul at 58% vs an implied 56.5% — a thin but positive edge.",
      ],
    },
    {
      id: "p6",
      market: "ab_result",
      pick: "Walk",
      line: null,
      price: +260,
      confidence: 0.31,
      edge: 0.038,
      units: 0.5,
      book: "fanduel",
      status: "pending",
      game: { away: "NYM", home: "WSH", venue: "Nationals Park", first_pitch: "7:05 PM ET" },
      pitcher: { name: "MacKenzie Gore", hand: "L", note: "11% BB rate" },
      batter:  { name: "Juan Soto", hand: "L", note: "elite plate discipline" },
      bullets: [
        "Soto runs one of the lowest chase rates in MLB — a walk magnet against wild lefties.",
        "Gore's 11% walk rate is among the highest for qualified starters this year.",
        "Half-unit play: high-variance prop, but +260 well above the model's 31% (implied 27.8%).",
      ],
    },
  ];

  // ── Track record (mirror a future GET /record) ───────────────────────
  // Settled history that lets visitors verify the picks before trusting them.
  const RECORD = {
    updated: "2026-06-16",
    overall: { wins: 312, losses: 248, pushes: 19, units: 41.6, roi: 7.2, picks: 579 },
    last30:  { wins: 41, losses: 31, pushes: 3, units: 6.8, roi: 9.1, picks: 75 },
    byMarket: [
      { market: "ab_result",      label: "At-Bat Result",    wins: 121, losses: 96, pushes: 4,  units: 18.4, roi: 8.3 },
      { market: "pitch_speed_ou", label: "Next Pitch Speed", wins: 84,  losses: 67, pushes: 0,  units: 9.1,  roi: 6.0 },
      { market: "ab_pitches_ou",  label: "Pitches in AB",    wins: 71,  losses: 58, pushes: 12, units: 7.2,  roi: 5.6 },
      { market: "pitch_result",   label: "Next Pitch Result", wins: 36, losses: 27, pushes: 3,  units: 6.9,  roi: 11.0 },
    ],
    // Most recent settled picks — the proof points.
    recent: [
      { date: "2026-06-16", matchup: "TOR @ CLE", pick: "Vladimir Guerrero Jr. — Strikeout", market: "ab_result",      price: -120, units: 1, result: "win" },
      { date: "2026-06-16", matchup: "MIA @ CHC", pick: "Next Pitch Over 95.5",              market: "pitch_speed_ou", price: -110, units: 1, result: "win" },
      { date: "2026-06-16", matchup: "BAL @ TB",  pick: "Gunnar Henderson — Hit",            market: "ab_result",      price: +140, units: 1, result: "loss" },
      { date: "2026-06-15", matchup: "STL @ MIL", pick: "Pitches in AB Under 4.5",           market: "ab_pitches_ou",  price: -105, units: 1, result: "win" },
      { date: "2026-06-15", matchup: "KC @ MIN",  pick: "Bobby Witt Jr. — Strikeout",        market: "ab_result",      price: +105, units: 1, result: "win" },
      { date: "2026-06-15", matchup: "TEX @ LAA", pick: "Next Pitch Strike or Foul",         market: "pitch_result",   price: -125, units: 1, result: "push" },
      { date: "2026-06-14", matchup: "BOS @ NYY", pick: "Aaron Judge — Walk",                market: "ab_result",      price: +240, units: 0.5, result: "loss" },
      { date: "2026-06-14", matchup: "SF @ COL",  pick: "Pitches in AB Over 4.5",            market: "ab_pitches_ou",  price: -110, units: 1, result: "win" },
    ],
  };

  return { MARKETS, BOOKS, DISCLAIMER, PICKS, RECORD };
})();
