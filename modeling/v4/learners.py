"""The candidate models on the v4 ladder, behind one interface.

    learner = make("i3_gbm", md, feats)
    learner.fit(train_frame)          # train_frame carries md.target + feats
    pred = learner.predict(test_frame)  # shape per modeling/v4/evaluate.py
    learner.info()                    # what was fitted, for the run record

Families per kind:

    binary      baseline group rate | incumbent | logistic | HGB classifier
    multiclass  baseline group freq | incumbent | multinomial | HGB classifier
    count       baseline group pmf  | incumbent | Poisson GLM + NB |
                HGB Poisson + NB | HGB multiclass over 0..cap
    gaussian    baseline pitcher mean + sd | GLM (ridge) + sigma |
                HGB mean + HGB log-variance

Two wrappers turn any learner into a nested-in-time variant, both using the
LAST training season as the inner validation set so nothing ever looks at
the test season:

    Tuned       small hyperparameter grid, chosen on the inner season,
                refitted on every training season
    Calibrated  calibrator fitted on the inner season's predictions of a
                model that did not see it, applied on top of the full refit
"""

from __future__ import annotations

import math
import warnings

import numpy as np
import pandas as pd

from modeling.v4 import evaluate as E
from modeling.v4.catalog import MarketDef

SEED = 20261015
GBM_DEFAULT = {"learning_rate": 0.06, "max_leaf_nodes": 31, "min_samples_leaf": 100,
               "l2_regularization": 1.0, "max_iter": 400}
GBM_GRID = (
    {"learning_rate": 0.05, "max_leaf_nodes": 31, "min_samples_leaf": 200,
     "l2_regularization": 1.0, "max_iter": 500},
    {"learning_rate": 0.05, "max_leaf_nodes": 63, "min_samples_leaf": 400,
     "l2_regularization": 3.0, "max_iter": 500},
    {"learning_rate": 0.1, "max_leaf_nodes": 15, "min_samples_leaf": 50,
     "l2_regularization": 0.0, "max_iter": 300},
    {"learning_rate": 0.03, "max_leaf_nodes": 31, "min_samples_leaf": 800,
     "l2_regularization": 5.0, "max_iter": 800},
)
NB_ALPHAS = (0.0, 0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.15, 0.2, 0.3, 0.45, 0.7, 1.0)


# ── helpers ─────────────────────────────────────────────────────────────────

def X_of(df: pd.DataFrame, feats: list[str]) -> np.ndarray:
    return df[feats].to_numpy(dtype=np.float32, na_value=np.nan) if feats else \
        np.zeros((len(df), 0), np.float32)


def y_of(df: pd.DataFrame, md: MarketDef) -> np.ndarray:
    y = df[md.target].to_numpy()
    if md.kind == "count":
        return np.minimum(y.astype(int), md.cap)
    if md.kind in ("binary", "multiclass"):
        return y.astype(int)
    return y.astype(float)


def nb_pmf(mu: np.ndarray, alpha: float, cap: int) -> np.ndarray:
    """(n, cap+1) negative binomial pmf, var = mu + alpha mu^2; last = tail.

    The same recurrence as derive.negbin_pmf and props.ts::negbinPmf,
    vectorised, so the TypeScript scorer inherits their 1e-9 parity.
    """
    mu = np.maximum(np.asarray(mu, float), 1e-6)
    n = len(mu)
    body = np.zeros((n, cap))
    if alpha < 1e-6:
        lg = np.array([math.lgamma(k + 1) for k in range(cap)])
        k = np.arange(cap)
        body = np.exp(-mu[:, None] + k[None, :] * np.log(mu)[:, None] - lg[None, :])
    else:
        r = 1.0 / alpha
        p = r / (r + mu)
        v = p ** r
        for k in range(cap):
            body[:, k] = v
            v = v * ((k + r) / (k + 1) * (1 - p))
    tail = np.clip(1 - body.sum(axis=1, keepdims=True), 0, 1)
    return np.concatenate([body, tail], axis=1)


