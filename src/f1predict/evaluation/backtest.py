"""Walk-forward (rolling-origin, expanding-window) backtesting.

For every evaluated race the model is fitted only on races whose date is strictly earlier, then asked
for that race's win distribution. Features are already as-of each race (see features.state), so the
backtest replays exactly what a forecaster could have known at the time.
"""

from __future__ import annotations

import os
from typing import Callable

import numpy as np
import pandas as pd
from joblib import Parallel, delayed

from f1predict.evaluation.metrics import race_scores, summarize
from f1predict.models.base import WinModel

ModelFactory = Callable[[], WinModel]


def eval_race_ids(df: pd.DataFrame, seasons, h: int = 1) -> list[int]:
    lab = df[df["has_result"] & df["year"].isin(list(seasons)) & (df["h"] == h)]
    return lab.drop_duplicates("race_id").sort_values("date")["race_id"].tolist()


def _chunks(race_ids: list[int], every: int) -> list[list[int]]:
    return [race_ids[i : i + every] for i in range(0, len(race_ids), every)]


def training_rows(df: pd.DataFrame, cutoff, train_start: int) -> pd.DataFrame:
    """Completed one-step-ahead rows of races strictly before `cutoff` (the prediction time)."""
    return df[df["has_result"] & (df["h"] == 1) & (df["date"] < cutoff) & (df["year"] >= train_start)]


def _fit_predict(factory: ModelFactory, df: pd.DataFrame, chunk: list[int], train_start: int, h: int) -> pd.DataFrame:
    test = df[df["race_id"].isin(chunk) & (df["h"] == h)]
    # Prediction time = when the state snapshot was taken (race date for h = 1, earlier for h > 1).
    cutoff = test["asof_date"].min()
    model = factory().fit(training_rows(df, cutoff, train_start))
    out = test[["race_id", "year", "round", "date", "asof_date", "h", "driver_id", "team_id", "is_winner", "finish_pos"]].copy()
    out["p"] = model.predict(test)
    return out


def walk_forward(
    factory: ModelFactory,
    df: pd.DataFrame,
    race_ids: list[int],
    train_start: int = 1990,
    refit_every: int = 1,
    n_jobs: int | None = None,
    h: int = 1,
) -> pd.DataFrame:
    """Out-of-sample predictions for `race_ids` at horizon `h`; refit every `refit_every` races."""
    n_jobs = n_jobs or max(1, (os.cpu_count() or 2) - 2)
    chunks = _chunks(race_ids, refit_every)
    parts = Parallel(n_jobs=n_jobs, backend="loky")(
        delayed(_fit_predict)(factory, df, c, train_start, h) for c in chunks
    )
    pred = pd.concat(parts, ignore_index=True)
    sums = pred.groupby("race_id")["p"].sum()
    if not np.allclose(sums, 1.0, atol=1e-6):
        raise AssertionError("predicted probabilities do not sum to 1 per race")
    return pred


def evaluate(pred: pd.DataFrame) -> tuple[dict, pd.DataFrame]:
    scores = race_scores(pred)
    return summarize(scores), scores
