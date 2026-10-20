"""Reference models every candidate has to beat."""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar

from f1predict.models.base import WinModel, group_softmax


class GridPrior(WinModel):
    """P(win | starting slot), estimated from training history with add-one smoothing.

    The 'pole sitter usually wins' heuristic made probabilistic. Only meaningful in pre_race mode.
    """

    name = "grid_prior"

    def __init__(self, max_slot: int = 20, alpha: float = 1.0):
        self.max_slot, self.alpha = max_slot, alpha

    def _slot(self, df: pd.DataFrame) -> np.ndarray:
        return df["grid_pos"].fillna(self.max_slot).clip(1, self.max_slot).astype(int).to_numpy()

    def fit(self, train: pd.DataFrame) -> "GridPrior":
        slot = self._slot(train)
        wins = np.bincount(slot, weights=train["is_winner"].to_numpy(dtype=float), minlength=self.max_slot + 1)
        starts = np.bincount(slot, minlength=self.max_slot + 1)
        # Smooth toward a tiny base rate so far-back slots keep a non-zero chance.
        self.rate = (wins + self.alpha * 0.01) / (starts + self.alpha)
        return self

    def predict(self, test: pd.DataFrame) -> np.ndarray:
        r = self.rate[self._slot(test)]
        return r / pd.Series(r).groupby(test["race_id"].to_numpy()).transform("sum").to_numpy()


class FeatureSoftmax(WinModel):
    """softmax(beta * feature) with beta fit by maximum likelihood — e.g. an Elo-only model."""

    def __init__(self, feature: str = "rating", sign: float = 1.0, name: str | None = None):
        self.feature, self.sign = feature, sign
        self.name = name or f"softmax[{feature}]"

    def _x(self, df: pd.DataFrame) -> np.ndarray:
        x = self.sign * df[self.feature].astype(float)
        return x.fillna(x.min()).to_numpy()

    def fit(self, train: pd.DataFrame) -> "FeatureSoftmax":
        x, y, rid = self._x(train), train["is_winner"].to_numpy(dtype=bool), train["race_id"].to_numpy()

        def nll(beta):
            p = group_softmax(beta * x, rid)
            return -np.log(np.clip(p[y], 1e-12, None)).sum()

        self.beta = minimize_scalar(nll, bounds=(0.0, 50.0), method="bounded").x
        return self

    def predict(self, test: pd.DataFrame) -> np.ndarray:
        return group_softmax(self.beta * self._x(test), test["race_id"].to_numpy())
