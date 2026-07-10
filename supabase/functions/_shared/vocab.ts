// Mirrors backend/ingestion/vocab.py — keep in sync.

export const CALL_CODE_TO_DESCRIPTION: Record<string, string> = {
  B: "ball", "*B": "ball", I: "ball", P: "ball", V: "ball",
  H: "hit_by_pitch",
  C: "called_strike", A: "called_strike",
  S: "swinging_strike", W: "swinging_strike", M: "swinging_strike", Q: "swinging_strike",
  F: "foul", T: "foul", L: "foul", O: "foul", R: "foul",
  X: "in_play", D: "in_play", E: "in_play", J: "in_play",
};

const STRIKE_FOUL = new Set(["called_strike", "swinging_strike", "foul"]);
const BALL = new Set(["ball", "hit_by_pitch"]);

export function resultCategory(description: string | null | undefined): string | null {
  if (!description) return null;
  const d = description.toLowerCase();
  if (STRIKE_FOUL.has(d)) return "strike_foul";
  if (BALL.has(d)) return "ball";
  if (d.startsWith("in_play") || d.includes("in play")) return "in_play";
  if (d.includes("strike") || d.includes("foul")) return "strike_foul";
  if (d.includes("ball") || d.includes("pitchout")) return "ball";
  return null;
}

const AB_HIT = new Set(["single", "double", "triple", "home_run"]);
const AB_WALK = new Set(["walk", "intent_walk", "hit_by_pitch"]);
const AB_K = new Set(["strikeout", "strikeout_double_play", "strikeout_triple_play"]);

export function abResultCategory(eventType: string | null | undefined): string | null {
  if (!eventType) return null;
  const e = eventType.toLowerCase();
  if (AB_K.has(e)) return "strikeout";
  if (AB_WALK.has(e)) return "walk";
  if (AB_HIT.has(e)) return "hit";
  return "out";
}

// ─────────────────────────────────────────────────────────────────────────
// Static MLB team vocabulary (30 teams, fixed set). Used to resolve ESPN and
// Kalshi feeds to an MLB team_id so odds join to games by id rather than by
// fragile nickname-substring matching. abbr = MLB abbreviation; espn = extra
// abbreviations seen in the ESPN feed; names = lowercase aliases for text-blob
// matching (Kalshi titles). Multi-word aliases first so "white sox" wins over
// a bare "sox", etc.
// ─────────────────────────────────────────────────────────────────────────
export interface TeamVocab { id: number; abbr: string; espn: string[]; names: string[]; }

export const MLB_TEAMS: TeamVocab[] = [
  { id: 108, abbr: "LAA", espn: [], names: ["los angeles angels", "angels"] },
  { id: 109, abbr: "AZ", espn: ["ARI"], names: ["arizona diamondbacks", "diamondbacks", "d-backs", "dbacks"] },
  { id: 110, abbr: "BAL", espn: [], names: ["baltimore orioles", "orioles"] },
  { id: 111, abbr: "BOS", espn: [], names: ["boston red sox", "red sox"] },
  { id: 112, abbr: "CHC", espn: [], names: ["chicago cubs", "cubs"] },
  { id: 113, abbr: "CIN", espn: [], names: ["cincinnati reds", "reds"] },
  { id: 114, abbr: "CLE", espn: [], names: ["cleveland guardians", "guardians"] },
  { id: 115, abbr: "COL", espn: [], names: ["colorado rockies", "rockies"] },
  { id: 116, abbr: "DET", espn: [], names: ["detroit tigers", "tigers"] },
  { id: 117, abbr: "HOU", espn: [], names: ["houston astros", "astros"] },
  { id: 118, abbr: "KC", espn: ["KAN"], names: ["kansas city royals", "royals"] },
  { id: 119, abbr: "LAD", espn: [], names: ["los angeles dodgers", "dodgers"] },
  { id: 120, abbr: "WSH", espn: ["WAS"], names: ["washington nationals", "nationals", "nats"] },
  { id: 121, abbr: "NYM", espn: [], names: ["new york mets", "mets"] },
  { id: 133, abbr: "ATH", espn: ["OAK"], names: ["athletics", "oakland athletics"] },
  { id: 134, abbr: "PIT", espn: [], names: ["pittsburgh pirates", "pirates"] },
  { id: 135, abbr: "SD", espn: ["SDG"], names: ["san diego padres", "padres"] },
  { id: 136, abbr: "SEA", espn: [], names: ["seattle mariners", "mariners"] },
  { id: 137, abbr: "SF", espn: ["SFG"], names: ["san francisco giants", "giants"] },
  { id: 138, abbr: "STL", espn: [], names: ["st. louis cardinals", "st louis cardinals", "cardinals"] },
  { id: 139, abbr: "TB", espn: ["TBR"], names: ["tampa bay rays", "rays"] },
  { id: 140, abbr: "TEX", espn: [], names: ["texas rangers", "rangers"] },
  { id: 141, abbr: "TOR", espn: [], names: ["toronto blue jays", "blue jays"] },
  { id: 142, abbr: "MIN", espn: [], names: ["minnesota twins", "twins"] },
  { id: 143, abbr: "PHI", espn: [], names: ["philadelphia phillies", "phillies"] },
  { id: 144, abbr: "ATL", espn: [], names: ["atlanta braves", "braves"] },
  { id: 145, abbr: "CWS", espn: ["CHW"], names: ["chicago white sox", "white sox"] },
  { id: 146, abbr: "MIA", espn: [], names: ["miami marlins", "marlins"] },
  { id: 147, abbr: "NYY", espn: [], names: ["new york yankees", "yankees"] },
  { id: 158, abbr: "MIL", espn: [], names: ["milwaukee brewers", "brewers"] },
];

const ABBR_TO_ID = new Map<string, number>();
for (const t of MLB_TEAMS) {
  ABBR_TO_ID.set(t.abbr.toUpperCase(), t.id);
  for (const e of t.espn) ABBR_TO_ID.set(e.toUpperCase(), t.id);
}
// name aliases longest-first so specific phrases win over substrings.
const NAME_ALIASES: { alias: string; id: number }[] = MLB_TEAMS
  .flatMap((t) => t.names.map((alias) => ({ alias, id: t.id })))
  .sort((a, b) => b.alias.length - a.alias.length);

export function teamIdByAbbr(abbr: string | null | undefined): number | null {
  if (!abbr) return null;
  return ABBR_TO_ID.get(abbr.trim().toUpperCase()) ?? null;
}

// Resolve a free-text blob (team name / Kalshi title) to a team_id.
export function teamIdByText(text: string | null | undefined): number | null {
  if (!text) return null;
  const s = text.toLowerCase();
  for (const { alias, id } of NAME_ALIASES) if (s.includes(alias)) return id;
  return null;
}

export function americanToProb(a: number | null | undefined): number | null {
  if (a == null) return null;
  return a >= 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

export function probToAmerican(p: number | null | undefined): number | null {
  if (p == null || p <= 0 || p >= 1) return null;
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}
