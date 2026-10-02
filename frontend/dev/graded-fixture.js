// ════════════════════════════════════════════════════════════════════════
// dev/graded-fixture.js — DEVELOPMENT ONLY. Synthetic graded reads.
//
// Shaped exactly like a /api/graded row (see DATA_CONTRACT.md "GradedRead"),
// so the Data Feed can be built and checked before the route is deployed.
//
// It can never reach production: pitchhawk.js loads this file only when the
// page is served from localhost AND /api/graded answers "no route", and
// scripts/build_frontend.sh deletes dev/ from dist/. Every value here is
// invented; the page labels itself SAMPLE DATA while it is in use.
// ════════════════════════════════════════════════════════════════════════
window.PH_GRADED_FIXTURE = (function () {
  "use strict";

  const TEAMS = [
    ["NYY", 3313, "Yankee Stadium"], ["BOS", 3, "Fenway Park"], ["CHC", 17, "Wrigley Field"],
    ["SD", 2680, "Petco Park"], ["ATL", 4705, "Truist Park"], ["PHI", 2681, "Citizens Bank Park"],
    ["LAD", 22, "Dodger Stadium"], ["HOU", 2392, "Daikin Park"], ["SEA", 680, "T-Mobile Park"],
    ["MIL", 32, "American Family Field"], ["CLE", 5, "Progressive Field"], ["TOR", 14, "Rogers Centre"],
  ];
  const PITCH = { strike_foul: 0.455, ball: 0.352, in_play: 0.193 };
  const AB = { out: 0.453, hit: 0.239, strikeout: 0.221, walk: 0.087 };

  function build(today) {
    let seed = 20260930;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const dateOf = (d) => new Date(Date.parse(`${today}T12:00:00Z`) - d * 86400000).toISOString().slice(0, 10);
    const rows = [];
    let pk = 900000;

    for (let d = 0; d < 35; d += 1) {
      const date = dateOf(d);
      const order = TEAMS.slice().sort(() => rnd() - 0.5);
      for (let gi = 0; gi + 1 < order.length; gi += 2) {
        const [away] = order[gi];
        const [home, venueId, venue] = order[gi + 1];
        const gamePk = (pk += 1);
        const base = {
          game_pk: gamePk, official_date: date, away_abbr: away, home_abbr: home,
          venue_id: venueId, venue_name: venue,
        };
        const at = (h) => new Date(Date.parse(`${date}T23:00:00Z`) + h * 3600000).toISOString();
        const push = (r, h) => rows.push(Object.assign({}, base, r, { resolved_at: at(h) }));
        // Game lines, pregame.
        const pHome = 0.4 + rnd() * 0.25;
        const fav = pHome >= 0.5 ? home : away;
        const pFav = Math.max(pHome, 1 - pHome);
        push({ id: `g:ml:${gamePk}`, market: "game_moneyline", team_abbrs: [away, home],
          subject: `${fav} to win`, probability: +pFav.toFixed(4),
          result: rnd() < pFav + 0.02 ? "hit" : "miss", actual_label: null,
          opp_pitcher_hand: null, batting_side: null, lineup_slot: null,
          batter_team: null, batter_name: null, pitcher_name: null }, 3.2);
        const line = pick([7.5, 8, 8.5, 9, 9.5]);
        const pOver = 0.48 + rnd() * 0.06;
        push({ id: `g:tot:${gamePk}`, market: "game_total", team_abbrs: [away, home],
          subject: `${pOver >= 0.5 ? "Over" : "Under"} ${line}`, probability: +Math.max(pOver, 1 - pOver).toFixed(4),
          result: rnd() < 0.5 ? "hit" : "miss", actual_label: null,
          opp_pitcher_hand: null, batting_side: null, lineup_slot: null,
          batter_team: null, batter_name: null, pitcher_name: null }, 3.2);

        // Batter reads, both sides.
        [["away", away], ["home", home]].forEach(([side, team]) => {
          const hand = rnd() < 0.3 ? "L" : "R";
          const sp = `Fixture ${side === "away" ? home : away} Starter`;
          for (let slot = 1; slot <= 9; slot += 1) {
            const name = `Fixture ${team} Batter ${slot}`;
            const xpa = 4.49 - (slot - 1) * 0.13;
            const ppaH = 0.2 + rnd() * 0.1, ppaR = 0.018 + rnd() * 0.03;
            const void_ = rnd() < 0.02;
            const common = { team_abbrs: [team], subject: name, opp_pitcher_hand: hand, batting_side: side,
              lineup_slot: slot, batter_team: team, batter_name: name, pitcher_name: sp, actual_label: null };
            const pH = 1 - Math.pow(1 - ppaH, xpa), pR = 1 - Math.pow(1 - ppaR, xpa);
            push(Object.assign({ id: `p:hit:${gamePk}:${team}${slot}`, market: "batter_hit", probability: +pH.toFixed(4),
              result: void_ ? "void" : rnd() < pH + (hand === "L" ? 0.04 : -0.01) ? "hit" : "miss" }, common), 3.1);
            push(Object.assign({ id: `p:hr:${gamePk}:${team}${slot}`, market: "batter_hr", probability: +pR.toFixed(4),
              result: void_ ? "void" : rnd() < pR ? "hit" : "miss" }, common), 3.1);
          }
        });

        // A handful of at-bat and pitch calls, inside the 35-day window only.
        for (let i = 0; i < 8; i += 1) {
          const side = rnd() < 0.5 ? "away" : "home";
          const team = side === "away" ? away : home;
          const hand = rnd() < 0.3 ? "L" : "R";
          const slot = 1 + Math.floor(rnd() * 9);
          const who = { team_abbrs: [away, home], opp_pitcher_hand: hand, batting_side: side, lineup_slot: slot,
            batter_team: team, batter_name: `Fixture ${team} Batter ${slot}`,
            pitcher_name: `Fixture ${side === "away" ? home : away} Pitcher` };
          const dist = i % 2 ? AB : PITCH;
          const keys = Object.keys(dist);
          const rec = keys[0];
          const p = dist[rec] + rnd() * 0.12;
          const ok = rnd() < p;
          push(Object.assign({ id: `x:${gamePk}:${i}`, market: i % 2 ? "ab_result" : "pitch_result",
            subject: rec, probability: +p.toFixed(4), result: ok ? "hit" : "miss",
            actual_label: ok ? null : pick(keys.slice(1)) }, who), 0.2 + i * 0.3);
        }
      }
    }
    return rows.sort((a, b) => (a.resolved_at < b.resolved_at ? 1 : -1));
  }
  return build;
})();
