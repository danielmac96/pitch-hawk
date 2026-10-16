"""v4's promotion rule: when may a market's chosen model be staged?

The LAB.md protocol, extended to the incumbent and to fold stability:

  1. beats the naive baseline AND the incumbent (v3 / v2 / production
     formula) on the validation primary metric;
  2. is not worse than either on the 2026 test;
  3. calibrated on 2026: mean predicted / observed within 1 ± 0.10
     (± 0.15 for an event rarer than 15%); per class for multiclass;
     sigma coverage within [0.63, 0.73] for a Gaussian;
  4. stable: no validation fold more than STABILITY worse than the
     incumbent's same fold, so one good era cannot carry a bad one.

There is no override. A held market is the gate working.
"""

from __future__ import annotations

from modeling.v4.evaluate import PRIMARY

CAL_BAND = 0.10
CAL_BAND_RARE = 0.15
RARE = 0.15
SIGMA_BAND = (0.63, 0.73)
STABILITY = 0.05


def _rare(rate) -> bool:  # noqa: ANN001
    return rate is not None and min(rate, 1 - rate) < RARE


def judge(md, chosen: dict, baseline: dict | None, incumbent: dict | None) -> dict:  # noqa: ANN001
    key = PRIMARY[md.kind]
    reasons: list[str] = []
    notes: list[str] = []
    val, test = chosen["oos"].get(key), (chosen.get("holdout") or {}).get(key)

    for label, ref in (("baseline", baseline), ("incumbent", incumbent)):
        if not ref:
            notes.append(f"no {label} to compare")
            continue
        rv, rt = ref["oos"].get(key), (ref.get("holdout") or {}).get(key)
        if rv is not None and val is not None and not val < rv:
            reasons.append(f"validation {key} {val:.5f} does not beat {label} {rv:.5f}")
        if rt is not None and test is not None and test > rt:
            reasons.append(f"2026 {key} {test:.5f} worse than {label} {rt:.5f}")

    hold = chosen.get("holdout") or {}
    if not hold:
        reasons.append("no 2026 test")
    elif md.kind == "binary":
        band = CAL_BAND_RARE if _rare(hold.get("base_rate")) else CAL_BAND
        c = hold.get("calibration")
        if c is not None and abs(c - 1) > band:
            reasons.append(f"2026 calibration {c:.3f} outside 1 ± {band:.2f}")
    elif md.kind == "multiclass":
        for cls in md.classes:
            c, r = hold.get(f"{cls}_calibration"), hold.get(f"{cls}_rate")
            band = CAL_BAND_RARE if _rare(r) else CAL_BAND
            if c is not None and abs(c - 1) > band:
                reasons.append(f"2026 {cls} calibration {c:.3f} outside 1 ± {band:.2f}")
    elif md.kind == "count":
        c = hold.get("calibration")
        if c is not None and abs(c - 1) > CAL_BAND:
            reasons.append(f"2026 mean calibration {c:.3f} outside 1 ± {CAL_BAND:.2f}")
    elif md.kind == "gaussian":
        cov = hold.get("sigma_coverage")
        if cov is not None and not SIGMA_BAND[0] <= cov <= SIGMA_BAND[1]:
            reasons.append(f"2026 sigma coverage {cov:.3f} outside {SIGMA_BAND}")

    if incumbent:
        inc_by = {f["season"]: f.get(key) for f in incumbent["folds"]}
        for f in chosen["folds"]:
            s, v, r = f["season"], f.get(key), inc_by.get(f["season"])
            if s in (2020, 2026) or v is None or not r:
                continue
            if v > r * (1 + STABILITY):
                reasons.append(f"{s} {key} {v:.5f} is >{STABILITY:.0%} worse than "
                               f"the incumbent's {r:.5f}")
    return {"ok": not reasons, "reasons": reasons, "notes": notes}
