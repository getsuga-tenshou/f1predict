"""Assemble the modelling table: pre-race state features + mode-dependent weekend features."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict

import numpy as np
import pandas as pd

from f1predict.config import MODES, PROCESSED_DIR
from f1predict.data.canonical import F1Data
from f1predict.features.state import StateEngine, StateParams

LABEL_COLUMNS = ["finish_pos", "is_winner", "status", "display_order", "dnf_cause"]
HORIZON_FROM_YEAR = 2010  # multi-step (h > 1) snapshots are only produced from here on


# ---------------------------------------------------------------------------- state replay
def last_lineup(data: F1Data) -> pd.DataFrame:
    """Entrants of the most recent race with results — default entry list for future races."""
    done = data.results["race_id"].unique()
    last = data.races[data.races["race_id"].isin(done)].iloc[-1]["race_id"]
    cols = ["driver_id", "team_id", "engine_id"]
    return data.results.loc[data.results["race_id"] == last, cols].reset_index(drop=True)


def replay_state(
    data: F1Data,
    params: StateParams | None = None,
    entry_lists: dict[int, pd.DataFrame] | None = None,
    horizons: int = 1,
) -> pd.DataFrame:
    """Replay all races chronologically; one row per (race, entrant, horizon) with pre-race state.

    h = 1 rows are snapshots taken just before the race. With `horizons` = H > 1, each completed race
    from HORIZON_FROM_YEAR also gets h = 2..H snapshots taken h-1 races earlier in the same season,
    which is what a forecaster knows when predicting several rounds ahead (season outlook backtest).
    Races without results (the rest of the current season) are snapshotted from the latest state,
    with h = rounds since the last completed race, using `entry_lists[race_id]` or the last lineup.
    """
    engine = StateEngine(params)
    races = data.races.reset_index(drop=True)
    res_by_race = dict(tuple(data.results.groupby("race_id")))
    q_by_race = dict(tuple(data.quali.groupby("race_id")))
    s_by_race = dict(tuple(data.sprint.groupby("race_id")))
    g_by_race = dict(tuple(data.grid.groupby("race_id")))
    entry_lists = entry_lists or {}
    lineup = last_lineup(data)
    race_rows = [pd.Series(r._asdict()) for r in races.itertuples(index=False)]

    def entrants_of(race) -> pd.DataFrame:
        res = res_by_race.get(race["race_id"])
        if res is not None:
            return res[["driver_id", "team_id", "engine_id"]]
        return entry_lists.get(race["race_id"], lineup)

    def entrants_asof(ahead, asof_race) -> pd.DataFrame:
        """Field of a future race with each driver's team/engine as known at `asof_race`:
        line-up changes announced later are not known to the forecaster."""
        ent = entrants_of(ahead).copy()
        known = entrants_of(asof_race).set_index("driver_id")
        m = ent["driver_id"].isin(known.index)
        for col in ("team_id", "engine_id"):
            ent.loc[m, col] = ent.loc[m, "driver_id"].map(known[col])
        return ent

    def tag(snap: pd.DataFrame, race, h: int, asof) -> pd.DataFrame:
        snap["race_id"] = race["race_id"]
        snap["year"] = race["year"]
        snap["round"] = race["round"]
        snap["date"] = race["date"]
        snap["asof_date"] = asof
        snap["h"] = h
        snap["circuit_id"] = race["circuit_id"]
        snap["is_street"] = float(race["circuit_type"] == "STREET")
        snap["is_sprint_weekend"] = float(race["is_sprint_weekend"])
        snap["is_nonrepresentative"] = bool(race["is_nonrepresentative"])
        snap["field_size"] = len(snap)
        res = res_by_race.get(race["race_id"])
        if res is not None:
            snap = snap.join(res.set_index("driver_id")[LABEL_COLUMNS], on="driver_id")
        return snap

    frames = []
    future_h = 0
    for i, race in enumerate(race_rows):
        engine.begin_race(race)
        has_res = race["race_id"] in res_by_race
        if has_res:
            snap = engine.snapshot(race, entrants_of(race))
            frames.append(tag(snap, race, 1, race["date"]))
            if horizons > 1 and race["year"] >= HORIZON_FROM_YEAR:
                for k in range(1, horizons):
                    if i + k >= len(race_rows):
                        break
                    ahead = race_rows[i + k]
                    if ahead["year"] != race["year"] or ahead["race_id"] not in res_by_race:
                        break
                    snap = engine.snapshot(ahead, entrants_asof(ahead, race))
                    snap["races_since_reset"] += k
                    frames.append(tag(snap, ahead, k + 1, race["date"]))
            engine.update(
                race,
                res_by_race[race["race_id"]],
                q_by_race.get(race["race_id"], data.quali.iloc[0:0]),
                s_by_race.get(race["race_id"], data.sprint.iloc[0:0]),
                g_by_race.get(race["race_id"], data.grid.iloc[0:0]),
            )
        else:
            future_h += 1
            snap = engine.snapshot(race, entrants_of(race))
            snap["races_since_reset"] += future_h - 1
            frames.append(tag(snap, race, future_h, pd.NaT))
    out = pd.concat(frames, ignore_index=True)
    out["has_result"] = out["race_id"].isin(res_by_race.keys())
    return out


def _cache_key(data: F1Data, params: StateParams, entry_lists, horizons: int) -> str:
    blob = json.dumps(
        {
            "v": data.version,
            "p": asdict(params),
            "n": int(len(data.results)),
            "nq": int(len(data.quali)),
            # Seat assignments, not just names: swapping two drivers between teams changes the state.
            "e": {
                int(k): sorted(map(list, v.reindex(columns=["driver_id", "team_id", "engine_id"]).astype(str).itertuples(index=False)))
                for k, v in (entry_lists or {}).items()
            },
            "h": horizons,
            "schema": 7,
        },
        sort_keys=True,
    )
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def state_features(
    data: F1Data, params: StateParams | None = None, entry_lists=None, horizons: int = 1, use_cache: bool = True
) -> pd.DataFrame:
    params = params or StateParams()
    path = PROCESSED_DIR / data.version / f"state_{_cache_key(data, params, entry_lists, horizons)}.parquet"
    if use_cache and path.exists():
        return pd.read_parquet(path)
    out = replay_state(data, params, entry_lists, horizons)
    if use_cache:
        path.parent.mkdir(parents=True, exist_ok=True)
        out.to_parquet(path, index=False)
    return out


# ---------------------------------------------------------------------------- weekend
def practice_sessions_before_quali(is_sprint: bool) -> tuple[str, ...]:
    """Practice sessions that run before Grand Prix qualifying.

    Every sprint format has FP1 only before GP qualifying: 2021-22 ran FP2 on Saturday *after*
    qualifying, 2023+ sprint weekends have no FP2/FP3 at all.
    """
    return ("fp1",) if is_sprint else ("fp1", "fp2", "fp3", "fp4")


def sprint_before_quali(year: int, is_sprint: bool) -> bool:
    """2024+: sprint qualifying and the sprint run before GP qualifying. 2021-23: after it."""
    return bool(is_sprint) and year >= 2024


def weekend_features(data: F1Data, mode: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Same-weekend session features that `mode` may see.

    Returns (per-driver table keyed race_id/driver_id, per-car table keyed race_id/team_id). Keys come
    from the session tables themselves, so live-weekend rows for a future race work the same way.
    """
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}")
    if mode == "pre_weekend":
        return pd.DataFrame(columns=["race_id", "driver_id"]), pd.DataFrame(columns=["race_id", "team_id"])

    flags = data.races.set_index("race_id")[["year", "is_sprint_weekend"]]
    prac = data.practice.drop(columns="year").join(flags, on="race_id", how="inner")
    if mode == "pre_quali":
        ok = [s in practice_sessions_before_quali(sp) for s, sp in zip(prac["session"], prac["is_sprint_weekend"])]
        prac = prac[np.asarray(ok, dtype=bool)]
    drv = (
        prac.dropna(subset=["fp_gap_pct"])
        .groupby(["race_id", "driver_id"])
        .agg(fp_gap_mean=("fp_gap_pct", "mean"), fp_gap_min=("fp_gap_pct", "min"), n_fp=("fp_gap_pct", "size"))
        .reset_index()
    )
    car = (
        prac.dropna(subset=["car_fp_gap_pct"])
        .drop_duplicates(["race_id", "session", "team_id"])
        .groupby(["race_id", "team_id"])["car_fp_gap_pct"]
        .mean()
        .rename("car_fp_gap_mean")
        .reset_index()
    )

    sprint = data.sprint.join(flags, on="race_id", how="inner")
    if mode == "pre_quali":
        sprint = sprint[[sprint_before_quali(y, s) for y, s in zip(sprint["year"], sprint["is_sprint_weekend"])]]
    sprint = sprint[["race_id", "driver_id", "sprint_pos", "sprint_quali_pos", "sq_gap_pct"]]
    drv = drv.merge(sprint, on=["race_id", "driver_id"], how="outer")
    if mode == "pre_race":
        q = data.quali[["race_id", "driver_id", "quali_pos", "quali_gap_pct"]]
        g = data.grid[["race_id", "driver_id", "grid_pos", "pit_lane_start", "grid_penalty_places"]]
        drv = drv.merge(q, on=["race_id", "driver_id"], how="outer").merge(g, on=["race_id", "driver_id"], how="outer")
    return drv, car