def fit_alpha(mu: np.ndarray, y: np.ndarray, cap: int, n_max: int = 60_000) -> float:
    """Dispersion by grid NLL on a sample: moments are fragile in the tail."""
    rng = np.random.default_rng(SEED)
    if len(y) > n_max:
        i = rng.choice(len(y), n_max, replace=False)
        mu, y = mu[i], y[i]
    yc = np.minimum(y, cap)
    best = (math.inf, 0.0)
    for a in NB_ALPHAS:
        p = nb_pmf(mu, a, cap)[np.arange(len(yc)), yc]
        nll = float(-np.mean(np.log(np.clip(p, 1e-9, 1))))
        if nll < best[0]:
            best = (nll, a)
    return best[1]


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _primary(md: MarketDef, pred: np.ndarray, y: np.ndarray) -> float:
    return E.score(md.kind, pred, y, classes=md.classes, line=md.line)[E.PRIMARY[md.kind]]


def inner_split(tr: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame] | None:
    """(seasons before the last, the last training season) or None."""
    last = int(tr["season"].max())
    a, b = tr[tr["season"] < last], tr[tr["season"] == last]
    return (a, b) if len(a) and len(b) else None


# ── base class ──────────────────────────────────────────────────────────────

class Learner:
    iteration = ""
    family = ""

    def __init__(self, md: MarketDef, feats: list[str], **hp):
        self.md, self.feats, self.hp = md, list(feats), dict(hp)
        self._info: dict = {}

    def fit(self, tr: pd.DataFrame) -> "Learner":
        raise NotImplementedError

    def predict(self, te: pd.DataFrame) -> np.ndarray:
        raise NotImplementedError

    def info(self) -> dict:
        return {"iteration": self.iteration, "family": self.family,
                "features": self.feats, "hyperparams": self.hp, **self._info}


# ── baseline ────────────────────────────────────────────────────────────────

class Baseline(Learner):
    """The naive predictor: the training seasons' outcome by one group
    column (lineup slot, count state, ...), else overall."""
    iteration, family = "i0_baseline", "group_rate"

    def fit(self, tr):
        md, g = self.md, self.md.baseline_group
        y = y_of(tr, md)
        key = tr[g].to_numpy() if g and g in tr else np.zeros(len(tr))
        self.group = g if g and g in tr else None
        self._info = {"group": self.group}
        if md.kind == "binary":
            s = pd.Series(y).groupby(key).agg(["sum", "count"])
            self.table = ((s["sum"] + 2 * y.mean()) / (s["count"] + 2)).to_dict()
            self.default = float(y.mean())
        elif md.kind == "multiclass":
            K = len(md.classes)
            oh = np.eye(K)[y]
            df = pd.DataFrame(oh).groupby(key).sum() + 1.0
            self.table = {k: (r / r.sum()).to_numpy() for k, r in df.iterrows()}
            self.default = (oh.sum(0) + 1) / (oh.sum() + K)
        elif md.kind == "count":
            cap = md.cap
            oh = np.eye(cap + 1)[y]
            df = pd.DataFrame(oh).groupby(key).sum() + 0.5
            self.table = {k: (r / r.sum()).to_numpy() for k, r in df.iterrows()}
            self.default = (oh.sum(0) + 0.5) / (oh.sum() + 0.5 * (cap + 1))
        else:  # gaussian: overall, refined by the incumbent's pitcher mean
            self.mu, self.sd = float(y.mean()), float(y.std())
        return self

    def predict(self, te):
        md = self.md
        key = te[self.group].to_numpy() if self.group else np.zeros(len(te))
        if md.kind == "gaussian":
            return np.column_stack([np.full(len(te), self.mu), np.full(len(te), self.sd)])
        if md.kind == "binary":
            return np.array([self.table.get(k, self.default) for k in key], float)
        return np.stack([self.table.get(k, self.default) for k in key])


# ── incumbent (what v3 / production would say) ──────────────────────────────

