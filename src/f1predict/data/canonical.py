"""Turn raw F1DB CSVs into the tidy tables the feature pipeline is built on.

Tables (all keyed by integer `race_id` and string `driver_id`):

races     one row per championship race (Indianapolis 500 rounds of 1950-60 are dropped)
results   one row per (race, driver) that took part in the Grand Prix itself
quali     one row per (race, driver) with a qualifying classification
grid      one row per (race, driver) on the starting grid (incl. pit-lane starters)
practice  one row per (race, session, driver) for FP1..FP4
sprint    one row per (race, driver) with sprint qualifying / sprint race results
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from f1predict.config import F1DB_VERSION, NON_REPRESENTATIVE_RACES, PROCESSED_DIR, RACE_FUEL_Q3_YEARS
from f1predict.data.download import f1db_dir

TABLES = ("races", "results", "quali", "grid", "practice", "sprint")

# Statuses that mean the driver never took part in the race.
NOT_ENTERED = {"DNQ", "DNPQ", "DNP"}

_TYRE = re.compile(r"puncture|tyre|tire")
_INCIDENT = re.compile(r"accident|collision|spun|spin\b|damage|crash|broken wing|front wing")
_NON_RACING = re.compile(
    r"illegal|ignored|disqualif|underweight|infringement|withdrew|physical|injur|unwell|illness|unfit|"
    r"reserve driver|practice only|money|safety concerns|car raced by|camera car|push start|outside assistance|"
    r"failed|misled|too slowly|wrong tyres|weight check|seized|rejoined|overtaking on formation lap|incorrect|reversed|"
    r"dispute|shortage|fuel sample|brake fluid|not ready|unraceworthy|fatal"
)


def classify_retirement(reason: object) -> str | None:
    """Map F1DB's free-text `reasonRetired` to incident / mechanical / other (None if no retirement)."""
    if not isinstance(reason, str) or not reason.strip():
        return None
    text = reason.lower()
    if _NON_RACING.search(text):
        return "other"
    if _TYRE.search(text):  # tyre failures / debris punctures: not the driver's doing
        return "mechanical"
    if _INCIDENT.search(text):
        return "incident"
    return "mechanical"


def _read(raw_dir: Path, name: str) -> pd.DataFrame:
    return pd.read_csv(raw_dir / f"f1db-{name}.csv", low_memory=False)


def _utc(date: pd.Series, time: pd.Series) -> pd.Series:
    stamp = date.astype("string") + " " + time.fillna("00:00").astype("string")
    return pd.to_datetime(stamp.where(date.notna()), utc=True, errors="coerce")


def team_lineage(raw_dir: Path) -> pd.DataFrame:
    """(constructor_id, year) -> team_id, following F1DB's constructor chronology through rebrands.

    e.g. sauber 2018 -> alfa-romeo 2019 -> kick-sauber 2024 -> audi 2026 all share one team_id.
    Ranges are respected, so the 1950s works Alfa Romeo is *not* merged with the 2019 Sauber rebrand.
    """
    chrono = _read(raw_dir, "constructors-chronology")
    chrono["yearTo"] = chrono["yearTo"].fillna(9999)
    # Several parents can describe the same chain; key each chain by the constructor id of its most
    # recent member so the team_id is today's name.
    latest = (
        chrono.sort_values(["parentConstructorId", "positionDisplayOrder"])
        .groupby("parentConstructorId")
        .tail(1)
        .set_index("parentConstructorId")
    )
    rows = []
    for parent, chain in chrono.groupby("parentConstructorId"):
        key = latest.loc[parent, "constructorId"]
        for rec in chain.itertuples():
            for year in range(int(rec.yearFrom), int(min(rec.yearTo, 2100)) + 1):
                rows.append((rec.constructorId, year, key, latest.loc[parent, "yearFrom"]))
    lineage = pd.DataFrame(rows, columns=["constructor_id", "year", "team_id", "_recency"])
    # A (constructor, year) covered by two different chains: prefer the chain that is most current.
    lineage = (
        lineage.sort_values("_recency", ascending=False)
        .drop_duplicates(["constructor_id", "year"])
        .drop(columns="_recency")
    )
    # Results use (constructor, year) pairs the chronology's ranges miss (e.g. 'sauber' 2010, which
    # the chronology files under bmw-sauber 2006-10): attach them to a chain the constructor joins
    # within a year. Remaining namesakes of a chain key (1950s 'mercedes') get their own id.
    results = _read(raw_dir, "races-race-results")[["constructorId", "year"]].drop_duplicates()
    results.columns = ["constructor_id", "year"]
    known = set(zip(lineage["constructor_id"], lineage["year"]))
    chain_keys = set(lineage["team_id"])
    extra = []
    for c, y in zip(results["constructor_id"], results["year"]):
        if (c, y) in known:
            continue
        near = lineage[(lineage["constructor_id"] == c) & lineage["year"].isin([y - 1, y + 1])]
        if len(near):
            extra.append((c, y, near["team_id"].iloc[0]))
        elif c in chain_keys:
            extra.append((c, y, f"{c}@{y // 10 * 10}s"))
    if extra:
        lineage = pd.concat([lineage, pd.DataFrame(extra, columns=["constructor_id", "year", "team_id"])], ignore_index=True)
    return lineage


