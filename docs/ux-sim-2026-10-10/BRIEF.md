# Pitch Hawk — simulated user study brief (shared by all cohorts)

## The product
Pitch Hawk (repo: /home/user/pitch-hawk, vanilla-JS SPA in frontend/pitchhawk.js, pitchhawk-data.js, copy.js, pitchhawk.css)
is an MLB board: model probabilities for player props (1+ Hit, 1+ HR, 1+ H+R+RBI), pitcher lines (Ks, Outs, Hits, ER, BB),
game win prob / totals, and live per-pitch / per-at-bat calls. Tabs: Home, Predictions, Live Markets, Data Feed; plus Search, Guide, star/watchlist, alerts, Export CSV, timezone toggle.

A running copy is served at http://localhost:8787/ backed by a MOCK API (scripts/dev_mock_api.py). All numbers are invented — do NOT critique the realism of specific values; critique the UX, information architecture, what's missing, and how well a bettor can go from discovery -> analysis -> value -> pick.
Wagering surfaces are ON (localStorage "ph-feature-wagering"="true" — set it via an init script before loading if you drive the browser).

Important product facts (verified):
- The Predictions board ranks by "LIFT" = model probability minus LEAGUE rate for that spot. It does NOT show a sportsbook line, price, implied probability, no-vig fair odds, or edge vs book for player props.
- Backend has odds ingest (ESPN game totals, Kalshi moneylines, The Odds API player props behind a flag) but it is unscheduled; /edge/{game_pk} exists only for game markets. The mock does not serve /edge, so in this environment no odds render anywhere.
- Data Feed on localhost uses a labelled dev fixture ("SAMPLE DATA").

## Pre-captured screens (look at these first — they are cheap)
Directory: /tmp/claude-0/-home-user-pitch-hawk/8c56add8-8ab2-58a4-88c3-107b48c3c370/scratchpad/shots/
desk__home / desk__pred / desk__pred_m_hr / desk__live / desk__data / desk_pred_rowopen  (1440 wide)
phone__home / phone__pred / phone__pred_m_hr / phone__live / phone__data / phone_pred_rowopen (390 wide)
Each has a .png (view with Read) and a .txt (full visible text).

## Driving the app yourself (encouraged for interactions the shots don't show)
Playwright is at /opt/node-tools/node_modules/playwright; chromium: executablePath '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'.
Write scripts + screenshots ONLY under your own folder: <scratchpad>/work/<cohort-id>/. Do not edit the repo. Do not restart the server on 8787.
Useful selectors: [data-act="view"] tabs, [data-act="pOpen"] expand a prediction row, [data-act="pSort"], [data-act="mSel"]/"mToggle" market chips,
[data-act="openGame"], [data-act="pin"] star, [data-act="pExport"], [data-act="ovOpen"] search/guide overlay, [data-act="liveSel"].
Hash routes: #/home, #/pred?m=hr&team=NYY&status=live&lineup=1&min=3&sort=prob-, #/live/<pk>, #/data?tf=14&mk=batter_hit
Keep it efficient: a handful of targeted scripts, not dozens.

## Your job
Simulate the 10 personas of your cohort (each must be a distinct, named individual with: experience level (pro/amateur), bankroll/unit size,
books they use, markets they target, device, session context, and the concrete goal for THIS session — across discovery, pick analysis, value finding, pick selection).
For each persona, walk their actual journey through the UI step by step, as that person would, and record where they get stuck, confused, slowed, or fail to get value.
All users already understand basic MLB stats, analytics, and betting (odds, implied prob, vig, CLV, EV, units).

## Output (REQUIRED) — write ONE JSON file: <scratchpad>/results/<cohort-id>.json
{
 "cohort": "<id>", "cohort_summary": "...",
 "personas": [
   {"name": "...", "profile": "...", "device": "desktop|phone", "goal": "...",
    "journey": ["step 1 ...", "..."],
    "task_success": "full|partial|failed", "time_to_first_value_sec_estimate": 0,
    "would_return": "yes|maybe|no", "nps_0_10": 0,
    "quote": "one sentence in their voice",
    "pain_points": [
      {"id": "short-kebab-slug", "title": "...", "area": "predictions|home|live|datafeed|global-nav|mobile|onboarding|search|watchlist|player-detail|game-detail|pricing-odds|trust-calibration|export|performance|other",
       "severity": 1-5, "detail": "what happened and why it blocks the goal", "evidence": "screen/selector/file:line",
       "suggested_fix": "concrete UI/product change"}
    ],
    "delights": ["..."]
   }
 ],
 "top_cohort_issues": [{"id": "...", "title": "...", "personas_affected": n, "avg_severity": x, "fix": "..."}]
}
Use stable, descriptive kebab-case ids for pain points (e.g. "no-sportsbook-odds-on-props", "lift-vs-league-not-vs-market", "no-bet-slip-or-pick-tracking") so they can be merged across cohorts.
Be honest and specific; include positives. Cite file:line in frontend/ where you can. Your final message: a 10-line summary of the cohort's top issues.