def _finish_weekend(df: pd.DataFrame, mode: str) -> pd.DataFrame:
    """Derived weekend columns (log positions, missing flags) once the frame is assembled."""
    if mode == "pre_weekend":
        return df
    df["fp_missing"] = df["fp_gap_mean"].isna().astype(float)
    df["log_sprint_pos"] = np.log(df["sprint_pos"])
    df["log_sprint_quali_pos"] = np.log(df["sprint_quali_pos"])
    if mode == "pre_race":
        # A car that did not take the start (or has no slot) goes to the back.
        df["grid_pos"] = df["grid_pos"].fillna(df["field_size"])
        df["pit_lane_start"] = df["pit_lane_start"].astype(float).fillna(0.0)
        df["grid_penalty_places"] = df["grid_penalty_places"].fillna(0.0)
        df["quali_missing"] = df["quali_pos"].isna().astype(float)
        df["log_grid"] = np.log(df["grid_pos"].clip(lower=1))
        df["log_quali_pos"] = np.log(df["quali_pos"].fillna(df["field_size"]).clip(lower=1))
    return df


# ---------------------------------------------------------------------------- feature lists
# (column, higher_is_better) pairs that get within-race relative versions (gap to best, rank).
# "{fast}"/"{slow}" expand to the configured form half-lives.
RELATIVE_SPEC = [
    ("d_pace", False),
    ("t_pace", False),
    ("rating", True),
    ("t_rating", True),
    ("d_pts_h{fast}", True),
    ("t_pts_h{fast}", True),
    ("t_pts_h{slow}", True),
    ("season_pts_share", True),
    ("fp_gap_mean", False),
    ("car_fp_gap_mean", False),
    ("sq_gap_pct", False),
]


