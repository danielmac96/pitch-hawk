"""Export a fitted v4 learner to JSON a TypeScript scorer can evaluate.

    spec = export(learner)        # plain dict, json.dumps-able
    pred = score(spec, rows)      # reference scorer over the spec

The in-game markets (per-pitch, per-PA, rest of game, live total) are
scored inside the edge functions, where Python is not available, so their
fitted models travel as data. `score` is the definition the TypeScript twin
(`supabase/functions/_shared/v4.ts`) mirrors; `tests/modeling/test_v4_export.py`
pins `score(export(m), X)` to `m.predict(X)`, and the golden fixture
`tests/fixtures/v4_trees_golden.json` pins the TypeScript to `score` at 1e-9.

Spec shape:

    {"kind", "features", "classes", "cap", "line", "model": <node>}

    node = {"op": "hgb", "trees": [[tree, ...per output], ...per iteration],
            "baseline": [..per output], "link": "sigmoid|softmax|exp|identity"}
         | {"op": "glm", "coef": [[..]], "intercept": [..], "median": [..],
            "mean": [..], "scale": [..], "link": ...}
    tree = {"f": [...], "t": [...], "l": [...], "r": [...], "m": [...], "v": [...]}
           (feature index, threshold, left, right, missing-goes-left, value;
            a leaf has f = -1)

and the post-processing that turns the node's output into the market's
prediction kind ("nb" for counts, "count_classes", "gauss", calibrators).
Inputs are rounded to float32 before scoring, exactly as the learners do.
"""

from __future__ import annotations

import math

import numpy as np

from modeling.v4 import learners as L


def _r(x: float) -> float:
    return float(x)


def _hgb(est, link: str) -> dict:  # noqa: ANN001
    trees = []
    for it in est._predictors:
        per = []
        for t in it:
            n = t.nodes
            per.append({"f": [int(x) if not leaf else -1 for x, leaf in
                              zip(n["feature_idx"], n["is_leaf"])],
                        "t": [_r(x) for x in n["num_threshold"]],
                        "l": [int(x) for x in n["left"]],
                        "r": [int(x) for x in n["right"]],
                        "m": [int(bool(x)) for x in n["missing_go_to_left"]],
                        "v": [_r(x) for x in n["value"]]})
        trees.append(per)
    base = np.asarray(est._baseline_prediction, float).ravel().tolist()
    return {"op": "hgb", "trees": trees, "baseline": base, "link": link}


def _glm(g: "L.GLM", link: str) -> dict:
    m = g.m
    coef = np.atleast_2d(m.coef_).astype(float)
    icpt = np.atleast_1d(m.intercept_).astype(float)
    return {"op": "glm", "coef": coef.tolist(), "intercept": icpt.tolist(),
            "median": np.asarray(g.med, float).tolist(),
            "mean": np.asarray(g.mu_, float).tolist(),
            "scale": np.asarray(g.sd_, float).tolist(), "link": link}


def _node(learner, kind: str) -> dict:  # noqa: ANN001
    """The fitted model of one non-wrapper learner, with its post-processing."""
    if isinstance(learner, L.GBMCountMC):
        node = _hgb(learner.m, "softmax")
        return {"model": node, "post": {"op": "count_classes",
                                        "classes": [int(c) for c in learner.m.classes_]}}
    if isinstance(learner, L.GBM):
        if kind == "gaussian":
            return {"model": _hgb(learner.m, "identity"),
                    "post": {"op": "gauss", "var": _hgb(learner.v, "identity"),
                             "scale": float(learner.scale), "lo": 0.2, "hi": 15.0}}
        link = {"binary": "sigmoid", "multiclass": "softmax", "count": "exp"}[kind]
        node = _hgb(learner.m, link)
        if kind == "binary":
            node["select"] = 1  # predict_proba[:, 1]; sklearn's binary HGB has one output
        post = {"op": "nb", "alpha": float(learner.alpha)} if kind == "count" else None
        if kind == "multiclass":
            post = {"op": "classes", "classes": [int(c) for c in learner.m.classes_]}
        return {"model": node, "post": post}
    if isinstance(learner, L.GLM):
        link = {"binary": "sigmoid", "multiclass": "softmax", "count": "exp",
                "gaussian": "identity"}[kind]
        node = _glm(learner, link)
        post = None
        if kind == "count":
            post = {"op": "nb", "alpha": float(learner.alpha)}
        elif kind == "gaussian":
            post = {"op": "const_sigma", "sigma": float(learner.sd)}
        elif kind == "multiclass":
            post = {"op": "classes", "classes": [int(c) for c in learner.m.classes_]}
        return {"model": node, "post": post}
    raise TypeError(f"cannot export {type(learner).__name__}")


