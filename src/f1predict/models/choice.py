"""Race-grouped discrete-choice models: conditional logit and a LightGBM with the same likelihood.

Both maximise the (optionally *exploded*, i.e. rank-ordered / Plackett-Luce) likelihood of the
finishing order: stage 1 "chooses" the winner from the full field, stage 2 the runner-up from the
rest, and so on to `depth`. Stage j's log-likelihood is weighted `stage_decay ** (j-1)`, so depth=1 is
the pure winner likelihood and deeper explosions borrow strength from the podium order.

Lower places are noisier than the win, so sharing one utility scale across stages flattens the
winner probabilities (Hausman-Ruud). Stage j therefore uses utility lambda_j * x'beta with
lambda_1 = 1: the conditional logit learns lambda_j = exp(-gamma (j-1)), the GBM takes a fixed
`stage_scale ** (j-1)`. Predictions always use the winner stage (lambda = 1).
"""

from __future__ import annotations

from dataclasses import dataclass

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.optimize import minimize

from f1predict.models.base import WinModel, group_index, group_softmax, mix_uniform


@dataclass
class Stages:
    row: np.ndarray  # index of the original row in each stage slot
    stage: np.ndarray  # stage id per slot (contiguous)
    starts: np.ndarray  # start offset of each stage
    choice: np.ndarray  # 1.0 where the slot is the chosen row
    weight: np.ndarray  # weight per stage
    level: np.ndarray  # finishing position j that each stage chooses (1 = winner)


def build_stages(race_ids, finish_pos, depth: int, stage_decay: float, race_weight=None) -> Stages:
    race_ids = np.asarray(race_ids)
    pos = np.asarray(finish_pos, dtype=float)
    _, starts = group_index(race_ids)
    ends = np.r_[starts[1:], len(race_ids)]
    rw = np.ones(len(starts)) if race_weight is None else np.asarray(race_weight, dtype=float)
    rows, stage, choice, weight, level = [], [], [], [], []
    sid = 0
    for g, (a, b) in enumerate(zip(starts, ends)):
        p = pos[a:b]
        for j in range(1, depth + 1):
            hit = np.flatnonzero(p == j)
            if len(hit) != 1:
                break
            risk = np.flatnonzero(~(p < j))  # NaN (unclassified) stays in every risk set
            rows.append(a + risk)
            stage.append(np.full(len(risk), sid))
            choice.append((risk == hit[0]).astype(float))
            weight.append(rw[g] * stage_decay ** (j - 1))
            level.append(j)
            sid += 1
    stage_arr = np.concatenate(stage)
    return Stages(
        row=np.concatenate(rows),
        stage=stage_arr,
        starts=np.flatnonzero(np.r_[True, stage_arr[1:] != stage_arr[:-1]]),
        choice=np.concatenate(choice),
        weight=np.asarray(weight),
        level=np.asarray(level),
    )


def _stage_softmax(scores_slot: np.ndarray, st: Stages) -> np.ndarray:
    mx = np.maximum.reduceat(scores_slot, st.starts)[st.stage]
    e = np.exp(scores_slot - mx)
    return e / np.add.reduceat(e, st.starts)[st.stage]


def race_time_weights(train: pd.DataFrame, halflife_years: float | None) -> np.ndarray | None:
    """Per-race weights decaying with age (relative to the newest training race)."""
    if not halflife_years:
        return None
    per_race = train.groupby("race_id", sort=False)["date"].first()
    age_years = (per_race.max() - per_race).dt.days.to_numpy() / 365.25
    return 0.5 ** (age_years / halflife_years)


class Preprocessor:
    """Median imputation + missing indicators + standardisation, fitted on training rows only."""

    def __init__(self, features: list[str]):
        self.features = list(features)

    def fit(self, df: pd.DataFrame) -> "Preprocessor":
        X = df[self.features].astype(float)
        self.medians = X.median()
        self.medians = self.medians.fillna(0.0)
        self.missing_cols = [c for c in self.features if X[c].isna().any()]
        Z = self._raw(df)
        self.mean = Z.mean(axis=0)
        self.std = Z.std(axis=0)
        self.std[self.std < 1e-9] = 1.0
        return self

    def _raw(self, df: pd.DataFrame) -> np.ndarray:
        X = df[self.features].astype(float)
        ind = X[self.missing_cols].isna().to_numpy(dtype=float)
        return np.hstack([X.fillna(self.medians).to_numpy(), ind])

    def transform(self, df: pd.DataFrame) -> np.ndarray:
        return (self._raw(df) - self.mean) / self.std

    @property
    def names(self) -> list[str]:
        return self.features + [f"{c}__missing" for c in self.missing_cols]


