"""Model interface + shared helpers for race-grouped probability models."""

from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np
import pandas as pd


class WinModel(ABC):
    """Maps a race's entrants to a probability distribution over who wins.

    `fit` receives training rows (several races, labels present) and `predict` returns one
    probability per row of `test`, summing to 1 within each race_id.
    """

    name: str = "model"

    @abstractmethod
    def fit(self, train: pd.DataFrame) -> "WinModel": ...

    @abstractmethod
    def predict(self, test: pd.DataFrame) -> np.ndarray: ...


def group_index(race_ids) -> tuple[np.ndarray, np.ndarray]:
    """(codes, starts): integer group code per row, and start offsets (rows must be grouped contiguously)."""
    race_ids = np.asarray(race_ids)
    change = np.r_[True, race_ids[1:] != race_ids[:-1]]
    codes = np.cumsum(change) - 1
    starts = np.flatnonzero(change)
    if len(np.unique(race_ids)) != len(starts):
        raise ValueError("rows of a race must be contiguous")
    return codes, starts


def group_softmax(scores: np.ndarray, race_ids) -> np.ndarray:
    scores = np.asarray(scores, dtype=float)
    codes, starts = group_index(race_ids)
    mx = np.maximum.reduceat(scores, starts)[codes]
    e = np.exp(scores - mx)
    return e / np.add.reduceat(e, starts)[codes]


def mix_uniform(p: np.ndarray, race_ids, eps: float) -> np.ndarray:
    """(1-eps) * p + eps * uniform — guards against near-zero probability for surprise winners."""
    if eps <= 0:
        return p
    codes, starts = group_index(race_ids)
    n = np.diff(np.r_[starts, len(p)])[codes]
    return (1 - eps) * p + eps / n


class Uniform(WinModel):
    name = "uniform"

    def fit(self, train):
        return self

    def predict(self, test):
        n = test.groupby("race_id", sort=False)["race_id"].transform("size").to_numpy()
        return 1.0 / n