def export(learner) -> dict:  # noqa: ANN001
    md = learner.md
    cal = None
    inner = learner
    if isinstance(learner, L.Calibrated):
        cal, inner = learner.cal, learner.m
    if isinstance(inner, L.Tuned):
        inner = inner.m
    nd = _node(inner, md.kind)
    return {"kind": md.kind, "market": md.name, "features": list(inner.feats),
            "classes": list(md.classes), "cap": md.cap, "line": md.line,
            "model": nd["model"], "post": nd["post"], "calibrator": cal}


# ── reference scorer ────────────────────────────────────────────────────────

def _raw_hgb(node: dict, X: np.ndarray) -> np.ndarray:
    n = len(X)
    out = np.tile(np.asarray(node["baseline"], float), (n, 1))
    for it in node["trees"]:
        for k, t in enumerate(it):
            f, th, le, ri, mi, va = (t["f"], t["t"], t["l"], t["r"], t["m"], t["v"])
            for i in range(n):
                j = 0
                while f[j] >= 0:
                    x = X[i, f[j]]
                    if x != x:
                        j = le[j] if mi[j] else ri[j]
                    elif x <= th[j]:
                        j = le[j]
                    else:
                        j = ri[j]
                out[i, k] += va[j]
    return out


def _raw_glm(node: dict, X: np.ndarray) -> np.ndarray:
    med, mu, sd = (np.asarray(node[k], float) for k in ("median", "mean", "scale"))
    Z = (np.where(np.isnan(X), med, X) - mu) / sd
    return Z @ np.asarray(node["coef"], float).T + np.asarray(node["intercept"], float)


def _link(node: dict, raw: np.ndarray) -> np.ndarray:
    link = node["link"]
    if link == "sigmoid":
        return 1 / (1 + np.exp(-raw[:, 0]))
    if link == "softmax":
        z = raw - raw.max(axis=1, keepdims=True)
        e = np.exp(z)
        return e / e.sum(axis=1, keepdims=True)
    if link == "exp":
        return np.exp(raw[:, 0])
    return raw[:, 0]


def _eval(node: dict, X: np.ndarray) -> np.ndarray:
    raw = _raw_hgb(node, X) if node["op"] == "hgb" else _raw_glm(node, X)
    return _link(node, raw)


def score(spec: dict, X: np.ndarray) -> np.ndarray:
    """X: (n, len(spec['features'])) in spec order, NaN = missing."""
    X = np.asarray(X, np.float32).astype(np.float64)
    kind, post, cap = spec["kind"], spec.get("post"), spec.get("cap") or 0
    out = _eval(spec["model"], X)
    if post and post["op"] in ("classes", "count_classes"):
        K = len(spec["classes"]) if post["op"] == "classes" else cap + 1
        floor = 1e-6 if post["op"] == "classes" else 1e-5
        full = np.full((len(X), K), floor)
        full[:, np.asarray(post["classes"], int)] = out
        out = full / full.sum(axis=1, keepdims=True)
    elif post and post["op"] == "nb":
        out = L.nb_pmf(out, post["alpha"], cap)
    elif post and post["op"] == "gauss":
        sd = np.sqrt(np.exp(_eval(post["var"], X))) * post["scale"]
        out = np.column_stack([out, np.clip(sd, post["lo"], post["hi"])])
    elif post and post["op"] == "const_sigma":
        out = np.column_stack([out, np.full(len(X), post["sigma"])])
    c = spec.get("calibrator")
    if c:
        if "a" in c:
            p = np.clip(out, 1e-6, 1 - 1e-6)
            out = 1 / (1 + np.exp(-(c["a"] + c["b"] * np.log(p / (1 - p)))))
        elif "sigma_scale" in c:
            out = np.column_stack([out[:, 0], out[:, 1] * c["sigma_scale"]])
        else:
            q = np.exp(np.log(np.clip(out, 1e-9, 1)) / c["temperature"])
            out = q / q.sum(axis=1, keepdims=True)
    return out


def size_kb(spec: dict) -> float:
    import json
    return len(json.dumps(spec, separators=(",", ":"))) / 1024
