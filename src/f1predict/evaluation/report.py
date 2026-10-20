"""Evaluation summaries that hold up on ~20-race seasons: per-season tables, paired comparisons
against the mode's strongest baseline, tail behaviour and calibration of the probabilities that matter."""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar

from f1predict.evaluation.metrics import paired_bootstrap, race_scores, summarize
from f1predict.models.base import group_softmax


def per_season(pred: pd.DataFrame, baseline: pd.DataFrame | None = None) -> pd.DataFrame:
    """One row per season (+ pooled): LL, Brier, top-1/3 and the paired LL difference vs `baseline`."""
    sc = race_scores(pred).merge(pred.drop_duplicates("race_id")[["race_id", "year"]], on="race_id")
    base_sc = race_scores(baseline) if baseline is not None else None
    rows = []
    groups = [(int(y), g) for y, g in sc.groupby("year")] + [("all", sc)]
    for label, g in groups:
        row = {"season": label, **{k: v for k, v in summarize(g).items() if k != "skill_vs_uniform"}}
        if base_sc is not None:
            b = base_sc[base_sc["race_id"].isin(g["race_id"])]
            cmp = paired_bootstrap(g, b, n_boot=2000)
            row.update({"vs_base": cmp["diff"], "vs_base_lo": cmp["ci_low"], "vs_base_hi": cmp["ci_high"]})
        rows.append(row)
    return pd.DataFrame(rows)


def paired_bootstrap_summary(pred: pd.DataFrame, baseline: pd.DataFrame, metric: str = "logloss") -> dict:
    """Paired (race-level) bootstrap of pred - baseline, plus how many seasons agree on the sign."""
    a, b = race_scores(pred), race_scores(baseline)
    out = paired_bootstrap(a, b, metric=metric)
    years = pred.drop_duplicates("race_id").set_index("race_id")["year"]
    m = a.merge(b, on="race_id", suffixes=("_a", "_b"))
    m["year"] = m["race_id"].map(years)
    per = m.groupby("year").apply(lambda g: (g[f"{metric}_a"] - g[f"{metric}_b"]).mean(), include_groups=False)
    out["seasons_better"] = int((per < 0).sum())
    out["seasons"] = int(len(per))
    return out


def tail_stats(pred: pd.DataFrame, k: int = 5) -> dict:
    sc = race_scores(pred)
    worst = sc.nlargest(k, "logloss")
    winners = pred[pred["is_winner"]][["race_id", "driver_id", "year", "round"]]
    worst = worst.merge(winners, on="race_id")
    total = sc["logloss"].sum()
    return {
        "winners_p_lt_1pct": int((sc["p_winner"] < 0.01).sum()),
        "winners_p_lt_0.1pct": int((sc["p_winner"] < 0.001).sum()),
        "worst_share_of_total_ll": float(worst["logloss"].sum() / total),
        "worst": worst[["year", "round", "driver_id", "p_winner", "logloss"]].to_dict("records"),
    }


def temperature(pred: pd.DataFrame, n_boot: int = 500, seed: int = 0) -> dict:
    """Max-likelihood winner temperature T* (p ∝ p^(1/T)); T* = 1 means calibrated sharpness,
    T* > 1 means over-confident. Bootstrap CI over races."""
    pred = pred.sort_values(["race_id"], kind="stable")
    logp = np.log(np.clip(pred["p"].to_numpy(), 1e-12, None))
    rid = pred["race_id"].to_numpy()
    y = pred["is_winner"].to_numpy(dtype=bool)
    races = np.unique(rid)
    t_hat = _fit_weighted(logp, rid, y, races, np.ones(len(races)))
    rng = np.random.default_rng(seed)
    boots = []
    for _ in range(n_boot):
        # a race drawn k times counts k times
        uniq, counts = np.unique(rng.choice(races, size=len(races), replace=True), return_counts=True)
        boots.append(_fit_weighted(logp, rid, y, uniq, counts))
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return {"T": float(t_hat), "T_lo": float(lo), "T_hi": float(hi)}


def _fit_weighted(logp, rid, y, races, counts) -> float:
    m = np.isin(rid, races)
    lp, r, yy = logp[m], rid[m], y[m]
    order = np.argsort(r, kind="stable")
    lp, r, yy = lp[order], r[order], yy[order]
    w = dict(zip(races, counts))
    win_w = np.array([w[x] for x in r[yy]])

    def nll(t):
        return -(win_w * np.log(np.clip(group_softmax(lp / t, r)[yy], 1e-12, None))).sum()

    return minimize_scalar(nll, bounds=(0.2, 5.0), method="bounded").x


def favourite_reliability(pred: pd.DataFrame, bins=(0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0001)) -> pd.DataFrame:
    """Does the favourite win as often as its probability says? Wilson 95% intervals."""
    fav = pred.loc[pred.groupby("race_id")["p"].idxmax()]
    cut = pd.cut(fav["p"], bins=list(bins), right=False)
    tab = fav.groupby(cut, observed=True).agg(n=("p", "size"), mean_p=("p", "mean"), win_rate=("is_winner", "mean"))
    z = 1.96
    n, ph = tab["n"], tab["win_rate"]
    centre = (ph + z**2 / (2 * n)) / (1 + z**2 / n)
    half = z * np.sqrt(ph * (1 - ph) / n + z**2 / (4 * n**2)) / (1 + z**2 / n)
    tab["lo"], tab["hi"] = centre - half, centre + half
    return tab.reset_index().rename(columns={"p": "bin"})


def contender_calibration(pred: pd.DataFrame, n_bins: int = 6, p_min: float = 0.05) -> pd.DataFrame:
    """Equal-mass reliability bins over rows with p >= p_min (the near-zero mass is uninformative)."""
    sub = pred[pred["p"] >= p_min].sort_values("p")
    out = []
    for chunk in np.array_split(np.arange(len(sub)), n_bins):
        c = sub.iloc[chunk]
        out.append({"n": len(c), "mean_p": c["p"].mean(), "win_rate": c["is_winner"].mean()})
    return pd.DataFrame(out)
