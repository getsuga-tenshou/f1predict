"""Live-weekend adapter: pull the sessions of a Grand Prix that F1DB has not released yet from OpenF1
and append them to the canonical tables, so pre_quali / pre_race predictions use the same code path
as the backtest.

OpenF1's free tier serves a session ~30 minutes after it ends. Driver numbers are mapped to F1DB
driver ids through the season's F1DB entries; unknown numbers (e.g. FP1 reserves) are mapped by
OpenF1's driver list and team, and only contribute car-level practice pace.
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from f1predict.config import RAW_DIR
from f1predict.data.canonical import GAP_CLIP_PCT, F1Data, stitched_gap_pct
from f1predict.data.download import f1db_dir

API = "https://api.openf1.org/v1"
SESSION_MAP = {
    "Practice 1": "fp1",
    "Practice 2": "fp2",
    "Practice 3": "fp3",
    "Sprint Qualifying": "sq",
    "Sprint Shootout": "sq",
    "Sprint": "sprint",
    "Qualifying": "q",
}


def _get(path: str, timeout: float = 30, **params) -> list[dict]:
    for attempt in range(4):
        resp = requests.get(f"{API}/{path}", params=params, timeout=timeout)
        if resp.status_code == 429:
            time.sleep(2 * (attempt + 1))
            continue
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        out = resp.json()
        return out if isinstance(out, list) else []
    raise RuntimeError(f"OpenF1 rate limit on {path}")


def number_map(data: F1Data, year: int) -> dict[int, tuple[str, str]]:
    """driver_number -> (driver_id, constructor_id) from F1DB race + FP1 entries of `year`."""
    raw = f1db_dir(data.version)
    out = {}
    for name in ("races-free-practice-1-results", "races-race-results"):  # race results win on conflict
        df = pd.read_csv(raw / f"f1db-{name}.csv", low_memory=False)
        df = df[df["year"] == year].sort_values("round")
        for num, drv, con in zip(df["driverNumber"], df["driverId"], df["constructorId"]):
            out[int(num)] = (drv, con)
    return out


def _sessions_for(race: pd.Series) -> list[dict]:
    start = (race["date"] - pd.Timedelta(days=4)).strftime("%Y-%m-%d")
    end = (race["date"] + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    sessions = _get("sessions", **{"year": int(race["year"]), "date_start>": start, "date_start<": end})
    now = pd.Timestamp.now(tz="UTC")
    done = [s for s in sessions if not s.get("is_cancelled") and pd.Timestamp(s["date_end"]) + pd.Timedelta(minutes=30) < now]
    return [s for s in done if s["session_name"] in SESSION_MAP]


def fetch_weekend(data: F1Data, race_id: int, snapshot_dir: Path | None = None) -> dict[str, pd.DataFrame]:
    """Canonical rows (practice / quali / sprint / grid) for the finished sessions of `race_id`."""
    race = data.races.set_index("race_id").loc[race_id]
    race = pd.Series({**race.to_dict(), "race_id": race_id})
    year = int(race["year"])
    numbers = number_map(data, year)
    lineage = data.results[data.results["year"] == year].drop_duplicates("constructor_id").set_index("constructor_id")["team_id"]
    snapshot_dir = snapshot_dir or RAW_DIR / "live" / str(year) / str(int(race["round"]))
    out: dict[str, list] = {"practice": [], "quali": [], "sprint_q": [], "sprint": []}

    for s in _sessions_for(race):
        kind = SESSION_MAP[s["session_name"]]
        res = pd.DataFrame(_get("session_result", session_key=s["session_key"]))
        if res.empty:
            continue
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        res.to_json(snapshot_dir / f"{kind}.json", orient="records")
        drivers = pd.DataFrame(_get("drivers", session_key=s["session_key"]))
        team_of_number = dict(zip(drivers.get("driver_number", []), drivers.get("team_name", [])))
        res["driver_id"] = [numbers.get(int(n), (None, None))[0] for n in res["driver_number"]]
        res["constructor_id"] = [numbers.get(int(n), (None, None))[1] for n in res["driver_number"]]
        # Unknown numbers (reserves): borrow the constructor of a known driver from the same OpenF1 team.
        known_team = {team_of_number.get(n): c for n, c in zip(res["driver_number"], res["constructor_id"]) if c}
        res["constructor_id"] = [c or known_team.get(team_of_number.get(n)) for n, c in zip(res["driver_number"], res["constructor_id"])]
        res["race_id"] = race_id
        out["practice" if kind.startswith("fp") else {"q": "quali", "sq": "sprint_q", "sprint": "sprint"}[kind]].append((kind, res))

    tables: dict[str, pd.DataFrame] = {}
    if out["practice"]:
        rows = []
        for kind, res in out["practice"]:
            t = pd.to_numeric(res["duration"], errors="coerce") * 1000
            rows.append(
                pd.DataFrame(
                    {
                        "race_id": race_id, "year": year, "session": kind, "driver_id": res["driver_id"].fillna("unknown-" + res["driver_number"].astype(str)),
                        "constructor_id": res["constructor_id"], "fp_best_ms": t, "fp_gap_pct": (100 * (t / t.min() - 1)).clip(0, GAP_CLIP_PCT),
                    }
                )  # fmt: skip
            )
        prac = pd.concat(rows, ignore_index=True)
        prac["team_id"] = prac["constructor_id"].map(lineage).fillna(prac["constructor_id"])
        prac["car_fp_gap_pct"] = prac.groupby(["session", "team_id"])["fp_gap_pct"].transform("min")
        tables["practice"] = prac
    for key, pos_name, gap_name in (("quali", "quali_pos", "quali_gap_pct"), ("sprint_q", "sprint_quali_pos", "sq_gap_pct")):
        if not out[key]:
            continue
        _, res = out[key][-1]
        res = res.dropna(subset=["driver_id"])
        seg = pd.DataFrame([(list(d) + [np.nan] * 3)[:3] if isinstance(d, list) else [np.nan] * 3 for d in res["duration"]],
                           columns=["q1Millis", "q2Millis", "q3Millis"], index=res.index) * 1000  # fmt: skip
        seg["timeMillis"] = np.nan
        tables[key] = pd.DataFrame(
            {
                "race_id": race_id, "driver_id": res["driver_id"], "constructor_id": res["constructor_id"],
                pos_name: pd.to_numeric(res["position"], errors="coerce"), gap_name: stitched_gap_pct(seg),
                "q1_ms": seg["q1Millis"], "q2_ms": seg["q2Millis"], "q3_ms": seg["q3Millis"], "time_ms": np.nan,
            }
        ).reset_index(drop=True)  # fmt: skip
    if out["sprint"]:
        _, res = out["sprint"][-1]
        res = res.dropna(subset=["driver_id"])
        # Like F1DB, keep the classification of late retirements (dnf=True with a position).
        tables["sprint"] = pd.DataFrame(
            {
                "race_id": race_id, "driver_id": res["driver_id"],
                "sprint_pos": pd.to_numeric(res["position"], errors="coerce"),
                "sprint_grid": np.nan, "sprint_points": pd.to_numeric(res.get("points", 0), errors="coerce"),
            }
        ).reset_index(drop=True)  # fmt: skip
    return tables


def grid_from_quali(quali: pd.DataFrame, overrides: pd.DataFrame | None = None) -> pd.DataFrame:
    """Provisional starting grid = qualifying order, with optional manual overrides (penalties, pit
    lane) from a CSV with columns driver_id, grid_pos[, pit_lane_start]."""
    g = quali[["race_id", "driver_id", "quali_pos"]].rename(columns={"quali_pos": "grid_pos"}).copy()
    g["pit_lane_start"] = False
    if overrides is not None and len(overrides):
        o = overrides.set_index("driver_id")
        g["grid_pos"] = g["driver_id"].map(o["grid_pos"]).fillna(g["grid_pos"])
        if "pit_lane_start" in o:
            g["pit_lane_start"] = g["driver_id"].map(o["pit_lane_start"]).fillna(False).astype(bool)
    g["grid_penalty_places"] = (g["grid_pos"] - quali["quali_pos"].to_numpy()).clip(lower=0).fillna(0.0)
    # Like F1DB (gridPenaltyPositions), a pit-lane start is not counted as penalty places: the
    # pit_lane_start flag carries it, and training rows have ~0 places for pit-lane starters.
    g["grid_penalty_places"] = g["grid_penalty_places"].where(~g["pit_lane_start"], 0.0)
    return g


def with_live_weekend(data: F1Data, race_id: int, grid_overrides: pd.DataFrame | None = None) -> F1Data:
    """Copy of `data` with the finished sessions of `race_id` appended from OpenF1."""
    t = fetch_weekend(data, race_id)
    practice, quali, sprint, grid = data.practice, data.quali, data.sprint, data.grid
    if "practice" in t:
        practice = pd.concat([practice[practice["race_id"] != race_id], t["practice"]], ignore_index=True)
    if "quali" in t:
        quali = pd.concat([quali[quali["race_id"] != race_id], t["quali"]], ignore_index=True)
        grid = pd.concat([grid[grid["race_id"] != race_id], grid_from_quali(t["quali"], grid_overrides)], ignore_index=True)
    if "sprint" in t or "sprint_q" in t:
        parts = [x for x in (t.get("sprint"), t.get("sprint_q")) if x is not None]
        sp = parts[0]
        for extra in parts[1:]:
            sp = sp.merge(extra[["race_id", "driver_id"] + [c for c in ("sprint_quali_pos", "sq_gap_pct") if c in extra]], on=["race_id", "driver_id"], how="outer")
        sprint = pd.concat([sprint[sprint["race_id"] != race_id], sp], ignore_index=True)
    return F1Data(races=data.races, results=data.results, quali=quali, grid=grid, practice=practice, sprint=sprint, version=data.version)
