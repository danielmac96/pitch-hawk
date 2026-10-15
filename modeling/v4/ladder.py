"""The v4 candidate ladder, walk-forward, for one market.

    result = run_market(md, frame)

Every candidate is scored the same way:

    for each test season S in 2018..2026:
        fit on seasons 2016..S-1 (subsampled to md.max_train_rows)
        predict every row of S

The aggregate excludes 2020 (60 games) and 2026 (the test). Candidates are
chosen on that aggregate only; 2026 is reported for every candidate and
never consulted when choosing. The pass structure is fixed in advance:

    pass 1   i0 baseline, i1 incumbent, i2 GLM, i3 GBM, i4 GBM + stack,
             i3m GBM multiclass (count markets)
    pass 2   i5 = best GBM variant of pass 1, hyperparameters tuned
    pass 3   i6 = best of i2..i5 with a calibrator

Hyperparameters are searched at three checkpoints (2018, 2022, 2026), each
on the last season before it, and reused until the next one: honest, since
no checkpoint sees a season it is later scored on, and a third of the cost
of searching every fold.

The out-of-sample predictions of the chosen candidate ARE the backfill for
2018-2026: each row was predicted by a model that never saw its season.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from modeling.v4 import evaluate as E
from modeling.v4 import gate
from modeling.v4 import learners as L
from modeling.v4.catalog import MarketDef

FIRST_TRAIN = 2016
HOLDOUT = 2026
TEST_SEASONS = tuple(range(2018, HOLDOUT + 1))
EXCLUDE = (2020, HOLDOUT)
TUNE_CHECKPOINTS = (2018, 2022, 2026)
GBM_FAMILY = ("i3_gbm", "i4_gbm_stack", "i3m_gbm_multiclass")
MODEL_ITERATIONS = ("i2_glm",) + GBM_FAMILY + ("i5_tuned", "i6_calibrated")


def _log(msg: str) -> None:
    print(f"[v4] {msg}", flush=True)


@dataclass
class Candidate:
    iteration: str
    family: str = ""
    folds: list = field(default_factory=list)
    oos: dict = field(default_factory=dict)
    holdout: dict | None = None
    preds: dict = field(default_factory=dict)      # season -> array
    info: dict = field(default_factory=dict)       # from the 2026-fold fit
    fold_info: dict = field(default_factory=dict)  # season -> small dict
    holdout_model: object = None
    seconds: float = 0.0
    curve_test: list = field(default_factory=list)
    curve_val: list = field(default_factory=list)

    @property
    def primary(self) -> float:
        return self.oos.get("primary", np.inf)

    def as_ref(self) -> dict:
        return {"oos": self.oos, "holdout": self.holdout, "folds": self.folds}


def present(cols, frame: pd.DataFrame) -> list[str]:
    return [c for c in cols if c in frame.columns]


def _subsample(tr: pd.DataFrame, n: int) -> pd.DataFrame:
    return tr if len(tr) <= n else tr.sample(n, random_state=L.SEED)


class Ladder:
    def __init__(self, md: MarketDef, frame: pd.DataFrame, *,
                 test_seasons=TEST_SEASONS, max_train_rows: int | None = None):
        f = frame[(frame["season"] >= FIRST_TRAIN) & frame[md.target].notna()]
        self.md = md
        self.frame = f.reset_index(drop=True)
        self.seasons = [s for s in test_seasons if (self.frame["season"] == s).any()]
        self.max_rows = max_train_rows or md.max_train_rows
        self.feats = present(md.features, self.frame)
        self.stack = present(md.stack, self.frame)
        dropped = sorted(set(md.features) - set(self.feats))
        if dropped:
            _log(f"{md.name}: {len(dropped)} declared features not in the frame: "
                 f"{dropped[:12]}{' ...' if len(dropped) > 12 else ''}")
        self.y = L.y_of(self.frame, md)
        self.season = self.frame["season"].to_numpy()
        self.results: dict[str, Candidate] = {}
        self._tune_cache: dict = {}

    # ── one candidate over every fold ──────────────────────────────────────
    def walk(self, iteration: str, make, *, subsample: bool = True) -> Candidate:
        md, c = self.md, Candidate(iteration)
        t0 = time.time()
        for s in self.seasons:
            tr = self.frame[(self.season < s)]
            if subsample:
                tr = _subsample(tr, self.max_rows)
            te_mask = self.season == s
            te = self.frame[te_mask]
            learner = make(s)
            learner.fit(tr)
            p = learner.predict(te)
            m = E.score(md.kind, p, self.y[te_mask], classes=md.classes, line=md.line)
            m["season"] = int(s)
            m["primary"] = m[E.PRIMARY[md.kind]]
            m["train_rows"] = int(len(tr))
            c.folds.append(m)
            c.preds[s] = np.asarray(p, np.float32)
            inf = learner.info()
            c.family = inf.get("family", c.family)
            c.fold_info[s] = {k: inf[k] for k in ("hyperparams", "n_iter", "nb_alpha",
                                                  "calibrator", "sigma_scale")
                              if k in inf}
            if s == HOLDOUT or s == self.seasons[-1]:
                c.info, c.holdout_model = inf, learner
            _log(f"{md.name} {iteration} {s}: {E.PRIMARY[md.kind]}={m['primary']:.5f} "
                 f"(n={m['n']:,}, train={len(tr):,}, {time.time() - t0:.0f}s)")
        c.oos = E.aggregate(c.folds, EXCLUDE)
        c.oos["primary"] = c.oos.get(E.PRIMARY[md.kind], np.inf)
        hold = [f for f in c.folds if f["season"] == HOLDOUT]
        c.holdout = hold[0] if hold else None
        if HOLDOUT in c.preds:
            c.curve_test = E.curve(md.kind, c.preds[HOLDOUT], self.y[self.season == HOLDOUT],
                                   line=md.line)
        val = [s for s in self.seasons if s not in EXCLUDE]
        if val:
            vm = np.isin(self.season, val)
            vp = np.concatenate([c.preds[s] for s in self.seasons if s in val])
            vy = np.concatenate([self.y[self.season == s] for s in self.seasons if s in val])
            c.curve_val = E.curve(md.kind, vp, vy, line=md.line) if vm.any() else []
        c.seconds = round(time.time() - t0, 1)
        self.results[iteration] = c
        return c

    # ── factories ──────────────────────────────────────────────────────────
    def _cls(self, iteration: str):
        return {"i2_glm": L.GLM, "i3_gbm": L.GBM, "i4_gbm_stack": L.GBM,
                "i3m_gbm_multiclass": L.GBMCountMC}[iteration]

    def _feats(self, iteration: str) -> list[str]:
        return self.feats + self.stack if iteration in (
            "i4_gbm_stack", "i3m_gbm_multiclass", "i2_glm") else self.feats

    def _labelled(self, learner, iteration):  # noqa: ANN001
        learner.iteration = iteration
        return learner

    def _tuned_maker(self, base_it: str):
        base_cls, feats = self._cls(base_it), self._feats(base_it)
        md = self.md

        def make(s: int):
            cp = max([c for c in TUNE_CHECKPOINTS if c <= s] or [TUNE_CHECKPOINTS[0]])
            hp = self._tune_cache.get((base_it, cp))
            if hp is None:
                return _CachingTuned(md, feats, base_cls=base_cls, rows=md.tune_rows,
                                     cache=self._tune_cache, key=(base_it, cp))
            return self._labelled(base_cls(md, feats, **hp), "i5_tuned")
        return make

    # ── the ladder ─────────────────────────────────────────────────────────
    def run(self, iterations=None) -> dict:
        md = self.md
        want = set(iterations or ("i0_baseline", "i1_incumbent") + MODEL_ITERATIONS)
        if "i0_baseline" in want:
            self.walk("i0_baseline", lambda s: L.Baseline(md, []), subsample=False)
        inc = md.incumbent
        if "i1_incumbent" in want and inc is not None:
            need = ([f"{inc.cols[0]}{k}" for k in range(md.cap + 1)]
                    if inc.style == "pmf" else list(inc.cols))
            if all(c in self.frame for c in need):
                self.walk("i1_incumbent", lambda s: L.Incumbent(md, []), subsample=False)
            else:
                _log(f"{md.name}: incumbent columns missing, i1 skipped")
        for it in ("i2_glm", "i3_gbm", "i4_gbm_stack", "i3m_gbm_multiclass"):
            if it not in want:
                continue
            if it == "i4_gbm_stack" and not self.stack:
                continue
            if it == "i3m_gbm_multiclass" and not (md.kind == "count" and md.cap <= 30):
                continue
            cls, feats = self._cls(it), self._feats(it)
            self.walk(it, lambda s, cls=cls, feats=feats, it=it:
                      self._labelled(cls(md, feats), it))

        gbms = [r for k, r in self.results.items() if k in GBM_FAMILY]
        if "i5_tuned" in want and gbms:
            best = min(gbms, key=lambda r: r.primary).iteration
            self.walk("i5_tuned", self._tuned_maker(best))
            self.results["i5_tuned"].info["tuned_from"] = best

        models = [r for k, r in self.results.items() if k in MODEL_ITERATIONS[:-1]]
        if "i6_calibrated" in want and models:
            best = min(models, key=lambda r: r.primary).iteration
            maker = (self._tuned_maker(self.results["i5_tuned"].info["tuned_from"])
                     if best == "i5_tuned" else
                     (lambda s, b=best: self._labelled(self._cls(b)(md, self._feats(b)), b)))
            self.walk("i6_calibrated", lambda s: L.Calibrated(
                md, [], make_base=lambda: maker(s)))
            self.results["i6_calibrated"].info["calibrates"] = best
        return self.select()

    def select(self) -> dict:
        md = self.md
        models = [r for k, r in self.results.items() if k in MODEL_ITERATIONS]
        chosen = min(models, key=lambda r: r.primary) if models else None
        base = self.results.get("i0_baseline")
        inc = self.results.get("i1_incumbent")
        verdict = (gate.judge(md, chosen.as_ref(), base and base.as_ref(),
                              inc and inc.as_ref()) if chosen else
                   {"ok": False, "reasons": ["no model candidate ran"], "notes": []})
        _log(f"{md.name}: chosen {chosen.iteration if chosen else None}; "
             f"gate {'PASS' if verdict['ok'] else 'HOLD'} {verdict['reasons']}")
        return {"market": md.name, "chosen": chosen and chosen.iteration,
                "verdict": verdict, "results": self.results,
                "features": self.feats, "stack": self.stack}

    # ── production fit ─────────────────────────────────────────────────────
    def production_fit(self, iteration: str):  # noqa: ANN201
        """Refit the chosen recipe on every season including 2026."""
        md, s = self.md, HOLDOUT + 1
        tr = _subsample(self.frame, self.max_rows)
        if iteration == "i5_tuned":
            make = self._tuned_maker(self.results["i5_tuned"].info["tuned_from"])
        elif iteration == "i6_calibrated":
            b = self.results["i6_calibrated"].info["calibrates"]
            inner = (self._tuned_maker(self.results["i5_tuned"].info["tuned_from"])
                     if b == "i5_tuned" else
                     (lambda s_, b=b: self._labelled(self._cls(b)(md, self._feats(b)), b)))
            make = lambda s_: L.Calibrated(md, [], make_base=lambda: inner(s_))  # noqa: E731
        else:
            make = lambda s_: self._labelled(self._cls(iteration)(md, self._feats(iteration)),  # noqa: E731
                                             iteration)
        learner = make(s)
        learner.fit(tr)
        return learner


class _CachingTuned(L.Tuned):
    iteration = "i5_tuned"

    def __init__(self, md, feats, *, cache, key, **kw):
        super().__init__(md, feats, **kw)
        self.cache, self.key = cache, key

    def fit(self, tr):
        super().fit(tr)
        self.cache[self.key] = dict(self.chosen)
        return self


def run_market(md: MarketDef, frame: pd.DataFrame, **kw) -> tuple[Ladder, dict]:
    lad = Ladder(md, frame, **{k: v for k, v in kw.items()
                               if k in ("test_seasons", "max_train_rows")})
    return lad, lad.run(kw.get("iterations"))
