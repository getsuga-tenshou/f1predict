"""Second stage: online (walk-forward) pooling + calibration of base-model predictions.

Every second-stage parameter is fitted only on *out-of-sample* base predictions of races that were
already run when the target race is predicted — never on the evaluation race, never in-sample.

    p_i  ∝  exp( sum_m w_m * log p_im )          geometric pool; sum(w) doubles as inverse temperature
    p_i' = (1 - eps) * p_i + eps * f_i            floor: f = a robust fallback distribution

The fallback keeps informed probability on surprise winners (e.g. a fast car that took a grid
penalty), which a uniform floor cannot do. Recent races can be up-weighted (half-life in races,
chosen on the validation seasons) so the pool tracks how predictable the current era is.

For an h-step-ahead forecast the history is the races already run at the *as-of* date, not at the
target race's date.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import minimize

from f1predict.models.base import group_index

KEYS = ["race_id", "driver_id"]


def align(preds: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Wide table of member probabilities (columns p__<name>) on the rows all members share."""
    names = list(preds)
    first = preds[names[0]]
    base = first[KEYS + ["date", "year", "round", "is_winner"] + (["asof_date"] if "asof_date" in first else [])]
    wide = base.copy()
    for n in names:
        wide = wide.merge(preds[n][KEYS + ["p"]].rename(columns={"p": f"p__{n}"}), on=KEYS, how="inner")
    return wide.sort_values(["date", "race_id", "driver_id"]).reset_index(drop=True)


@dataclass
class StackParams:
    members: tuple[str, ...]
    primary: str  # prior: all weight on this member at temperature 1
    fallback: str | None = None  # None -> uniform floor
    halflife: float = 60.0  # recency half-life of the second-stage fit, in races
    prior_sd: float = 0.5  # Gaussian prior on weights (per race of evidence)
    prior_races: float = 20.0  # strength of the prior, in races
    max_eps: float = 0.3
    min_races: int = 10


def _combine(logp: np.ndarray, w: np.ndarray, eps: float, fb: np.ndarray, codes, starts) -> np.ndarray:
    s = logp @ w
    mx = np.maximum.reduceat(s, starts)[codes]
    e = np.exp(s - mx)
    p = e / np.add.reduceat(e, starts)[codes]
    return (1 - eps) * p + eps * fb


def _fallback(wide: pd.DataFrame, name: str | None) -> np.ndarray:
    if name is None:
        return 1.0 / wide.groupby("race_id", sort=False)["race_id"].transform("size").to_numpy()
    return wide[f"p__{name}"].to_numpy()


def fit_stack(hist: pd.DataFrame, sp: StackParams) -> tuple[np.ndarray, float]:
    """MAP fit of (weights, eps) on historical out-of-sample rows (`hist`, contiguous races)."""
    M = len(sp.members)
    w0 = np.array([1.0 if m == sp.primary else 0.0 for m in sp.members])
    if hist["race_id"].nunique() < sp.min_races:
        return w0, 0.0
    logp = np.log(np.clip(hist[[f"p__{m}" for m in sp.members]].to_numpy(), 1e-12, None))
    fb = _fallback(hist, sp.fallback)
    y = hist["is_winner"].to_numpy(dtype=bool)
    codes, starts = group_index(hist["race_id"].to_numpy())
    n_races = len(starts)
    age = (n_races - 1 - np.arange(n_races))[codes[y]]  # 0 = most recent race
    rw = 0.5 ** (age / sp.halflife)
    tau = sp.prior_races / (sp.prior_sd**2)

    def obj(theta):
        w, eps = theta[:M], theta[M]
        p = _combine(logp, w, eps, fb, codes, starts)
        nll = -(rw * np.log(np.clip(p[y], 1e-12, None))).sum()
        return nll + 0.5 * tau * ((w - w0) ** 2).sum()

    theta0 = np.r_[w0, 0.02]
    bounds = [(0.0, 5.0)] * M + [(0.0, sp.max_eps)]
    res = minimize(obj, theta0, method="L-BFGS-B", bounds=bounds)
    return res.x[:M], float(res.x[M])


def apply_stack(wide: pd.DataFrame, sp: StackParams, w: np.ndarray, eps: float) -> np.ndarray:
    """Pooled probabilities for the rows of `wide` (member columns p__<name>, races contiguous)."""
    logp = np.log(np.clip(wide[[f"p__{m}" for m in sp.members]].to_numpy(), 1e-12, None))
    codes, starts = group_index(wide["race_id"].to_numpy())
    return _combine(logp, w, eps, _fallback(wide, sp.fallback), codes, starts)


def online_stack(preds: dict[str, pd.DataFrame], eval_races: list[int], sp: StackParams, refit_every: int = 1) -> pd.DataFrame:
    """Walk-forward second stage: race r is pooled with parameters fitted on races before r only."""
    wide = align(preds)
    asof_col = "asof_date" if "asof_date" in wide else "date"
    race_order = wide.drop_duplicates("race_id")[["race_id", "date", asof_col]].reset_index(drop=True)
    race_order = race_order.loc[:, ~race_order.columns.duplicated()]
    pos = {r: i for i, r in enumerate(race_order["race_id"])}
    out = []
    params = None
    for k, r in enumerate(sorted(eval_races, key=lambda x: pos[x])):
        cut = race_order.loc[pos[r], asof_col]  # only outcomes known when this forecast was issued
        if params is None or k % refit_every == 0:
            hist = wide[wide["date"] < cut]
            params = fit_stack(hist, sp)
        cur = wide[wide["race_id"] == r]
        p = apply_stack(cur, sp, params[0], params[1])
        o = cur[KEYS + ["date", "year", "round", "is_winner"]].copy()
        o["p"] = p
        o["eps"] = params[1]
        for m, w in zip(sp.members, params[0]):
            o[f"w__{m}"] = w
        out.append(o)
    return pd.concat(out, ignore_index=True)
