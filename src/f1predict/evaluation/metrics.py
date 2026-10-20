"""Probabilistic scoring of per-race win distributions."""

from __future__ import annotations

import numpy as np
import pandas as pd

EPS = 1e-12


def race_scores(pred: pd.DataFrame) -> pd.DataFrame:
    """Per-race scores. `pred` needs columns race_id, p (sums to 1 per race), is_winner.

    logloss  -log P(actual winner)                      (lower is better)
    brier    sum_i (p_i - y_i)^2 over the race's field  (lower is better)
    top1     the favourite won
    top3     the winner was among the three most likely
    rank     rank of the actual winner in the predicted order (1 = favourite)

    Ties are scored in expectation over a random tie-break (a uniform forecast gets top1 = 1/N),
    never by row order.
    """
    rows = []
    for race_id, g in pred.groupby("race_id", sort=False):
        p = g["p"].to_numpy(dtype=float)
        y = g["is_winner"].to_numpy(dtype=bool)
        if y.sum() != 1:
            continue
        pw = float(p[y][0])
        n_gt = int((p > pw).sum())
        n_eq = int((p == pw).sum())

        def top(k: int) -> float:
            return float(np.clip((k - n_gt) / n_eq, 0.0, 1.0))

        rows.append(
            {
                "race_id": race_id,
                "n": len(p),
                "p_winner": pw,
                "logloss": -np.log(max(pw, EPS)),
                "brier": float(((p - y) ** 2).sum()),
                "top1": top(1),
                "top3": top(3),
                "rank": n_gt + (n_eq + 1) / 2,
                "uniform_logloss": np.log(len(p)),
            }
        )
    return pd.DataFrame(rows)


def summarize(scores: pd.DataFrame) -> dict:
    n = len(scores)
    ll = scores["logloss"]
    return {
        "races": n,
        "logloss": float(ll.mean()),
        "logloss_se": float(ll.std(ddof=1) / np.sqrt(n)) if n > 1 else np.nan,
        "logloss_median": float(ll.median()),
        "skill_vs_uniform": float(1 - ll.mean() / scores["uniform_logloss"].mean()),
        "brier": float(scores["brier"].mean()),
        "top1": float(scores["top1"].mean()),
        "top3": float(scores["top3"].mean()),
        "mean_p_winner": float(scores["p_winner"].mean()),
    }


def calibration_table(pred: pd.DataFrame, bins=(0, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 1.0001)) -> pd.DataFrame:
    """Reliability table over all (race, driver) win probabilities."""
    cut = pd.cut(pred["p"], bins=list(bins), right=False)
    tab = pred.groupby(cut, observed=True).agg(n=("p", "size"), mean_p=("p", "mean"), win_rate=("is_winner", "mean"))
    tab["gap"] = tab["win_rate"] - tab["mean_p"]
    return tab


def ece(pred: pd.DataFrame, n_bins: int = 10) -> float:
    """Expected calibration error with equal-mass bins (robust to the mass of tiny probabilities)."""
    p = pred["p"].to_numpy(dtype=float)
    y = pred["is_winner"].to_numpy(dtype=float)
    order = np.argsort(p)
    total = 0.0
    for chunk in np.array_split(order, n_bins):
        if len(chunk):
            total += len(chunk) * abs(p[chunk].mean() - y[chunk].mean())
    return float(total / len(p))


def paired_bootstrap(a: pd.DataFrame, b: pd.DataFrame, metric: str = "logloss", n_boot: int = 5000, seed: int = 0) -> dict:
    """Bootstrap over races of mean(metric_a - metric_b). Negative = A better (for losses)."""
    m = a[["race_id", metric]].merge(b[["race_id", metric]], on="race_id", suffixes=("_a", "_b"))
    d = (m[f"{metric}_a"] - m[f"{metric}_b"]).to_numpy()
    rng = np.random.default_rng(seed)
    boots = rng.choice(d, size=(n_boot, len(d)), replace=True).mean(axis=1)
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return {"diff": float(d.mean()), "ci_low": float(lo), "ci_high": float(hi), "p_a_better": float((boots < 0).mean()), "races": len(d)}
