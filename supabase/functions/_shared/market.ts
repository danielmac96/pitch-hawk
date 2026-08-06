// Odds lookup and the model -> line join.
//
// Lifted out of live-poll unchanged when game-predict needed the same join for
// its pregame rows. One implementation matters here: the `model_fair` fallback
// decides what an unpriced market's edge means, and two copies of that rule
// would eventually disagree about what a stored edge is measured against.

import { svc } from "./db.ts";
import { MarketPrediction } from "./model.ts";
import { americanToProb } from "./vocab.ts";

export async function latestOdds(gamePk: number): Promise<Record<string, any[]>> {
  const { data } = await svc().from("odds")
    .select("market,outcome,line,over_price,under_price,price_american,implied_prob,source,fetched_at")
    .eq("game_pk", gamePk)
    .gte("fetched_at", new Date(Date.now() - 30 * 60_000).toISOString())
    .order("fetched_at", { ascending: false }).limit(60);
  const byMarket: Record<string, any[]> = {};
  const seen = new Set<string>();
  for (const r of data ?? []) {
    const key = `${r.market}:${r.source}:${r.outcome ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (byMarket[r.market] ??= []).push(r);
  }
  return byMarket;
}

// Join an over/under model prediction to a line. If a real book quote exists we
// price against it and edge = model - implied. If not (no book publishes
// per-pitch/per-AB lines), we fall back to a MODEL-FAIR line at even money:
// edge is then measured vs a 50% coin-flip, and the row is tagged book:
// "model_fair" so it's never mistaken for beating a real sportsbook.
export function ouJoin(
  pred: MarketPrediction, overProb: (line: number) => number, odds: any[] | undefined,
  modelFair = false,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    market: pred.market, predicted_value: pred.predicted_value,
    confidence: pred.confidence, probs: pred.probs, recommendation: null,
    line: null, price: null, edge: null, model_version: pred.model_version,
    book: null,
  };
  const quote = (odds ?? []).find((o) => o.line != null);
  if (quote && pred.predicted_value != null) {
    const line = Number(quote.line);
    const pOver = overProb(line);
    const side = pOver >= 0.5 ? "over" : "under";
    const pSide = side === "over" ? pOver : 1 - pOver;
    const price = side === "over" ? quote.over_price : quote.under_price;
    const implied = americanToProb(price);
    row.recommendation = side;
    row.line = line;
    row.price = price;
    row.book = quote.source ?? null;
    row.confidence = Math.round(pSide * 10000) / 10000;
    row.edge = implied != null ? Math.round((pSide - implied) * 10000) / 10000 : null;
    return row;
  }
  if (modelFair && pred.predicted_value != null) {
    const line = Math.round(Number(pred.predicted_value) * 2) / 2; // nearest 0.5
    const pOver = overProb(line);
    const side = pOver >= 0.5 ? "over" : "under";
    const pSide = side === "over" ? pOver : 1 - pOver;
    row.recommendation = side;
    row.line = line;
    row.price = 100; // even money
    row.book = "model_fair";
    row.confidence = Math.round(pSide * 10000) / 10000;
    row.edge = Math.round((pSide - 0.5) * 10000) / 10000; // vs 50% fair
  }
  return row;
}