def build_races(raw_dir: Path) -> pd.DataFrame:
    r = _read(raw_dir, "races")
    sprint_ids = set(_read(raw_dir, "races-sprint-race-results")["raceId"])
    races = pd.DataFrame(
        {
            "race_id": r["id"].astype(int),
            "year": r["year"].astype(int),
            "round": r["round"].astype(int),
            "date": pd.to_datetime(r["date"]),
            "grand_prix_id": r["grandPrixId"],
            "circuit_id": r["circuitId"],
            "circuit_layout_id": r["circuitLayoutId"],
            "circuit_type": r["circuitType"],
            "qualifying_format": r["qualifyingFormat"],
            "is_sprint_weekend": r["id"].isin(sprint_ids) | r["sprintQualifyingFormat"].notna(),
            "race_start_utc": _utc(r["date"], r["time"]),
            "quali_start_utc": _utc(r["qualifyingDate"], r["qualifyingTime"]),
        }
    )
    races["is_nonrepresentative"] = races["race_id"].isin(NON_REPRESENTATIVE_RACES)
    races = races[races["grand_prix_id"] != "indianapolis"]
    return races.sort_values(["date", "round"]).reset_index(drop=True)


def build_results(raw_dir: Path, races: pd.DataFrame, lineage: pd.DataFrame) -> pd.DataFrame:
    rr = _read(raw_dir, "races-race-results")
    rr = rr[rr["raceId"].isin(races["race_id"])]
    # 1950s shared drives: one driver can appear twice in a race; keep the better classified car.
    rr = rr.sort_values(["raceId", "positionDisplayOrder"]).drop_duplicates(["raceId", "driverId"], keep="first")
    rr = rr[~rr["positionText"].isin(NOT_ENTERED)]

    status = np.where(rr["positionNumber"].notna(), "FIN", rr["positionText"])
    res = pd.DataFrame(
        {
            "race_id": rr["raceId"].astype(int),
            "year": rr["year"].astype(int),
            "driver_id": rr["driverId"],
            "constructor_id": rr["constructorId"],
            "engine_id": rr["engineManufacturerId"],
            "finish_pos": rr["positionNumber"],
            "display_order": rr["positionDisplayOrder"].astype(int),
            "status": status,
            "laps_completed": rr["laps"],
            "points": rr["points"].fillna(0.0),
            "dnf_cause": rr["reasonRetired"].map(classify_retirement),
        }
    )
    res.loc[res["status"].isin(["DSQ", "EX"]), "dnf_cause"] = "other"
    res.loc[(res["status"] == "DNF") & res["dnf_cause"].isna(), "dnf_cause"] = "mechanical"
    res["classified"] = res["status"] == "FIN"
    # Shared drives (1950s) put two drivers on P1: credit the first listed only.
    first = res.loc[res["finish_pos"] == 1].sort_values("display_order").drop_duplicates("race_id").index
    res["is_winner"] = res.index.isin(first)
    res = res.merge(lineage, on=["constructor_id", "year"], how="left")
    res["team_id"] = res["team_id"].fillna(res["constructor_id"])
    return res.reset_index(drop=True)


GAP_CLIP_PCT = 3.0  # gaps beyond 3% are noise (rain, traffic, no proper lap) for winner prediction