class Incumbent(Learner):
    iteration, family = "i1_incumbent", "incumbent"

    def fit(self, tr):
        inc, md = self.md.incumbent, self.md
        self._info = {"style": inc.style, "label": inc.label, "cols": list(inc.cols)}
        y = y_of(tr, md)
        if inc.style == "calibrated":
            from modeling import games as G
            self.cal = G.fit_calibrator(tr[inc.cols[0]].to_numpy(float), y,
                                        self._extra(tr))
            self._info["calibrator"] = self.cal
        elif inc.style == "nb_mean":
            mu = tr[inc.cols[0]].to_numpy(float)
            ok = np.isfinite(mu)
            self.alpha = fit_alpha(mu[ok], y[ok], md.cap)
            self._info["alpha"] = self.alpha
        elif inc.style == "gauss":
            mu = tr[inc.cols[0]].to_numpy(float)
            ok = np.isfinite(mu)
            self.fill = float(np.mean(y[ok]))
            self.sd = float(np.std(y[ok] - mu[ok]))
            self._info["sigma"] = self.sd
        return self

    def _extra(self, df):
        cols = self.md.incumbent.cols[1:]
        return {c: df[c].to_numpy(float) for c in cols} or None

    def predict(self, te):
        inc, md = self.md.incumbent, self.md
        if inc.style == "calibrated":
            from modeling import games as G
            return G.apply_calibrator(self.cal, te[inc.cols[0]].to_numpy(float),
                                      self._extra(te))
        if inc.style == "prob":
            return te[inc.cols[0]].to_numpy(float)
        if inc.style == "probs":
            return te[list(inc.cols)].to_numpy(float)
        if inc.style == "pmf":
            cols = [f"{inc.cols[0]}{k}" for k in range(md.cap + 1)]
            return te[cols].to_numpy(float)
        if inc.style == "nb_mean":
            return nb_pmf(te[inc.cols[0]].to_numpy(float), self.alpha, md.cap)
        if inc.style == "gauss":
            mu = np.nan_to_num(te[inc.cols[0]].to_numpy(float), nan=self.fill)
            return np.column_stack([mu, np.full(len(te), self.sd)])
        raise ValueError(inc.style)


# ── GLM ─────────────────────────────────────────────────────────────────────

