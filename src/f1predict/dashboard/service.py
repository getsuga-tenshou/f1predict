"""Everything the dashboard API serves: names, races, forecast runs and the backtest history.

The contract the frontend relies on is `dashboard/src/api/types.ts`; every dict built here mirrors one
of its interfaces. Forecast runs execute on a single worker thread (they share the state cache and are
CPU-bound) and finished runs are persisted as JSON under predictions/runs/. Forecasts the CLI wrote to
predictions/*.csv are listed alongside them.
"""

from __future__ import annotations

import json
import logging
import math
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from f1predict import pipeline
from f1predict.config import (
    F1DB_VERSION,
    HOLDOUT_SEASONS,
    MODES,
    PREDICTIONS_DIR,
    REPORTS_DIR,
    TEST_SEASONS,
    VALIDATION_SEASONS,
)
from f1predict.dashboard.labels import parse_why
from f1predict.data import canonical as C
from f1predict.data import live as L
from f1predict.data.download import f1db_dir, latest_version
from f1predict.features.build import last_lineup, practice_sessions_before_quali, sprint_before_quali, state_features

log = logging.getLogger(__name__)

RUNS_DIR = PREDICTIONS_DIR / "runs"
KEYS = ["race_id", "driver_id"]
EPS = 1e-12

MODE_INFO = [
    {
        "id": "pre_weekend",
        "label": "Before the weekend",
        "short": "Pre-weekend",
        "knows": "Everything up to the previous race: car and driver pace, form, ratings and reliability.",
    },
    {
        "id": "pre_quali",
        "label": "After practice",
        "short": "Pre-quali",
        "knows": "Adds this weekend's practice, and on sprint weekends the sprint and its qualifying.",
    },
    {
        "id": "pre_race",
        "label": "After qualifying",
        "short": "Pre-race",
        "knows": "Adds qualifying, the starting grid, penalties and pit-lane starts.",
    },
]
BASELINE_LABELS = {"pace": "Pace-only model", "grid": "Grid-slot prior", "elo": "Elo-only model", "uniform": "Uniform guess"}
SPLITS = {"validation": VALIDATION_SEASONS, "test": TEST_SEASONS, "holdout": HOLDOUT_SEASONS}
SPLIT_LABELS = {"validation": "Validation", "test": "Test", "holdout": "2026 holdout"}
EVAL_SPLIT_KEYS = {"validation": "validation", "test": "test", "holdout": "holdout_2026"}
CALIBRATION_EDGES = [0.0, 0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0 + 1e-9]
SESSION_ORDER = ("fp1", "fp2", "fp3", "sq", "sprint", "q")
CLI_FILE = re.compile(r"^(?P<year>\d{4})_r(?P<round>\d{2})_(?P<circuit>.+)_(?P<mode>pre_weekend|pre_quali|pre_race)\.csv$")
RUN_ID = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
MAX_WAITING_RUNS = 10  # queued + running; runs are CPU-bound and execute one at a time
SPRINT_BEFORE_QUALI_FROM = 2024


class RequestError(ValueError):
    """A run request the model can't honour (becomes HTTP 422)."""


class NotFound(KeyError):
    pass


# ---------------------------------------------------------------------------- small helpers
def _iso(ts) -> str | None:
    if ts is None or pd.isna(ts):
        return None
    ts = pd.Timestamp(ts)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return ts.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _num(x) -> float | None:
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) else x


def _int(x) -> int | None:
    v = _num(x)
    return None if v is None else int(round(v))


def _logloss(p) -> float:
    return float(-math.log(max(float(p), EPS)))


def clean(obj):
    """Recursively turn numpy scalars into Python ones and NaN into None (strict JSON)."""
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        return None if math.isnan(f) or math.isinf(f) else f
    return obj


class Names:
    """Display names from the F1DB reference tables."""

    def __init__(self, version: str):
        raw = f1db_dir(version)

        def read(name: str) -> pd.DataFrame:
            return pd.read_csv(raw / f"f1db-{name}.csv", low_memory=False).set_index("id")

        self.drivers = read("drivers")
        self.constructors = read("constructors")
        self.grands_prix = read("grands-prix")
        self.circuits = read("circuits")
        self._driver_cache: dict[str, dict] = {}

    def driver(self, driver_id: str) -> dict:
        if driver_id in self._driver_cache:
            return self._driver_cache[driver_id]
        if driver_id in self.drivers.index:
            r = self.drivers.loc[driver_id]
            abbr = r["abbreviation"] if isinstance(r["abbreviation"], str) else str(r["lastName"])[:3].upper()
            num = r["permanentNumber"]
            out = {"driver_id": driver_id, "name": str(r["name"]), "abbr": abbr, "number": _int(num) if pd.notna(num) else None}
        else:  # live reserve ids such as "unknown-34"
            out = {"driver_id": driver_id, "name": driver_id.replace("-", " ").title(), "abbr": driver_id[:3].upper(), "number": None}
        self._driver_cache[driver_id] = out
        return out

    def constructor(self, constructor_id: str | None) -> str:
        if constructor_id in self.constructors.index:
            return str(self.constructors.loc[constructor_id, "name"])
        return str(constructor_id or "").replace("-", " ").title()