def stitched_gap_pct(session: pd.DataFrame, use_q3: bool = True) -> pd.Series:
    """Qualifying gap to pole in %, comparable across knockout segments ("stitched").

    Each driver is measured inside the deepest segment they set a time in (a Q1 lap vs a Q3 pole lap
    would mostly measure track evolution), then shifted onto the deeper segment's scale by the
    *median* offset between the two segments among drivers who ran both — a median, so one wet or
    compromised lap cannot shift every eliminee. Single-session formats (pre-2006) use the one best
    time. Clipped to [0, GAP_CLIP_PCT].
    """
    segs = ["q1Millis", "q2Millis"] + (["q3Millis"] if use_q3 else [])
    times = session[segs]
    if times.notna().sum().sum() == 0:
        t = session["timeMillis"]
        return (100 * (t / t.min() - 1)).clip(0, GAP_CLIP_PCT)
    gaps = 100 * (times / times.min() - 1)
    deepest = times.notna().to_numpy()[:, ::-1].argmax(axis=1)  # 0 = deepest listed segment
    deepest = len(segs) - 1 - deepest
    deepest[times.isna().all(axis=1).to_numpy()] = -1
    stitched = pd.Series(np.nan, index=session.index)
    for k in range(len(segs) - 1, -1, -1):
        mine = deepest == k
        g = gaps.iloc[:, k]
        if k == len(segs) - 1:
            stitched[mine] = g[mine]
            continue
        deeper = (deepest > k) & g.notna().to_numpy() & stitched.notna().to_numpy()
        offset = float((stitched[deeper] - g[deeper]).median()) if deeper.any() else 0.0
        stitched[mine] = g[mine] + max(offset, 0.0)
    return stitched.clip(0, GAP_CLIP_PCT)


def _quali_table(q: pd.DataFrame, pos_name: str, gap_name: str) -> pd.DataFrame:
    q = q.sort_values(["raceId", "positionDisplayOrder"]).drop_duplicates(["raceId", "driverId"], keep="first")
    gap = pd.concat(
        [stitched_gap_pct(g, use_q3=int(g["year"].iloc[0]) not in RACE_FUEL_Q3_YEARS) for _, g in q.groupby("raceId")]
    )
    return pd.DataFrame(
        {
            "race_id": q["raceId"].astype(int),
            "driver_id": q["driverId"],
            "constructor_id": q["constructorId"],
            pos_name: q["positionNumber"],
            gap_name: gap.reindex(q.index),
            "q1_ms": q["q1Millis"],
            "q2_ms": q["q2Millis"],
            "q3_ms": q["q3Millis"],
            "time_ms": q["timeMillis"],
        }
    ).reset_index(drop=True)


def build_quali(raw_dir: Path, races: pd.DataFrame) -> pd.DataFrame:
    q = _read(raw_dir, "races-qualifying-results")
    return _quali_table(q[q["raceId"].isin(races["race_id"])], "quali_pos", "quali_gap_pct")


def build_grid(raw_dir: Path, races: pd.DataFrame) -> pd.DataFrame:
    g = _read(raw_dir, "races-starting-grid-positions")
    g = g[g["raceId"].isin(races["race_id"])]
    g = g.sort_values(["raceId", "positionDisplayOrder"]).drop_duplicates(["raceId", "driverId"], keep="first")
    pit_lane = g["positionText"].eq("PL")
    # Pit-lane starters line up behind the last numbered slot, in F1DB's display order.
    last_slot = g.groupby("raceId")["positionNumber"].transform("max")
    pl_rank = g["positionDisplayOrder"].where(pit_lane).groupby(g["raceId"]).rank()
    grid_pos = g["positionNumber"].where(~pit_lane, last_slot + pl_rank)
    n_grid = g.groupby("raceId")["driverId"].transform("size")
    # "Start from back" penalties have no number in F1DB; numeric back-of-grid ones are 60, 70, ...
    sfb = g["gridPenalty"].eq("SFB")
    places = g["gridPenaltyPositions"].fillna(0.0)
    places = places.where(~sfb, (n_grid - g["qualificationPositionNumber"]).clip(lower=0))
    out = pd.DataFrame(
        {
            "race_id": g["raceId"].astype(int),
            "driver_id": g["driverId"],
            "grid_pos": grid_pos.astype(float),
            "pit_lane_start": pit_lane,
            "grid_penalty_places": places.clip(upper=n_grid).fillna(0.0).astype(float),
        }
    )
    return out.reset_index(drop=True)


