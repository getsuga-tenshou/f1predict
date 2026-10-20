"""End-to-end orchestration driven by the frozen config (configs/final.json).

    oos      walk-forward out-of-sample predictions of every base model / baseline, 2011-2026
    stack    online second stage over those predictions
    evaluate per-split / per-season reports (validation 2014-22, test 2023-25, holdout 2026)
    forecast win probabilities for upcoming races (any mode; live weekend data optional)
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pandas as pd

from f1predict.config import (
    DEFAULT_TRAIN_START,
    HOLDOUT_SEASONS,
    REPORTS_DIR,
    ROOT,
    STACK_BURN_IN_SEASONS,
    TEST_SEASONS,
    VALIDATION_SEASONS,
)
from f1predict.data.canonical import F1Data
from f1predict.evaluation import report
from f1predict.evaluation.backtest import eval_race_ids, training_rows, walk_forward
from f1predict.evaluation.metrics import race_scores, summarize
from f1predict.features.build import build_dataset, feature_columns, state_features
from f1predict.features.state import StateParams
from f1predict.models.base import Uniform
from f1predict.models.baselines import FeatureSoftmax, GridPrior
from f1predict.models.choice import ConditionalLogit, GBMSoftmax
from f1predict.models.stacking import StackParams, align, apply_stack, fit_stack, online_stack

CONFIG_PATH = ROOT / "configs" / "final.json"
OOS_DIR = REPORTS_DIR / "oos"
ALL_SEASONS = STACK_BURN_IN_SEASONS + VALIDATION_SEASONS + TEST_SEASONS + HOLDOUT_SEASONS
SPLITS = {"validation": VALIDATION_SEASONS, "test": TEST_SEASONS, "holdout_2026": HOLDOUT_SEASONS}


# ---------------------------------------------------------------------------- config
def load_config(path: Path = CONFIG_PATH) -> dict:
    return json.loads(Path(path).read_text())


def state_params(cfg: dict) -> StateParams:
    kw = dict(cfg["state"])
    kw["form_halflives"] = tuple(kw["form_halflives"])
    return StateParams(**kw)


def make_model(spec: dict, mode: str, sp: StateParams):
    fam = spec["family"]
    if fam == "uniform":
        return Uniform()
    if fam == "grid_prior":
        return GridPrior()
    if fam == "softmax":
        return FeatureSoftmax(spec["feature"], sign=spec.get("sign", 1.0))
    feats = feature_columns(mode, sp, kind=spec.get("kind", "full"))
    if fam == "condlogit":
        return ConditionalLogit(
            feats, l2=spec["l2"], depth=spec.get("depth", 1), stage_decay=spec.get("stage_decay", 0.5),
            time_halflife=spec.get("time_halflife"),
        )  # fmt: skip
    if fam in ("gbm", "hybrid"):
        base = make_model({**spec["base"], "family": "condlogit"}, mode, sp) if fam == "hybrid" else None
        return GBMSoftmax(
            feats, depth=spec.get("depth", 1), stage_scale=spec.get("stage_scale", 0.7),
            time_halflife=spec.get("time_halflife"), n_estimators=spec["n_estimators"],
            learning_rate=spec.get("learning_rate", 0.03), num_leaves=spec["num_leaves"],
            min_data_in_leaf=spec["min_data_in_leaf"], feature_fraction=spec.get("feature_fraction", 0.7),
            lambda_l2=spec.get("lambda_l2", 10.0), base=base,
        )  # fmt: skip
    raise ValueError(f"unknown model family {fam}")


class Factory:
    def __init__(self, spec, mode, sp):
        self.spec, self.mode, self.sp = spec, mode, sp

    def __call__(self):
        return make_model(self.spec, self.mode, self.sp)


def mode_models(cfg: dict, mode: str) -> dict[str, dict]:
    """Members + baselines of a mode, by name."""
    m = cfg["modes"][mode]
    return {**m["members"], **m.get("baselines", {})}


# ---------------------------------------------------------------------------- OOS predictions
def _oos_path(mode: str, name: str, h: int) -> Path:
    return OOS_DIR / f"{mode}__{name}__h{h}.parquet"


def oos_predictions(data: F1Data, cfg: dict, horizons: int = 1, n_jobs: int | None = None, force: bool = False) -> None:
    """Walk-forward predictions for every model of every mode over ALL_SEASONS (h = 1),
    plus h = 2..horizons for the pre_weekend members (season-outlook backtest)."""
    sp = state_params(cfg)
    st = state_features(data, sp, horizons=horizons)
    OOS_DIR.mkdir(parents=True, exist_ok=True)
    for mode in cfg["modes"]:
        df = build_dataset(data, mode, sp, state=st)
        hs = range(1, horizons + 1) if mode == "pre_weekend" else (1,)
        for h in hs:
            ids = eval_race_ids(df, ALL_SEASONS, h)
            models = mode_models(cfg, mode) if h == 1 else cfg["modes"][mode]["members"]
            for name, spec in models.items():
                path = _oos_path(mode, name, h)
                if path.exists() and not force:
                    continue
                pred = walk_forward(
                    Factory(spec, mode, sp), df, ids, train_start=spec.get("train_start", DEFAULT_TRAIN_START), n_jobs=n_jobs, h=h
                )
                pred.to_parquet(path, index=False)
                print(f"oos {mode} {name} h={h}: {summarize(race_scores(pred[pred['year'].isin(VALIDATION_SEASONS)]))['logloss']:.4f} (val)", flush=True)


def load_oos(mode: str, name: str, h: int = 1) -> pd.DataFrame:
    return pd.read_parquet(_oos_path(mode, name, h))


def _member_preds(cfg: dict, mode: str, h: int = 1) -> dict[str, pd.DataFrame]:
    """OOS predictions keyed by member name; a cross-mode fallback is named '<mode>:<member>'."""
    m = cfg["modes"][mode]
    preds = {name: load_oos(mode, name, h) for name in m["stack"]["members"]}
    fb = m["stack"].get("fallback")
    if fb and ":" in fb:
        fmode, fname = fb.split(":")
        preds[fb] = load_oos(fmode, fname, h)
    return preds


def stack_params(cfg: dict, mode: str) -> StackParams:
    s = cfg["modes"][mode]["stack"]
    return StackParams(
        members=tuple(s["members"]), primary=s["primary"], fallback=s.get("fallback"), halflife=s.get("halflife", 60.0),
        prior_sd=s.get("prior_sd", 0.5), prior_races=s.get("prior_races", 20.0), max_eps=s.get("max_eps", 0.3),
    )  # fmt: skip


def stacked_predictions(cfg: dict, mode: str, h: int = 1) -> pd.DataFrame:
    preds = _member_preds(cfg, mode, h)
    wide = align(preds)
    eval_ids = wide[wide["year"].isin(VALIDATION_SEASONS + TEST_SEASONS + HOLDOUT_SEASONS)]["race_id"].unique().tolist()
    out = online_stack(preds, eval_ids, stack_params(cfg, mode))
    out["h"] = h
    return out


# ---------------------------------------------------------------------------- evaluation
def evaluate(cfg: dict, horizons: int = 1) -> dict:
    """Per mode: final (stacked) model vs baselines and members, per split and per season."""
    results: dict = {"config": cfg, "modes": {}}
    for mode, mcfg in cfg["modes"].items():
        final = stacked_predictions(cfg, mode)
        baseline_name = mcfg["reference_baseline"]
        base = load_oos(mode, baseline_name)
        others = {n: load_oos(mode, n) for n in mode_models(cfg, mode)}
        mres: dict = {"reference_baseline": baseline_name, "splits": {}}
        for split, seasons in SPLITS.items():
            f = final[final["year"].isin(seasons)]
            b = base[base["year"].isin(seasons)]
            entry = {
                "final": summarize(race_scores(f)),
                "per_season": report.per_season(f, b).to_dict("records"),
                "models": {n: summarize(race_scores(p[p["year"].isin(seasons)])) for n, p in others.items()},
                "tails": report.tail_stats(f),
                "temperature": report.temperature(f, n_boot=300),
                "favourite": report.favourite_reliability(f).astype({"bin": str}).to_dict("records"),
                "contenders": report.contender_calibration(f).to_dict("records"),
            }
            entry["vs_baseline"] = report.paired_bootstrap_summary(f, b)
            mres["splits"][split] = entry
        if mode == "pre_weekend" and horizons > 1:
            # Every horizon is scored on the same races (those with an h = `horizons` forecast,
            # i.e. rounds >= horizons), otherwise long horizons silently skip each season's openers.
            by_h = {h: stacked_predictions(cfg, mode, h) for h in range(1, horizons + 1)}
            common = set.intersection(*(set(ph["race_id"]) for ph in by_h.values()))
            mres["horizons"] = {
                h: {
                    split: summarize(race_scores(ph[ph["year"].isin(seasons) & ph["race_id"].isin(common)]))
                    for split, seasons in SPLITS.items()
                }
                for h, ph in by_h.items()
            }
        results["modes"][mode] = mres
    return results


# ---------------------------------------------------------------------------- forecasting
def forecast(
    data: F1Data,
    cfg: dict,
    mode: str,
    race_ids: list[int] | None = None,
    entry_lists: dict | None = None,
    state: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Win probabilities for races without results (default: all remaining races of the season).

    Members are refitted on every completed race; the second stage uses parameters fitted on the
    full out-of-sample history (horizon-matched for pre_weekend).

    `state` (from `state_features` with the same `entry_lists`) skips the replay. The replay only
    reads completed races, so it can come from `data` without this weekend's live session rows.
    """
    sp = state_params(cfg)
    st = state if state is not None else state_features(data, sp, entry_lists=entry_lists, horizons=1)
    df = build_dataset(data, mode, sp, state=st)
    future = df[~df["has_result"]]
    if race_ids is not None:
        future = future[future["race_id"].isin(race_ids)]
    if future.empty:
        raise ValueError("no upcoming races to forecast")
    m = cfg["modes"][mode]
    sparams = stack_params(cfg, mode)
    member_specs = dict(m["members"])
    fb = m["stack"].get("fallback")
    fb_df = None
    if fb and ":" in fb:
        fmode, fname = fb.split(":")
        member_specs[fb] = cfg["modes"][fmode]["members"][fname]
        fb_df = build_dataset(data, fmode, sp, state=st)
    cutoff = future["date"].min()
    preds, explain = {}, None
    for name, spec in member_specs.items():
        mode_of = name.split(":")[0] if ":" in name else mode
        frame = fb_df if ":" in name else df
        model = make_model(spec, mode_of, sp).fit(training_rows(frame, cutoff, spec.get("train_start", DEFAULT_TRAIN_START)))
        rows = frame[frame["race_id"].isin(future["race_id"].unique()) & ~frame["has_result"]]
        preds[name] = rows.assign(p=model.predict(rows))
        linear = getattr(model, "base", None) or model
        if name == sparams.primary and hasattr(linear, "contributions"):
            contrib = linear.contributions(rows)
            top = contrib.apply(lambda r: "; ".join(f"{k} {v:+.2f}" for k, v in r.sort_values(key=abs, ascending=False).head(3).items()), axis=1)
            explain = rows[["race_id", "driver_id"]].assign(why=top.to_numpy())

    out = []
    for h in sorted(future["h"].unique()):
        # Second stage fitted on out-of-sample history at the same horizon (or the longest backtested).
        h_hist = max([k for k in range(1, int(h) + 1) if _oos_path(mode, sparams.primary, k).exists()], default=1)
        hist = align(_member_preds(cfg, mode, h_hist if mode == "pre_weekend" else 1))
        w, eps = fit_stack(hist, sparams)
        cur = future[future["h"] == h][["race_id", "driver_id"]]
        wide = cur.copy()
        for name in sparams.members + ((fb,) if fb else ()):
            wide = wide.merge(preds[name][["race_id", "driver_id", "p"]].rename(columns={"p": f"p__{name}"}), on=["race_id", "driver_id"])
        wide = wide.sort_values(["race_id", "driver_id"]).reset_index(drop=True)
        wide["p"] = apply_stack(wide, sparams, w, eps)
        wide["h"] = h
        wide["stack_eps"] = eps
        out.append(wide)
    res = pd.concat(out, ignore_index=True)
    info = future[["race_id", "year", "round", "date", "circuit_id", "driver_id", "team_id", "d_pace", "t_pace", "rating"]]
    res = res.merge(info, on=["race_id", "driver_id"], how="left")
    if explain is not None:
        res = res.merge(explain, on=["race_id", "driver_id"], how="left")
    return res.sort_values(["date", "p"], ascending=[True, False]).reset_index(drop=True)