def relative_spec(params: StateParams | None = None) -> list[tuple[str, bool]]:
    hl = (params or StateParams()).form_halflives
    return [(c.format(fast=min(hl), slow=max(hl)), hi) for c, hi in RELATIVE_SPEC]


STATE_FEATURES = [
    "d_rating", "t_rating", "rating",
    "t_pace", "t_pace_sd", "d_offset", "d_offset_sd", "d_pace", "d_pace_sd", "pu_pace", "pu_mech_rate",
    "is_rookie", "career_starts", "career_wins", "starts_with_team",
    "season_pts_share", "champ_pos", "season_wins", "team_season_pts_share", "team_champ_pos", "team_season_wins",
    "prev_champ_pos", "prev_team_champ_pos",
    "d_incident_rate", "t_mech_rate", "tm_race_h2h", "t_circ_pace_resid",
    "round", "races_since_reset", "is_major_reset_season", "is_street", "is_sprint_weekend", "field_size",
]  # fmt: skip

WEEKEND_FEATURES = {
    "pre_weekend": [],
    "pre_quali": [
        "fp_gap_mean", "fp_gap_min", "n_fp", "fp_missing", "car_fp_gap_mean",
        "sprint_pos", "log_sprint_pos", "sprint_quali_pos", "log_sprint_quali_pos", "sq_gap_pct",
    ],
    "pre_race": [
        "fp_gap_mean", "fp_gap_min", "n_fp", "fp_missing", "car_fp_gap_mean",
        "sprint_pos", "log_sprint_pos", "sprint_quali_pos", "log_sprint_quali_pos", "sq_gap_pct",
        "quali_pos", "log_quali_pos", "quali_gap_pct", "quali_missing",
        "grid_pos", "log_grid", "pit_lane_start", "grid_penalty_places",
    ],
}  # fmt: skip