def build_practice(raw_dir: Path, races: pd.DataFrame, lineage: pd.DataFrame) -> pd.DataFrame:
    """FP1..FP4 classifications. Rows include reserve drivers, so a car keeps a pace signal even
    when its race driver sat the session out (`car_fp_gap_pct`)."""
    frames = []
    for n in (1, 2, 3, 4):
        p = _read(raw_dir, f"races-free-practice-{n}-results")
        p = p[p["raceId"].isin(races["race_id"])]
        p = p.sort_values(["raceId", "positionDisplayOrder"]).drop_duplicates(["raceId", "driverId"], keep="first")
        fastest = p.groupby("raceId")["timeMillis"].transform("min")
        frames.append(
            pd.DataFrame(
                {
                    "race_id": p["raceId"].astype(int),
                    "year": p["year"].astype(int),
                    "session": f"fp{n}",
                    "driver_id": p["driverId"],
                    "constructor_id": p["constructorId"],
                    "fp_best_ms": p["timeMillis"],
                    "fp_gap_pct": (100 * (p["timeMillis"] / fastest - 1.0)).clip(0.0, GAP_CLIP_PCT),
                }
            )
        )
    prac = pd.concat(frames, ignore_index=True)
    prac = prac.merge(lineage, left_on=["constructor_id", "year"], right_on=["constructor_id", "year"], how="left")
    prac["team_id"] = prac["team_id"].fillna(prac["constructor_id"])
    prac["car_fp_gap_pct"] = prac.groupby(["race_id", "session", "team_id"])["fp_gap_pct"].transform("min")
    return prac


def build_sprint(raw_dir: Path, races: pd.DataFrame) -> pd.DataFrame:
    s = _read(raw_dir, "races-sprint-race-results")
    s = s[s["raceId"].isin(races["race_id"])]
    sq = _read(raw_dir, "races-sprint-qualifying-results")
    sq = sq[sq["raceId"].isin(races["race_id"])]
    sprint = pd.DataFrame(
        {
            "race_id": s["raceId"].astype(int),
            "driver_id": s["driverId"],
            "sprint_pos": s["positionNumber"],
            "sprint_grid": s["gridPositionNumber"],
            "sprint_points": s["points"].fillna(0.0),
        }
    )
    sq = _quali_table(sq, "sprint_quali_pos", "sq_gap_pct")[["race_id", "driver_id", "sprint_quali_pos", "sq_gap_pct"]]
    return sprint.merge(sq, on=["race_id", "driver_id"], how="outer")


@dataclass
class F1Data:
    races: pd.DataFrame
    results: pd.DataFrame
    quali: pd.DataFrame
    grid: pd.DataFrame
    practice: pd.DataFrame
    sprint: pd.DataFrame
    version: str = F1DB_VERSION


def build_all(version: str = F1DB_VERSION, raw_dir: Path | None = None) -> F1Data:
    raw_dir = raw_dir or f1db_dir(version)
    races = build_races(raw_dir)
    lineage = team_lineage(raw_dir)
    return F1Data(
        races=races,
        results=build_results(raw_dir, races, lineage),
        quali=build_quali(raw_dir, races),
        grid=build_grid(raw_dir, races),
        practice=build_practice(raw_dir, races, lineage),
        sprint=build_sprint(raw_dir, races),
        version=version,
    )


def processed_dir(version: str = F1DB_VERSION) -> Path:
    return PROCESSED_DIR / version


def save(data: F1Data) -> Path:
    out = processed_dir(data.version)
    out.mkdir(parents=True, exist_ok=True)
    for name in TABLES:
        getattr(data, name).to_parquet(out / f"{name}.parquet", index=False)
    return out


def load(version: str = F1DB_VERSION) -> F1Data:
    src = processed_dir(version)
    if not (src / "races.parquet").exists():
        raise FileNotFoundError(f"no processed data for {version}; run `f1predict download` first")
    return F1Data(**{name: pd.read_parquet(src / f"{name}.parquet") for name in TABLES}, version=version)