# ---------------------------------------------------------------------------- the service
class Service:
    def __init__(self, version: str = F1DB_VERSION, runs_dir: Path = RUNS_DIR, predictions_dir: Path = PREDICTIONS_DIR):
        self.version = version
        self.runs_dir = Path(runs_dir)
        self.predictions_dir = Path(predictions_dir)
        self.cfg = pipeline.load_config()
        self.sp = pipeline.state_params(self.cfg)
        self.short_halflife = int(min(self.sp.form_halflives))
        self.data = C.load(version)
        self.names = Names(version)

        res = self.data.results
        self._done = set(int(r) for r in res["race_id"].unique())
        races = self.data.races  # chronological, the order the state replay walks
        self.races = races.set_index("race_id", drop=False)
        self.completed = races[races["race_id"].isin(self._done)]
        self.upcoming = races[~races["race_id"].isin(self._done)]
        self.lineup = last_lineup(self.data)  # default field for future races
        last = self.completed.iloc[-1]
        last_res = res[res["race_id"] == last["race_id"]]
        self._team_constructor = dict(zip(last_res["team_id"], last_res["constructor_id"]))
        self._constructor_team = (
            res[res["year"] == last["year"]].drop_duplicates("constructor_id").set_index("constructor_id")["team_id"].to_dict()
        )
        self._winners = res[res["is_winner"].astype(bool)].drop_duplicates("race_id").set_index("race_id")
        self._finish = res.drop_duplicates(KEYS).set_index(KEYS)[["finish_pos", "status"]]

        self._race_cache: dict[int, dict] = {}
        self._cache: dict[str, object] = {}
        self._locks = {k: threading.Lock() for k in ("state", "history", "outlook", "release", "live", "metrics")}
        self._runs: dict[str, dict] = {}
        self._runs_lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="forecast")
        self._load_saved_runs()

    # ------------------------------------------------------------------ warm-up
    def warm(self) -> None:
        """Fill the slow caches (run in a background thread at startup)."""
        for name, fn in (
            ("state", self.base_state),
            ("outlook", self.outlook),
            *[(f"history {m}", lambda m=m: self.history(m)) for m in MODES],
            ("release", self.release),
        ):
            try:
                fn()
            except Exception:  # an endpoint will retry and surface the error
                log.exception("warm-up of %s failed", name)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------ references
    def race_ref(self, race_id: int) -> dict:
        race_id = int(race_id)
        if race_id in self._race_cache:
            return self._race_cache[race_id]
        if race_id not in self.races.index:
            raise NotFound(f"race {race_id} is not in F1DB {self.version}")
        r = self.races.loc[race_id]
        gp, ci = self.names.grands_prix, self.names.circuits
        out = {
            "race_id": race_id,
            "year": int(r["year"]),
            "round": int(r["round"]),
            "date": pd.Timestamp(r["date"]).strftime("%Y-%m-%d"),
            "grand_prix": str(gp.loc[r["grand_prix_id"], "name"]) if r["grand_prix_id"] in gp.index else str(r["grand_prix_id"]),
            "circuit": str(ci.loc[r["circuit_id"], "name"]) if r["circuit_id"] in ci.index else str(r["circuit_id"]),
            "place": str(ci.loc[r["circuit_id"], "placeName"]) if r["circuit_id"] in ci.index else "",
            "country_id": str(ci.loc[r["circuit_id"], "countryId"]) if r["circuit_id"] in ci.index else "",
            "is_sprint": bool(r["is_sprint_weekend"]),
            "status": "completed" if race_id in self._done else "upcoming",
            "race_start_utc": _iso(r["race_start_utc"]),
            "quali_start_utc": _iso(r["quali_start_utc"]),
        }
        self._race_cache[race_id] = out
        return out

    def driver_ref(self, driver_id: str, team_id: str | None, constructor_id: str | None = None) -> dict:
        """A driver at one race; `team` is the constructor's name at that race."""
        team_id = team_id if isinstance(team_id, str) else ""
        if not isinstance(constructor_id, str):
            constructor_id = self._team_constructor.get(team_id, team_id)
        return {**self.names.driver(driver_id), "team_id": team_id, "team": self.names.constructor(constructor_id)}

    def winner_ref(self, race_id: int) -> dict | None:
        if race_id not in self._winners.index:
            return None
        w = self._winners.loc[race_id]
        return self.driver_ref(w["driver_id"], w["team_id"], w["constructor_id"])

    def _h_of(self, race_id: int) -> int:
        ids = self.upcoming["race_id"].tolist()
        return ids.index(race_id) + 1

    # ------------------------------------------------------------------ status / calendar / lineup
    def status(self) -> dict:
        last = self.completed.iloc[-1]
        nxt = self.upcoming.iloc[0] if len(self.upcoming) else None
        return {
            "data_version": self.version,
            "season": int(nxt["year"]) if nxt is not None else int(last["year"]),
            "last_race": {**self.race_ref(last["race_id"]), "winner": self.winner_ref(int(last["race_id"]))},
            "next_race": self.race_ref(nxt["race_id"]) if nxt is not None else None,
            "modes": MODE_INFO,
            "model": {"name": "Conditional logit", "train_from": 2003, "config_path": "configs/final.json"},
            "latest_release": self._cache.get("release") or {"checked": False, "tag": None, "newer": False, "update_command": None},
            "server_time": _now(),
        }

    def release(self) -> dict:
        with self._locks["release"]:
            if "release" in self._cache:
                return self._cache["release"]
            try:
                tag = latest_version(timeout=10)
            except Exception as e:  # offline, rate-limited: report "not checked"
                log.info("F1DB release check failed: %s", e)
                out = {"checked": False, "tag": None, "newer": False, "update_command": None}
            else:
                newer = tag != self.version
                cmd = f"export F1PREDICT_F1DB_VERSION={tag} && f1predict download" if newer else None
                out = {"checked": True, "tag": tag, "newer": newer, "update_command": cmd}
            self._cache["release"] = out
            return out

    def calendar(self, season: int | None = None) -> dict:
        season = season or int((self.upcoming.iloc[0] if len(self.upcoming) else self.completed.iloc[-1])["year"])
        races = self.data.races[self.data.races["year"] == season].sort_values("round")
        if races.empty:
            raise NotFound(f"no races for season {season}")
        return {"season": season, "races": [{**self.race_ref(rid), "winner": self.winner_ref(int(rid))} for rid in races["race_id"]]}

    def _upcoming_race(self, race_id: int) -> pd.Series:
        if race_id not in self.races.index:
            raise NotFound(f"race {race_id} is not in F1DB {self.version}")
        if race_id in self._done:
            raise RequestError(f"race {race_id} already has a result; forecasts are only made for upcoming races")
        return self.races.loc[race_id]

    def lineup_for(self, race_id: int) -> dict:
        self._upcoming_race(race_id)
        season = int(self.races.loc[race_id, "year"])
        res = self.data.results
        recent = set(res.loc[res["year"] >= season - 2, "driver_id"])
        prac = self.data.practice
        recent |= {d for d in prac.loc[prac["year"] >= season - 1, "driver_id"] if isinstance(d, str) and not d.startswith("unknown")}
        candidates = sorted((self.names.driver(d) for d in recent), key=lambda d: d["name"])
        entrants = [{**self.driver_ref(r.driver_id, r.team_id), "engine_id": r.engine_id} for r in self.lineup.itertuples()]
        teams = [
            {"team_id": r.team_id, "team": self.names.constructor(self._team_constructor.get(r.team_id, r.team_id)), "engine_id": r.engine_id}
            for r in self.lineup.drop_duplicates("team_id").itertuples()
        ]
        return {"race": self.race_ref(race_id), "entrants": entrants, "candidates": candidates, "teams": teams}

    # ------------------------------------------------------------------ OpenF1
    def live(self, race_id: int) -> dict:
        race = self._upcoming_race(race_id)
        key = f"live:{race_id}"
        with self._locks["live"]:
            hit = self._cache.get(key)
            if hit and (datetime.now(timezone.utc) - hit[0]).total_seconds() < 60:
                return hit[1]
            out = {"race": self.race_ref(race_id), "reachable": True, "error": None, "sessions": [], "quali": None}
            try:
                sessions = L._sessions_for(race)
                tables = L.fetch_weekend(self.data, race_id) if sessions else {}
            except Exception as e:  # network, HTTP error, rate limit
                out.update(reachable=False, error=f"OpenF1 could not be reached: {e}")
            else:
                out["sessions"] = sorted(
                    (
                        {"kind": L.SESSION_MAP[s["session_name"]], "name": s["session_name"], "ended_at": _iso(s["date_end"])}
                        for s in sessions
                    ),
                    key=lambda s: SESSION_ORDER.index(s["kind"]) if s["kind"] in SESSION_ORDER else 99,
                )
                if "quali" in tables:
                    q = tables["quali"].sort_values("quali_pos")
                    out["quali"] = [
                        {
                            "driver": self.driver_ref(r.driver_id, self._constructor_team.get(r.constructor_id, r.constructor_id), r.constructor_id),
                            "quali_pos": _int(r.quali_pos),
                            "gap_pct": _num(r.quali_gap_pct),
                        }
                        for r in q.itertuples()
                    ]
            self._cache[key] = (datetime.now(timezone.utc), out)
            return out

    # ------------------------------------------------------------------ state
    def base_state(self) -> pd.DataFrame:
        with self._locks["state"]:
            if "state" not in self._cache:
                self._cache["state"] = state_features(self.data, self.sp, horizons=1)
            return self._cache["state"]

    def _state_for(self, entry_lists: dict | None) -> pd.DataFrame:
        if not entry_lists:
            return self.base_state()
        with self._locks["state"]:
            # Disk-cached by seat assignment; the replay only reads completed races, so this weekend's
            # live/manual session rows are not needed here.
            return state_features(self.data, self.sp, entry_lists=entry_lists, horizons=1)

    # ------------------------------------------------------------------ runs: submit / validate
    def submit(self, req: dict) -> dict:
        race_id, mode = int(req["race_id"]), req["mode"]
        race = self._upcoming_race(race_id)
        if mode not in MODES:
            raise RequestError(f"unknown mode {mode!r}")
        h = self._h_of(race_id)
        if mode != "pre_weekend" and h != 1:
            nxt = self.race_ref(self.upcoming.iloc[0]["race_id"])
            raise RequestError(
                f"Weekend sessions only exist for the next race (R{nxt['round']} {nxt['grand_prix']}); "
                f"use pre_weekend for races further ahead."
            )
        field = self._field(req.get("lineup"))
        grid = req.get("grid")
        if grid is not None and mode != "pre_race":
            raise RequestError("a starting grid only applies to pre_race forecasts")
        if grid is not None:
            grid = self._validate_grid(grid, field)
        label = (req.get("label") or "").strip() or None
        if label and len(label) > 80:
            raise RequestError("label is longer than 80 characters")
        live = bool(req.get("live")) and mode != "pre_weekend"  # no weekend session feeds pre_weekend
        with self._runs_lock:
            waiting = sum(r["status"] in ("queued", "running") for r in self._runs.values())
        if waiting >= MAX_WAITING_RUNS:
            raise RequestError(f"{waiting} runs are already waiting; try again when they finish")

        run_id = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S}-{int(race['year'])}r{int(race['round']):02d}-{mode}-{uuid.uuid4().hex[:6]}"
        run = {
            "id": run_id,
            "source": "dashboard",
            "created_at": _now(),
            "status": "queued",
            "stage": "Waiting for the previous run to finish",
            "error": None,
            "race_id": race_id,
            "mode": mode,
            "h": h,
            "data_version": self.version,
            "label": label,
            "inputs": {"live": live, "sessions_used": [], "grid": "none", "lineup_changes": self._lineup_changes(field)},
            "favourite": None,
            "warnings": [],
            "rows": [],
            "request": {"race_id": race_id, "mode": mode, "live": live, "grid": grid, "lineup": req.get("lineup"), "label": label},
        }
        with self._runs_lock:
            self._runs[run_id] = run
        self._executor.submit(self._execute, run_id, field, grid)
        return {"id": run_id, "status": "queued"}

    def _field(self, lineup: list[dict] | None) -> pd.DataFrame:
        if not lineup:
            return self.lineup.copy()
        df = pd.DataFrame(lineup)[["driver_id", "team_id", "engine_id"]].astype(str)
        if df["driver_id"].duplicated().any():
            raise RequestError("a driver appears twice in the line-up")
        if not 2 <= len(df) <= 30:
            raise RequestError("a line-up needs between 2 and 30 drivers")
        unknown = set(df["team_id"]) - set(self.lineup["team_id"])
        if unknown:
            raise RequestError(f"unknown team(s): {', '.join(sorted(unknown))}")
        # A line-up change puts drivers in seats: every team keeps its cars and its power unit, which
        # is also what the run's lineup_changes (seat by seat) can describe.
        cars = self.lineup.groupby("team_id").size()
        if not df.groupby("team_id").size().reindex(cars.index, fill_value=0).equals(cars):
            raise RequestError("every team must keep its number of cars; a line-up change only swaps drivers between seats")
        engine = self.lineup.drop_duplicates("team_id").set_index("team_id")["engine_id"]
        if (df["engine_id"] != df["team_id"].map(engine)).any():
            raise RequestError("every team keeps its power unit: engine_id must match the team's")
        return df.reset_index(drop=True)

    def _is_default(self, field: pd.DataFrame) -> bool:
        seats = lambda df: set(df[["driver_id", "team_id", "engine_id"]].astype(str).itertuples(index=False))  # noqa: E731
        return seats(field) == seats(self.lineup)

    @staticmethod
    def _validate_grid(grid: list[dict], field: pd.DataFrame) -> list[dict]:
        df = pd.DataFrame(grid)
        if df.empty:
            raise RequestError("the starting grid is empty")
        if df["driver_id"].duplicated().any():
            raise RequestError("a driver appears twice on the grid")
        missing, extra = set(field["driver_id"]) - set(df["driver_id"]), set(df["driver_id"]) - set(field["driver_id"])
        if missing or extra:
            parts = ([f"missing {', '.join(sorted(missing))}"] if missing else []) + ([f"not in the field {', '.join(sorted(extra))}"] if extra else [])
            raise RequestError("the grid must list exactly the race's field: " + "; ".join(parts))
        n = len(df)
        gp = pd.to_numeric(df["grid_pos"], errors="coerce")
        if gp.isna().any() or gp.duplicated().any() or not gp.between(1, n).all() or (gp % 1 != 0).any():
            raise RequestError(f"grid positions must be distinct whole numbers from 1 to {n}")
        qp = pd.to_numeric(df["quali_pos"], errors="coerce") if "quali_pos" in df else pd.Series(np.nan, index=df.index)
        given = qp.dropna()
        if given.duplicated().any() or not given.between(1, n).all() or (given % 1 != 0).any():
            raise RequestError(f"qualifying positions must be distinct whole numbers from 1 to {n}")
        df["quali_pos"] = qp.fillna(gp)
        df["pit_lane_start"] = df.get("pit_lane_start", False)
        df["pit_lane_start"] = df["pit_lane_start"].fillna(False).astype(bool)
        # Like F1DB: numbered slots first, pit-lane starters behind the last one, each in the given order.
        df = df.assign(grid_pos=gp).sort_values(["pit_lane_start", "grid_pos"], kind="stable")
        df["grid_pos"] = np.arange(1, n + 1)
        return [
            {"driver_id": r.driver_id, "quali_pos": int(r.quali_pos), "grid_pos": int(r.grid_pos), "pit_lane_start": bool(r.pit_lane_start)}
            for r in df.itertuples()
        ]

    def _lineup_changes(self, field: pd.DataFrame) -> list[dict]:
        out = []
        default = self.lineup
        for team_id in pd.unique(pd.concat([default["team_id"], field["team_id"]])):
            before = list(default.loc[default["team_id"] == team_id, "driver_id"])
            after = list(field.loc[field["team_id"] == team_id, "driver_id"])
            outs = [d for d in before if d not in after]
            ins = [d for d in after if d not in before]
            for i, d in enumerate(ins):
                out.append(
                    {
                        "team": self.names.constructor(self._team_constructor.get(team_id, team_id)),
                        "out": self.driver_ref(outs[i], team_id) if i < len(outs) else None,
                        "in": self.driver_ref(d, team_id),
                    }
                )
        return out

    # ------------------------------------------------------------------ runs: execute
    def _set(self, run_id: str, **kw) -> None:
        with self._runs_lock:
            self._runs[run_id].update(kw)

    def _execute(self, run_id: str, field: pd.DataFrame, grid: list[dict] | None) -> None:
        run = self._runs[run_id]
        race_id, mode = run["race_id"], run["mode"]
        warnings: list[str] = []
        try:
            race = self.races.loc[race_id]
            tables: dict[str, pd.DataFrame] = {}
            if run["inputs"]["live"]:
                self._set(run_id, status="running", stage="Fetching this weekend's sessions from OpenF1")
                try:
                    tables = L.fetch_weekend(self.data, race_id)
                except Exception as e:
                    warnings.append(f"OpenF1 could not be reached ({e}), so this ran without this weekend's sessions.")
                else:
                    if not tables:
                        warnings.append("OpenF1 has no finished sessions for this weekend yet.")
            sessions = self._sessions_seen(self._sessions_in(tables), mode, race)
            data, grid_source, notes = self._scenario(race_id, mode, tables, grid, field)
            warnings += notes

            entry_lists = None if self._is_default(field) else {race_id: field}
            if entry_lists:
                first = int(self.data.races["year"].min())
                self._set(run_id, status="running", stage=f"Replaying every race since {first} for the new line-up (about 30 seconds the first time)")
            else:
                self._set(run_id, status="running", stage="Loading the replayed race state")
            state = self._state_for(entry_lists)

            self._set(run_id, status="running", stage="Fitting the model on every race since 2003")
            res = pipeline.forecast(data, self.cfg, mode, [race_id], entry_lists, state=state)
            warnings += self._weekend_warnings(race, mode, data, sessions, grid_source)

            q = data.quali[data.quali["race_id"] == race_id].drop_duplicates("driver_id").set_index("driver_id")["quali_pos"]
            g = data.grid[data.grid["race_id"] == race_id].drop_duplicates("driver_id").set_index("driver_id")["grid_pos"]
            res = res.sort_values("p", ascending=False).reset_index(drop=True)
            rows = []
            for i, r in enumerate(res.itertuples()):
                rows.append(
                    {
                        "driver": self.driver_ref(r.driver_id, r.team_id),
                        "p": float(r.p),
                        "rank": i + 1,
                        "why": parse_why(getattr(r, "why", None), self.short_halflife),
                        "quali_pos": _int(q.get(r.driver_id)) if mode == "pre_race" else None,
                        "grid_pos": _int(g.get(r.driver_id)) if mode == "pre_race" else None,
                    }
                )
            inputs = {**run["inputs"], "sessions_used": sessions, "grid": grid_source}
            self._set(
                run_id,
                status="done",
                stage=None,
                h=int(res["h"].iloc[0]),
                inputs=inputs,
                rows=rows,
                favourite={"driver": rows[0]["driver"], "p": rows[0]["p"]},
                warnings=warnings,
            )
            self._save(self._runs[run_id])
        except Exception as e:
            log.exception("forecast run %s failed", run_id)
            self._set(run_id, status="error", stage=None, error=f"{type(e).__name__}: {e}", warnings=warnings)

    @staticmethod
    def _sessions_in(tables: dict) -> list[str]:
        kinds = set()
        if "practice" in tables:
            kinds |= set(tables["practice"]["session"])
        if "sprint_q" in tables:
            kinds.add("sq")
        if "sprint" in tables:
            kinds.add("sprint")
        if "quali" in tables:
            kinds.add("q")
        return [k for k in SESSION_ORDER if k in kinds]

    def _scenario(
        self, race_id: int, mode: str, tables: dict, grid: list[dict] | None, field: pd.DataFrame
    ) -> tuple[C.F1Data, str, list[str]]:
        """Copy of the data with this weekend's live sessions and/or a manual grid for `race_id`.

        Returns (data, grid source, warnings about the grid)."""
        d = self.data
        practice, quali, sprint, grid_t = d.practice, d.quali, d.sprint, d.grid

        def put(base: pd.DataFrame, rows: pd.DataFrame) -> pd.DataFrame:
            return pd.concat([base[base["race_id"] != race_id], rows], ignore_index=True)

        if "practice" in tables:
            practice = put(practice, tables["practice"])
        if "sprint" in tables or "sprint_q" in tables:  # same merge as live.with_live_weekend
            parts = [x for x in (tables.get("sprint"), tables.get("sprint_q")) if x is not None]
            sp = parts[0]
            for extra in parts[1:]:
                cols = ["race_id", "driver_id"] + [c for c in ("sprint_quali_pos", "sq_gap_pct") if c in extra]
                sp = sp.merge(extra[cols], on=["race_id", "driver_id"], how="outer")
            sprint = put(sprint, sp)

        source = "none"
        notes: list[str] = []
        overrides = pd.DataFrame(grid) if grid else None
        if "quali" in tables:
            quali = put(quali, tables["quali"])
            ov = overrides[["driver_id", "grid_pos", "pit_lane_start"]] if overrides is not None else None
            g = L.grid_from_quali(tables["quali"], ov)
            if ov is not None:
                # A field driver OpenF1 did not classify (e.g. a car number F1DB doesn't know yet) still
                # takes the slot the user gave him, without a qualifying time.
                extra = ov[~ov["driver_id"].isin(g["driver_id"])]
                if len(extra):
                    g = pd.concat(
                        [
                            g,
                            pd.DataFrame(
                                {
                                    "race_id": race_id,
                                    "driver_id": extra["driver_id"],
                                    "grid_pos": extra["grid_pos"].astype(float),
                                    "pit_lane_start": extra["pit_lane_start"].astype(bool),
                                    "grid_penalty_places": 0.0,
                                }
                            ),
                        ],
                        ignore_index=True,
                    )
                    who = ", ".join(self.names.driver(d)["name"] for d in extra["driver_id"])
                    notes.append(f"Not in OpenF1's qualifying classification: {who}. The grid slot you set is used, without a qualifying time.")
            grid_t = put(grid_t, g)
            source = "live+overrides" if overrides is not None else "live"
        elif overrides is not None:
            team_of = dict(zip(field["driver_id"], field["team_id"]))
            o = overrides.astype({"quali_pos": float, "grid_pos": float})
            manual_q = pd.DataFrame(
                {
                    "race_id": race_id,
                    "driver_id": o["driver_id"],
                    "constructor_id": [self._team_constructor.get(team_of[x], team_of[x]) for x in o["driver_id"]],
                    "quali_pos": o["quali_pos"],
                    "quali_gap_pct": np.nan,  # no lap times: the model sees positions only
                    "q1_ms": np.nan,
                    "q2_ms": np.nan,
                    "q3_ms": np.nan,
                    "time_ms": np.nan,
                }
            )
            pit = o["pit_lane_start"].astype(bool)
            manual_g = pd.DataFrame(
                {
                    "race_id": race_id,
                    "driver_id": o["driver_id"],
                    "grid_pos": o["grid_pos"],
                    "pit_lane_start": pit,
                    # As in F1DB and live.grid_from_quali: pit-lane starts carry no penalty places.
                    "grid_penalty_places": (o["grid_pos"] - o["quali_pos"]).clip(lower=0.0).where(~pit, 0.0),
                }
            )
            quali, grid_t = put(quali, manual_q), put(grid_t, manual_g)
            source = "manual"
        data = C.F1Data(races=d.races, results=d.results, quali=quali, grid=grid_t, practice=practice, sprint=sprint, version=d.version)
        if mode != "pre_race":
            return data, "none", []
        return data, source, notes

    @staticmethod
    def _sessions_seen(sessions: list[str], mode: str, race: pd.Series) -> list[str]:
        """The fetched sessions `mode` can actually use (pre_quali never sees qualifying, etc.)."""
        if mode == "pre_weekend":
            return []
        if mode == "pre_race":
            return sessions
        is_sprint = bool(race["is_sprint_weekend"])
        allowed = set(practice_sessions_before_quali(is_sprint))
        if sprint_before_quali(int(race["year"]), is_sprint):
            allowed |= {"sq", "sprint"}
        return [s for s in sessions if s in allowed]

    def _weekend_warnings(self, race: pd.Series, mode: str, data: C.F1Data, sessions: list[str], grid_source: str) -> list[str]:
        out = []
        race_id = int(race["race_id"])
        sprint_first = bool(race["is_sprint_weekend"]) and int(race["year"]) >= SPRINT_BEFORE_QUALI_FROM
        if mode == "pre_quali":
            if not (data.practice["race_id"] == race_id).any():
                out.append(
                    "No practice sessions were available, so every driver has the same practice inputs "
                    "and this forecast rests on pre-weekend information."
                )
            if sprint_first:
                out.append(
                    "Sprint weekend: on the 2023-25 sprint weekends the after-practice model scored 1.876 log-loss "
                    "because it over-trusts the sprint result. Use the pre-weekend forecast until qualifying."
                )
        if mode == "pre_race":
            if grid_source == "none":
                out.append(
                    "No qualifying or grid data, so every driver has the same grid inputs. "
                    "Use OpenF1 qualifying or set a starting grid."
                )
            elif grid_source == "manual":
                out.append(
                    "Manual grid without lap times: the model sees positions only, "
                    "so probabilities come out flatter than with real qualifying."
                )
        return out

    # ------------------------------------------------------------------ runs: storage / listing
    def _save(self, run: dict) -> None:
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        path = self.runs_dir / f"{run['id']}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(clean(run), indent=1), encoding="utf-8")
        tmp.replace(path)

    def _load_saved_runs(self) -> None:
        if not self.runs_dir.exists():
            return
        for path in sorted(self.runs_dir.glob("*.json")):
            try:
                run = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                log.warning("skipping unreadable run file %s", path)
                continue
            if RUN_ID.match(run.get("id", "")) and int(run.get("race_id", -1)) in self.races.index:
                self._runs[run["id"]] = run

    def _cli_runs(self) -> list[dict]:
        """Forecasts written by `f1predict predict` (predictions/<year>_r<round>_<circuit>_<mode>.csv)."""
        out = []
        for path in sorted(self.predictions_dir.glob("*.csv")):
            m = CLI_FILE.match(path.name)
            if not m:
                continue
            try:
                df = pd.read_csv(path)
                race_id = int(df["race_id"].iloc[0])
                self.race_ref(race_id)
            except (OSError, KeyError, ValueError, IndexError, pd.errors.ParserError):
                log.warning("skipping unreadable CLI forecast %s", path)
                continue
            df = df.sort_values("p", ascending=False).reset_index(drop=True)
            rows = [
                {
                    "driver": self.driver_ref(r.driver_id, r.team_id),
                    "p": float(r.p),
                    "rank": i + 1,
                    "why": parse_why(getattr(r, "why", None), self.short_halflife),
                    "quali_pos": None,
                    "grid_pos": None,
                }
                for i, r in enumerate(df.itertuples())
            ]
            created = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            out.append(
                {
                    "id": f"cli-{path.stem}",
                    "source": "cli",
                    "created_at": created,
                    "status": "done",
                    "stage": None,
                    "error": None,
                    "race_id": race_id,
                    "mode": m["mode"],
                    "h": int(df["h"].iloc[0]) if "h" in df else 1,
                    "data_version": "unknown",
                    "label": None,
                    "inputs": {"live": False, "sessions_used": [], "grid": "none", "lineup_changes": []},
                    "favourite": {"driver": rows[0]["driver"], "p": rows[0]["p"]},
                    "warnings": [],
                    "rows": rows,
                }
            )
        return out

    def _present(self, run: dict, full: bool) -> dict:
        """A stored run as the API shape: RaceRef, outcome and finish positions resolved against the data."""
        race_id = int(run["race_id"])
        out = {k: run[k] for k in ("id", "source", "created_at", "status", "stage", "error", "mode", "h", "data_version", "label", "inputs", "favourite", "warnings")}
        out["race"] = self.race_ref(race_id)
        out["outcome"] = None
        winner = self.winner_ref(race_id) if run["status"] == "done" else None
        if winner is not None and run["rows"]:
            ps = {r["driver"]["driver_id"]: (r["p"], r["rank"]) for r in run["rows"]}
            p, rank = ps.get(winner["driver_id"], (0.0, len(run["rows"]) + 1))
            out["outcome"] = {
                "winner": winner,
                "p_winner": p,
                "winner_rank": rank,
                "favourite_won": rank == 1,
                "logloss": _logloss(p),
            }
        if full:
            rows = []
            for r in run["rows"]:
                fin = self._finish.loc[(race_id, r["driver"]["driver_id"])] if (race_id, r["driver"]["driver_id"]) in self._finish.index else None
                rows.append({**r, "finish_pos": _int(fin["finish_pos"]) if fin is not None else None})
            out["rows"] = rows
        return out

    def runs(self) -> dict:
        with self._runs_lock:
            mine = list(self._runs.values())
        everything = mine + self._cli_runs()
        everything.sort(key=lambda r: r["created_at"], reverse=True)
        return {"runs": [self._present(r, full=False) for r in everything]}

    def run(self, run_id: str) -> dict:
        if not RUN_ID.match(run_id):
            raise NotFound(run_id)
        with self._runs_lock:
            run = self._runs.get(run_id)
        if run is None:
            run = next((r for r in self._cli_runs() if r["id"] == run_id), None)
        if run is None:
            raise NotFound(f"no run {run_id}")
        return self._present(run, full=True)

    def delete_run(self, run_id: str) -> None:
        if not RUN_ID.match(run_id) or run_id.startswith("cli-"):
            raise RequestError("only runs made in the dashboard can be deleted")
        with self._runs_lock:
            run = self._runs.get(run_id)
            if run is None:
                raise NotFound(f"no run {run_id}")
            if run["status"] in ("queued", "running"):
                raise RequestError("this run is still in progress")
            del self._runs[run_id]
        (self.runs_dir / f"{run_id}.json").unlink(missing_ok=True)

    # ------------------------------------------------------------------ outlook
    def outlook(self) -> dict:
        with self._locks["outlook"]:
            if "outlook" in self._cache:
                return self._cache["outlook"]
            last = self.completed.iloc[-1]
            if self.upcoming.empty:  # season over: an empty outlook, not an error
                out = {"data_version": self.version, "after": self.race_ref(last["race_id"]), "races": [], "drivers": []}
                self._cache["outlook"] = out
                return out
            res = pipeline.forecast(self.data, self.cfg, "pre_weekend", state=self.base_state())
            order = res.drop_duplicates("race_id").sort_values("date")
            race_ids = order["race_id"].tolist()
            wide = res.pivot_table(index="driver_id", columns="race_id", values="p", aggfunc="first").reindex(columns=race_ids).fillna(0.0)
            team = res.drop_duplicates("driver_id").set_index("driver_id")["team_id"]
            drivers = []
            for d, ps in wide.iterrows():
                p = [float(x) for x in ps.to_numpy()]
                drivers.append(
                    {
                        "driver": self.driver_ref(d, team.get(d)),
                        "p": p,
                        "expected_wins": float(sum(p)),
                        "p_at_least_one": float(1 - np.prod([1 - x for x in p])),
                    }
                )
            drivers.sort(key=lambda x: x["expected_wins"], reverse=True)
            out = {
                "data_version": self.version,
                "after": self.race_ref(last["race_id"]),
                "races": [{**self.race_ref(r.race_id), "h": int(r.h)} for r in order.itertuples()],
                "drivers": drivers,
            }
            self._cache["outlook"] = out
            return out

    # ------------------------------------------------------------------ history (walk-forward backtest)
    @staticmethod
    def _split_of(year: int) -> str | None:
        return next((s for s, ys in SPLITS.items() if year in ys), None)

    def _baseline(self, mode: str) -> dict:
        b = self.cfg["modes"][mode]["reference_baseline"]
        return {"id": b, "label": BASELINE_LABELS.get(b, b)}

    def _history_frame(self, mode: str) -> pd.DataFrame:
        key = f"hframe:{mode}"
        if key in self._cache:
            return self._cache[key]
        final = pipeline.stacked_predictions(self.cfg, mode)
        final = final[final["h"] == 1][["race_id", "driver_id", "year", "round", "date", "is_winner", "p"]]
        base = pipeline.load_oos(mode, self._baseline(mode)["id"])[KEYS + ["p"]].rename(columns={"p": "p_base"})
        res = self.data.results.drop_duplicates(KEYS)[KEYS + ["team_id", "constructor_id", "finish_pos", "status"]]
        df = final.merge(base, on=KEYS, how="left").merge(res, on=KEYS, how="left")
        df = df.sort_values(["date", "race_id", "p", "driver_id"], ascending=[True, True, False, True]).reset_index(drop=True)
        df["rank"] = df.groupby("race_id")["p"].rank(ascending=False, method="min").astype(int)
        df["split"] = [self._split_of(int(y)) for y in df["year"]]
        df = df[df["split"].notna()]
        self._cache[key] = df
        return df

    def history(self, mode: str) -> dict:
        if mode not in MODES:
            raise RequestError(f"unknown mode {mode!r}")
        with self._locks["history"]:
            key = f"history:{mode}"
            if key in self._cache:
                return self._cache[key]
            df = self._history_frame(mode)
            races = []
            for race_id, g in df.groupby("race_id", sort=False):
                w = g[g["is_winner"].astype(bool)]
                if len(w) != 1:  # same rule as evaluation.metrics.race_scores
                    continue
                w, fav = w.iloc[0], g.iloc[0]
                races.append(
                    {
                        "race": self.race_ref(race_id),
                        "split": w["split"],
                        "field_size": int(len(g)),
                        "favourite": {"driver": self.driver_ref(fav["driver_id"], fav["team_id"], fav["constructor_id"]), "p": float(fav["p"])},
                        "winner": {"driver": self.driver_ref(w["driver_id"], w["team_id"], w["constructor_id"]), "p": float(w["p"]), "rank": int(w["rank"])},
                        "favourite_won": bool(int(w["rank"]) == 1),
                        "logloss": _logloss(w["p"]),
                        "baseline_logloss": _logloss(w["p_base"]) if pd.notna(w["p_base"]) else None,
                    }
                )
            scopes = {"all": df}
            scopes.update({s: df[df["split"] == s] for s in SPLITS})
            scopes.update({str(y): g for y, g in df.groupby("year")})
            out = {
                "mode": mode,
                "baseline": self._baseline(mode),
                "splits": [{"id": s, "label": SPLIT_LABELS[s], "seasons": list(ys)} for s, ys in SPLITS.items()],
                "races": races,
                "calibration": {k: self._calibration(g) for k, g in scopes.items()},
            }
            self._cache[key] = out
            return out

    @staticmethod
    def _calibration(df: pd.DataFrame) -> list[dict]:
        bins = pd.cut(df["p"], CALIBRATION_EDGES, right=False)
        out = []
        for interval, g in df.groupby(bins, observed=True):
            if g.empty:
                continue
            out.append(
                {
                    "lo": float(interval.left),
                    "hi": float(min(interval.right, 1.0)),
                    "n": int(len(g)),
                    "mean_p": float(g["p"].mean()),
                    "win_rate": float(g["is_winner"].astype(bool).mean()),
                }
            )
        return out

    def history_race(self, race_id: int) -> dict:
        race_id = int(race_id)
        modes = {}
        split = None
        for mode in MODES:
            self.history(mode)  # fills the frame cache under the lock
            df = self._history_frame(mode)
            g = df[df["race_id"] == race_id]
            if g.empty:
                continue
            w = g[g["is_winner"].astype(bool)]
            if len(w) != 1:
                continue
            w = w.iloc[0]
            split = w["split"]
            modes[mode] = {
                "rows": [
                    {
                        "driver": self.driver_ref(r.driver_id, r.team_id, r.constructor_id),
                        "p": float(r.p),
                        "rank": int(r.rank),
                        "finish_pos": _int(r.finish_pos),
                        "status": str(r.status) if isinstance(r.status, str) else "",
                    }
                    for r in g.itertuples()
                ],
                "p_winner": float(w["p"]),
                "winner_rank": int(w["rank"]),
                "logloss": _logloss(w["p"]),
                "baseline_logloss": _logloss(w["p_base"]) if pd.notna(w["p_base"]) else None,
            }
        if not modes:
            raise NotFound(f"no backtest forecasts for race {race_id}")
        return {"race": self.race_ref(race_id), "split": split, "winner": self.winner_ref(race_id), "modes": modes}

    # ------------------------------------------------------------------ metrics (reports/evaluation.json)
    def metrics(self) -> dict:
        with self._locks["metrics"]:
            if "metrics" in self._cache:
                return self._cache["metrics"]
            ev = json.loads((REPORTS_DIR / "evaluation.json").read_text(encoding="utf-8"))
            modes = {}
            for mode in MODES:
                m = ev["modes"][mode]
                bid = m["reference_baseline"]
                splits = {}
                for split, key in EVAL_SPLIT_KEYS.items():
                    s = m["splits"][key]
                    f, vb, t = s["final"], s["vs_baseline"], s["temperature"]
                    splits[split] = {
                        "races": f["races"],
                        "logloss": f["logloss"],
                        "top1": f["top1"],
                        "top3": f["top3"],
                        "mean_p_winner": f["mean_p_winner"],
                        "baseline_logloss": s["models"][bid]["logloss"],
                        "vs_baseline": {k: vb[k] for k in ("diff", "ci_low", "ci_high", "seasons_better", "seasons")},
                        "temperature": {k: t[k] for k in ("T", "T_lo", "T_hi")},
                    }
                modes[mode] = {"baseline": {"id": bid, "label": BASELINE_LABELS.get(bid, bid)}, "splits": splits}
            hz = ev["modes"]["pre_weekend"].get("horizons", {})
            out = {
                "data_version": ev.get("config", {}).get("data_version", self.version),
                "modes": modes,
                "horizons": [{"h": int(h), "logloss": v["test"]["logloss"]} for h, v in sorted(hz.items(), key=lambda kv: int(kv[0]))],
            }
            out = clean(out)
            self._cache["metrics"] = out
            return out