class ConditionalLogit(WinModel):
    """Linear (rank-ordered) conditional logit — McFadden's choice model, one choice set per race."""

    def __init__(
        self,
        features: list[str],
        l2: float = 1.0,
        depth: int = 1,
        stage_decay: float = 0.5,
        time_halflife: float | None = None,
        eps: float = 0.0,
        name: str = "condlogit",
    ):
        self.features, self.l2, self.depth, self.stage_decay = features, l2, depth, stage_decay
        self.time_halflife, self.eps, self.name = time_halflife, eps, name

    def fit(self, train: pd.DataFrame) -> "ConditionalLogit":
        train = train.sort_values(["date", "race_id"], kind="stable")
        self.prep = Preprocessor(self.features).fit(train)
        X = self.prep.transform(train)
        st = build_stages(
            train["race_id"], train["finish_pos"], self.depth, self.stage_decay, race_time_weights(train, self.time_halflife)
        )
        Xs = X[st.row]
        W = st.weight.sum()
        slot_w = st.weight[st.stage]
        slot_lvl = (st.level[st.stage] - 1).astype(float)
        learn_gamma = self.depth > 1
        nfeat = X.shape[1]

        def loss_grad(theta):
            w = theta[:nfeat]
            gamma = theta[nfeat] if learn_gamma else 0.0
            u = Xs @ w
            lam = np.exp(-gamma * slot_lvl)
            s_ = lam * u
            q = _stage_softmax(s_, st)
            mx = np.maximum.reduceat(s_, st.starts)
            lse = mx + np.log(np.add.reduceat(np.exp(s_ - mx[st.stage]), st.starts))
            chosen = np.add.reduceat(s_ * st.choice, st.starts)
            # Gaussian prior with precision `l2`, expressed per weighted race so its strength is
            # comparable across training-window sizes.
            nll = -(st.weight * (chosen - lse)).sum() / W + 0.5 * self.l2 * (w @ w) / W
            resid = slot_w * (q - st.choice)
            grad_w = Xs.T @ (resid * lam) / W + self.l2 * w / W
            if not learn_gamma:
                return nll, grad_w
            grad_g = float((resid * u * lam * -slot_lvl).sum() / W)
            return nll, np.r_[grad_w, grad_g]

        theta0 = np.zeros(nfeat + (1 if learn_gamma else 0))
        bounds = [(None, None)] * nfeat + ([(0.0, 5.0)] if learn_gamma else [])
        res = minimize(loss_grad, theta0, jac=True, method="L-BFGS-B", bounds=bounds, options={"maxiter": 1000})
        self.gamma_ = float(res.x[nfeat]) if learn_gamma else 0.0
        res.x = res.x[:nfeat]
        self.coef_ = res.x
        return self

    def scores(self, test: pd.DataFrame) -> np.ndarray:
        return self.prep.transform(test) @ self.coef_

    def predict(self, test: pd.DataFrame) -> np.ndarray:
        return mix_uniform(group_softmax(self.scores(test), test["race_id"]), test["race_id"], self.eps)

    def contributions(self, test: pd.DataFrame) -> pd.DataFrame:
        """Per-row log-odds contribution of each feature relative to the race's field average
        (missing indicators folded into their feature). Rows sum to score - mean race score."""
        z = self.prep.transform(test) * self.coef_
        z = z - pd.DataFrame(z).groupby(test["race_id"].to_numpy()).transform("mean").to_numpy()
        cols = [n.removesuffix("__missing") for n in self.prep.names]
        return pd.DataFrame(z, index=test.index, columns=self.prep.names).T.groupby(cols).sum().T

    def coefficients(self) -> pd.Series:
        return pd.Series(self.coef_, index=self.prep.names).sort_values(key=np.abs, ascending=False)


class GBMSoftmax(WinModel):
    """LightGBM trained on the conditional-logit likelihood via a custom grouped-softmax objective."""

    def __init__(
        self,
        features: list[str],
        depth: int = 1,
        stage_decay: float = 0.5,
        stage_scale: float = 0.7,
        time_halflife: float | None = None,
        eps: float = 0.0,
        n_estimators: int = 300,
        learning_rate: float = 0.03,
        num_leaves: int = 7,
        min_data_in_leaf: int = 100,
        feature_fraction: float = 0.7,
        bagging_fraction: float = 0.8,
        lambda_l2: float = 10.0,
        seed: int = 0,
        base: ConditionalLogit | None = None,
        name: str = "gbm_softmax",
    ):
        self.features, self.depth, self.stage_decay, self.stage_scale = features, depth, stage_decay, stage_scale
        self.time_halflife, self.eps, self.name = time_halflife, eps, name
        self.n_estimators = n_estimators
        # Optional linear base: trees then only learn nonlinear corrections to its scores.
        self.base = base
        self.params = {
            "learning_rate": learning_rate,
            "num_leaves": num_leaves,
            "min_data_in_leaf": min_data_in_leaf,
            "feature_fraction": feature_fraction,
            "bagging_fraction": bagging_fraction,
            "bagging_freq": 1,
            "lambda_l2": lambda_l2,
            "seed": seed,
            "verbosity": -1,
            "num_threads": 1,
        }

    def fit(self, train: pd.DataFrame) -> "GBMSoftmax":
        train = train.sort_values(["date", "race_id"], kind="stable")
        st = build_stages(
            train["race_id"], train["finish_pos"], self.depth, self.stage_decay, race_time_weights(train, self.time_halflife)
        )
        n = len(train)
        slot_w = st.weight[st.stage] / st.weight.sum() * len(st.weight)
        lam = self.stage_scale ** (st.level[st.stage] - 1).astype(float)

        def objective(preds, _data):
            q = _stage_softmax(lam * preds[st.row], st)
            grad = np.bincount(st.row, weights=slot_w * lam * (q - st.choice), minlength=n)
            hess = np.bincount(st.row, weights=slot_w * lam**2 * q * (1 - q), minlength=n)
            return grad, np.maximum(hess, 1e-6)

        init = self.base.fit(train).scores(train) if self.base is not None else None
        ds = lgb.Dataset(train[self.features].astype(float), init_score=init, free_raw_data=False)
        params = dict(self.params, objective=objective)
        self.booster = lgb.train(params, ds, num_boost_round=self.n_estimators)
        return self

    def scores(self, test: pd.DataFrame) -> np.ndarray:
        raw = self.booster.predict(test[self.features].astype(float), raw_score=True)
        return raw + self.base.scores(test) if self.base is not None else raw

    def predict(self, test: pd.DataFrame) -> np.ndarray:
        return mix_uniform(group_softmax(self.scores(test), test["race_id"]), test["race_id"], self.eps)

    def importance(self) -> pd.Series:
        return pd.Series(self.booster.feature_importance("gain"), index=self.features).sort_values(ascending=False)
