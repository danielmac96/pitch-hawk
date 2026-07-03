"""Collapse raw predictor outputs + odds into persistable market rows.

One row per market in the shape `_persist.insert_predictions` writes and the
frontend renders:
    {market, predicted_value, confidence, probs, recommendation,
     line, price, edge, sample_size, model_version, features_used}
"""

from __future__ import annotations

from backend.ingestion.odds_provider import calculate_edge


def _ou_row(pred: dict, predicted_value: float | None, odds: dict | None) -> dict:
    line = (odds or {}).get("line")
    row = {
        "market": pred["market"],
        "predicted_value": predicted_value,
        "confidence": pred.get("confidence"),
        "probs": None,
        "recommendation": None,
        "line": None,
        "price": None,
        "edge": None,
        "sample_size": pred.get("sample_size", 0),
        "model_version": pred.get("model_version"),
        "features_used": pred.get("features_used", []),
    }
    if line is None or predicted_value is None:
        return row
    if predicted_value > float(line):
        side, price = "over", (odds or {}).get("over_price")
    else:
        side, price = "under", (odds or {}).get("under_price")
    row.update({
        "recommendation": side,
        "line": float(line),
        "price": price,
        "edge": calculate_edge(pred.get("confidence"), price),
    })
    return row


def _argmax_row(pred: dict) -> dict:
    name, prob = max(pred["probs"].items(), key=lambda kv: kv[1])
    return {
        "market": pred["market"],
        "predicted_value": prob,
        "confidence": pred.get("confidence"),
        "probs": pred.get("probs"),
        "recommendation": name,
        "line": None,
        "price": None,
        "edge": None,
        "sample_size": pred.get("sample_size", 0),
        "model_version": pred.get("model_version"),
        "features_used": pred.get("features_used", []),
    }


def build_markets(preds: list[dict], odds_by_market: dict[str, dict]) -> list[dict]:
    rows: list[dict] = []
    for pred in preds:
        market = pred.get("market")
        if market == "pitch_speed_ou":
            rows.append(_ou_row(pred, pred.get("predicted_mph"), odds_by_market.get(market)))
        elif market == "ab_pitches_ou":
            rows.append(_ou_row(pred, pred.get("predicted_count"), odds_by_market.get(market)))
        elif "probs" in pred and pred["probs"]:
            rows.append(_argmax_row(pred))
        else:
            rows.append(_ou_row(pred, pred.get("predicted_value"), odds_by_market.get(market)))
    return rows
