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

export function americanToProb(a: number | null | undefined): number | null {
  if (a == null) return null;
  return a >= 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

export function probToAmerican(p: number | null | undefined): number | null {
  if (p == null || p <= 0 || p >= 1) return null;
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}