# Curated, low-collinearity set for the linear conditional logit (race-constant columns removed:
# they cancel inside a per-race softmax).
CORE_FEATURES = {
    "pre_weekend": [
        "d_pace_rel", "d_pace_sd", "t_pace_rel", "d_offset", "rating_rel", "t_rating_rel",
        "d_pts_h{fast}_rel", "t_pts_h{fast}_rel", "d_win_h{slow}", "t_win_h{fast}", "season_pts_share",
        "t_mech_rate", "pu_mech_rate", "d_incident_rate", "is_rookie", "t_circ_pace_resid",
    ],
}  # fmt: skip
CORE_FEATURES["pre_quali"] = CORE_FEATURES["pre_weekend"] + [
    "fp_gap_mean_rel", "car_fp_gap_mean_rel", "fp_missing", "sq_gap_pct", "log_sprint_pos",
]
CORE_FEATURES["pre_race"] = CORE_FEATURES["pre_quali"] + [
    "quali_gap_pct", "log_quali_pos", "log_grid", "pit_lane_start", "quali_missing",
]


def _form_features(halflives) -> list[str]:
    return [f"{ent}_{m}_h{h}" for h in halflives for ent in ("d", "t") for m in ("pts", "win", "podium", "qpos", "qgap")]


def feature_columns(mode: str, params: StateParams | None = None, kind: str = "full") -> list[str]:
    params = params or StateParams()
    hl = params.form_halflives
    if kind == "core":
        return [c.format(fast=min(hl), slow=max(hl)) for c in CORE_FEATURES[mode]]
    base = STATE_FEATURES + _form_features(hl) + WEEKEND_FEATURES[mode]
    rel = [f"{c}_{s}" for c, _ in relative_spec(params) if c in base for s in ("rel", "rank")]
    return base + rel


def add_relative(df: pd.DataFrame, params: StateParams | None = None) -> pd.DataFrame:
    g = df.groupby(["race_id", "h"])
    for col, higher in relative_spec(params):
        if col not in df:
            continue
        best = g[col].transform("max" if higher else "min")
        df[f"{col}_rel"] = df[col] - best
        df[f"{col}_rank"] = g[col].rank(ascending=not higher, method="min")
    return df


def build_dataset(
    data: F1Data,
    mode: str,
    params: StateParams | None = None,
    entry_lists: dict[int, pd.DataFrame] | None = None,
    state: pd.DataFrame | None = None,
    horizons: int = 1,
) -> pd.DataFrame:
    """One row per (race, entrant[, horizon]); features allowed in `mode` + labels where known."""
    params = params or StateParams()
    state = state if state is not None else state_features(data, params, entry_lists, horizons)
    drv, car = weekend_features(data, mode)
    df = state.merge(drv, on=["race_id", "driver_id"], how="left").merge(car, on=["race_id", "team_id"], how="left")
    for col in WEEKEND_FEATURES[mode]:
        if col not in df:
            df[col] = np.nan
    df = _finish_weekend(df, mode)
    if mode != "pre_weekend":
        # Weekend sessions are only known for the race being predicted right now.
        df.loc[df["h"] > 1, WEEKEND_FEATURES[mode]] = np.nan
    df = add_relative(df, params)
    return df.sort_values(["h", "date", "race_id", "driver_id"]).reset_index(drop=True)