class GLM(Learner):
    iteration, family = "i2_glm", "glm"

    def _prep_fit(self, X):
        X = np.asarray(X, np.float64)  # float32 statistics would not round-trip
        self.med = np.nanmedian(X, axis=0) if len(X) else np.zeros(X.shape[1])
        self.med = np.where(np.isfinite(self.med), self.med, 0.0)
        Xf = np.where(np.isnan(X), self.med, X)
        self.mu_, self.sd_ = Xf.mean(0), Xf.std(0)
        self.sd_[self.sd_ < 1e-9] = 1.0
        return (Xf - self.mu_) / self.sd_

    def _prep(self, X):
        X = np.asarray(X, np.float64)
        return (np.where(np.isnan(X), self.med, X) - self.mu_) / self.sd_

    def fit(self, tr):
        from sklearn.linear_model import LogisticRegression, PoissonRegressor, Ridge

        md = self.md
        X, y = self._prep_fit(X_of(tr, self.feats)), y_of(tr, md)
        C = self.hp.get("C", 1.0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if md.kind in ("binary", "multiclass"):
                self.m = LogisticRegression(C=C, max_iter=400).fit(X, y)
                coef = self.m.coef_
            elif md.kind == "count":
                self.m = PoissonRegressor(alpha=1e-4, max_iter=400).fit(X, y)
                self.alpha = fit_alpha(self.m.predict(X), y, md.cap)
                self._info["nb_alpha"] = self.alpha
                coef = self.m.coef_[None, :]
            else:
                self.m = Ridge(alpha=1.0).fit(X, y)
                self.sd = float(np.std(y - self.m.predict(X)))
                self._info["sigma"] = self.sd
                coef = self.m.coef_[None, :]
        imp = np.abs(np.atleast_2d(coef)).mean(axis=0)
        order = np.argsort(-imp)[:25]
        self._info["importance"] = {self.feats[i]: round(float(imp[i]), 5) for i in order}
        self._info["importance_kind"] = "|standardised coefficient|"
        return self

    def predict(self, te):
        md, X = self.md, self._prep(X_of(te, self.feats))
        if md.kind == "binary":
            return self.m.predict_proba(X)[:, 1]
        if md.kind == "multiclass":
            return _full_proba(self.m, X, len(md.classes))
        if md.kind == "count":
            return nb_pmf(self.m.predict(X), self.alpha, md.cap)
        return np.column_stack([self.m.predict(X), np.full(len(te), self.sd)])


def _full_proba(m, X, K: int) -> np.ndarray:  # noqa: ANN001
    """predict_proba padded to every class (a fold may lack a rare one)."""
    p = m.predict_proba(X)
    out = np.full((len(X), K), 1e-6)
    out[:, m.classes_.astype(int)] = p
    return out / out.sum(axis=1, keepdims=True)


# ── gradient boosting ───────────────────────────────────────────────────────

class GBM(Learner):
    iteration, family = "i3_gbm", "hgb"

    def _est(self, kind_override: str | None = None):
        from sklearn.ensemble import HistGradientBoostingClassifier as HGC
        from sklearn.ensemble import HistGradientBoostingRegressor as HGR

        hp = {**GBM_DEFAULT, **self.hp}
        kw = dict(early_stopping=True, validation_fraction=0.1, n_iter_no_change=25,
                  random_state=SEED, **hp)
        kind = kind_override or self.md.kind
        if kind in ("binary", "multiclass", "count_mc"):
            return HGC(**kw)
        if kind == "count":
            return HGR(loss="poisson", **kw)
        return HGR(**kw)

    def fit(self, tr):
        md = self.md
        X, y = X_of(tr, self.feats), y_of(tr, md)
        if md.kind == "gaussian":
            return self._fit_gauss(tr, X, y)
        self.m = self._est().fit(X, y)
        self._info["n_iter"] = int(self.m.n_iter_)
        if md.kind == "count":
            self.alpha = fit_alpha(self.m.predict(X), y, md.cap)
            self._info["nb_alpha"] = self.alpha
        return self

    def _fit_gauss(self, tr, X, y):
        # Mean on the earlier 80% of days, log-variance on the later 20%'s
        # residuals (in-sample residuals of a boosted model are too small),
        # then the mean is refitted on everything with the same iterations.
        cut = np.quantile(tr["day"].to_numpy(), 0.8) if "day" in tr else None
        a = (tr["day"].to_numpy() <= cut) if cut is not None else \
            np.arange(len(tr)) < 0.8 * len(tr)
        m0 = self._est().fit(X[a], y[a])
        r2 = (y[~a] - m0.predict(X[~a])) ** 2
        self.v = self._est("gaussian").fit(X[~a], np.log(r2 + 1e-4))
        lv = self.v.predict(X[~a])
        # E[log chi2_1] is -1.27, so exp(lv) under-states the variance:
        # rescale so the inner-holdout mean squared z is 1.
        self.scale = float(np.sqrt(np.mean(r2 / np.exp(lv))))
        self.m = self._est().set_params(max_iter=max(int(m0.n_iter_), 10),
                                        early_stopping=False).fit(X, y)
        self._info.update({"n_iter": int(self.m.n_iter_), "sigma_scale": self.scale})
        return self

    def predict(self, te):
        md, X = self.md, X_of(te, self.feats)
        if md.kind == "binary":
            return self.m.predict_proba(X)[:, 1]
        if md.kind == "multiclass":
            return _full_proba(self.m, X, len(md.classes))
        if md.kind == "count":
            return nb_pmf(self.m.predict(X), self.alpha, md.cap)
        sd = np.sqrt(np.exp(self.v.predict(X))) * self.scale
        return np.column_stack([self.m.predict(X), np.clip(sd, 0.2, 15)])

    def permutation_importance(self, te: pd.DataFrame, n: int = 20_000,
                               top: int = 25) -> dict:
        """Mean increase in the primary metric when one feature is shuffled,
        on a sample of a frame the model never saw."""
        rng = np.random.default_rng(SEED)
        if len(te) > n:
            te = te.iloc[rng.choice(len(te), n, replace=False)]
        y = y_of(te, self.md)
        base = _primary(self.md, self.predict(te), y)
        out = {}
        for f in self.feats:
            t = te.copy()
            t[f] = rng.permutation(t[f].to_numpy())
            out[f] = round(_primary(self.md, self.predict(t), y) - base, 6)
        return dict(sorted(out.items(), key=lambda kv: -kv[1])[:top])


class GBMCountMC(GBM):
    """Count as classification over 0..cap: no distributional assumption,
    which suits under-dispersed counts (a starter's outs follow a leash, not
    a Poisson) and small supports (pitches left in a plate appearance)."""
    iteration, family = "i3m_gbm_multiclass", "hgb_count_multiclass"

    MIN_CLASS = 10

    def fit(self, tr):
        X, y = X_of(tr, self.feats), y_of(tr, self.md)
        # A value seen a handful of times cannot be learned and breaks the
        # stratified early-stopping split: fold it into the nearest common
        # value. It keeps the probability floor at predict time.
        cnt = np.bincount(y, minlength=self.md.cap + 1)
        common = np.flatnonzero(cnt >= self.MIN_CLASS)
        if len(common) and len(common) < len(np.flatnonzero(cnt)):
            near = common[np.abs(np.arange(len(cnt))[:, None] - common[None, :]).argmin(1)]
            y = near[y]
            self._info["merged_values"] = int((cnt > 0).sum() - len(common))
        self.m = self._est("count_mc").fit(X, y)
        self._info["n_iter"] = int(self.m.n_iter_)
        return self

    def predict(self, te):
        X = X_of(te, self.feats)
        p = self.m.predict_proba(X)
        out = np.full((len(X), self.md.cap + 1), 1e-5)
        out[:, self.m.classes_.astype(int)] = p
        return out / out.sum(axis=1, keepdims=True)


# ── wrappers ────────────────────────────────────────────────────────────────

class Tuned(Learner):
    """Grid search on the last training season, refit on every season."""
    iteration, family = "i5_tuned", "hgb_tuned"

    def __init__(self, md, feats, base_cls=GBM, grid=GBM_GRID, rows=None, **hp):
        super().__init__(md, feats, **hp)
        self.base_cls, self.grid, self.rows = base_cls, grid, rows

    def fit(self, tr):
        split = inner_split(tr)
        scores = []
        best = (math.inf, self.grid[0])
        if split is not None:
            a, b = split
            if self.rows and len(a) > self.rows:
                a = a.sample(self.rows, random_state=SEED)
            yb = y_of(b, self.md)
            for g in self.grid:
                s = _primary(self.md, self.base_cls(self.md, self.feats, **g).fit(a).predict(b), yb)
                scores.append({"hp": g, "inner": round(s, 6)})
                if s < best[0]:
                    best = (s, g)
        self.chosen = best[1]
        self.m = self.base_cls(self.md, self.feats, **self.chosen).fit(tr)
        self.family = self.m.family + "_tuned"
        self.hp = dict(self.chosen)
        self._info = {"grid": scores, "base": self.base_cls.__name__, **self.m._info}
        return self

    def predict(self, te):
        return self.m.predict(te)

    def permutation_importance(self, te, **kw):
        return self.m.permutation_importance(te, **kw) if hasattr(
            self.m, "permutation_importance") else {}


class Calibrated(Learner):
    """A calibrator fitted where the model has not looked.

        binary      Platt on logit p
        multiclass  temperature on log-probabilities
        count       NB: dispersion refit; pmf: temperature
        gaussian    sigma scale so the inner season's mean z^2 is 1
    """
    iteration, family = "i6_calibrated", "calibrated"

    def __init__(self, md, feats, make_base, **hp):
        super().__init__(md, feats, **hp)
        self.make_base = make_base

    def fit(self, tr):
        md = self.md
        split = inner_split(tr)
        self.cal = None
        if split is not None:
            a, b = split
            inner = self.make_base().fit(a)
            pb, yb = inner.predict(b), y_of(b, md)
            self.cal = self._fit_cal(pb, yb)
        self.m = self.make_base().fit(tr)
        self.make_base = None  # a closure: unpicklable, and not needed to predict
        self.family = f"{self.m.family}+cal"
        self._info = {"base": self.m.info(), "calibrator": self.cal}
        return self

    def _fit_cal(self, p, y):
        from scipy.optimize import minimize_scalar
        md = self.md
        if md.kind == "binary":
            from sklearn.linear_model import LogisticRegression
            lr = LogisticRegression(C=100.0).fit(_logit(p)[:, None], y)
            return {"a": float(lr.intercept_[0]), "b": float(lr.coef_[0][0])}
        if md.kind == "gaussian":
            z2 = ((y - p[:, 0]) / np.maximum(p[:, 1], 1e-3)) ** 2
            return {"sigma_scale": float(np.sqrt(np.mean(z2)))}
        # multiclass / count pmf: one temperature on log-probabilities
        lp = np.log(np.clip(p, 1e-9, 1))

        def nll(t):
            q = np.exp(lp / t)
            q /= q.sum(axis=1, keepdims=True)
            return -np.mean(np.log(np.clip(q[np.arange(len(y)), y], 1e-12, 1)))
        r = minimize_scalar(nll, bounds=(0.5, 2.5), method="bounded")
        return {"temperature": float(r.x)}

    def predict(self, te):
        p = self.m.predict(te)
        c = self.cal
        if not c:
            return p
        if "a" in c:
            return 1 / (1 + np.exp(-(c["a"] + c["b"] * _logit(p))))
        if "sigma_scale" in c:
            return np.column_stack([p[:, 0], p[:, 1] * c["sigma_scale"]])
        q = np.exp(np.log(np.clip(p, 1e-9, 1)) / c["temperature"])
        return q / q.sum(axis=1, keepdims=True)

    def permutation_importance(self, te, **kw):
        return self.m.permutation_importance(te, **kw) if hasattr(
            self.m, "permutation_importance") else {}
