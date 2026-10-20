"""Chronological state engine: replays every race since 1950 and snapshots pre-race features.

Leakage-safety is structural: for each race we first *snapshot* features for its entrants from the
current state (which only contains earlier races), and only then *update* the state with that race's
results. Nothing about race r can reach r's own features.

State components
* pace filter   Kalman local-level filter on each team's qualifying pace (stitched gap to pole, %),
                with driver offsets learned from same-segment teammate deltas. Offsets are used
                *centred within the current line-up* (a pair identifies only their difference), so
                team pace carries no arbitrary per-team constant. The core strength signal.
* race Elo      additive driver + team ratings from pairwise finishing order (mechanical DNFs do not
                count against the driver).
* form          exponentially weighted points / wins / podiums / qualifying, per driver and per team.
* reliability   team and power-unit mechanical-DNF rates, driver incident rate.
* season book   championship points (incl. sprints), wins, standings.
* circuit       team's pace residual at this circuit on previous visits (car-track affinity).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from f1predict.config import MAJOR_RESETS, MINOR_RESETS, PU_RESETS, RACE_FUEL_Q3_YEARS

MODERN_POINTS = {1: 25, 2: 18, 3: 15, 4: 12, 5: 10, 6: 8, 7: 6, 8: 4, 9: 2, 10: 1}
DELTA_CLIP_PCT = 1.5  # teammate deltas beyond this are compromised laps, not pace
GAP_CENSOR_PCT = 3.0  # quali gaps at the canonical clip are censored, not measurements
HUBER_K_PCT = 0.4  # innovations beyond this get proportionally less weight in the offset filter


@dataclass(frozen=True)
class StateParams:
    """Hyper-parameters of the online state (tuned on the validation seasons)."""

    # race Elo (log-odds units)
    k_driver: float = 0.12
    k_team: float = 0.30
    team_carry: float = 0.75
    team_carry_minor: float = 0.55
    team_carry_major: float = 0.35
    driver_carry: float = 0.95
    new_team_rating: float = -0.6
    new_driver_rating: float = -0.3
    sprint_k_scale: float = 0.5
    # team pace filter (units: % gap to pole)
    pace_obs_var: float = 0.06
    pace_proc_var: float = 0.005
    pace_proc_var_early: float = 0.03  # first `early_rounds` of a season: development is fastest
    early_rounds: int = 4
    pace_rho: float = 0.85  # season-to-season persistence of team pace (relative to field mean)
    pace_rho_minor: float = 0.6
    pace_rho_major: float = 0.4
    pace_season_var: float = 0.05
    pace_season_var_minor: float = 0.15
    pace_season_var_major: float = 0.4
    new_team_offset: float = 0.3  # a debut team starts this far behind the slowest known team
    new_team_var: float = 1.0
    sq_obs_var_scale: float = 1.5  # sprint qualifying is a noisier pace observation
    # driver offsets (teammate-relative)
    offset_obs_var: float = 0.05
    offset_proc_var: float = 0.001
    rookie_offset: float = 0.1
    rookie_var: float = 0.05
    switch_shrink: float = 0.5
    switch_var: float = 0.02
    # form EWMs
    form_halflives: tuple[int, ...] = (3, 10)
    form_season_carry: float = 0.5


class Ewm:
    """Bias-corrected exponentially weighted mean per key; missing observations are skipped."""

    def __init__(self, halflife: float):
        self.lam = 0.5 ** (1.0 / halflife)
        self.s: dict = defaultdict(float)
        self.w: dict = defaultdict(float)

    def update(self, key, x: float) -> None:
        if x is None or not np.isfinite(x):
            return
        self.s[key] = self.lam * self.s[key] + x
        self.w[key] = self.lam * self.w[key] + 1.0

    def get(self, key) -> float:
        w = self.w.get(key, 0.0)
        return self.s[key] / w if w > 0 else np.nan

    def weight(self, key) -> float:
        return self.w.get(key, 0.0)

    def shrink(self, factor: float, pred=None) -> None:
        for k in list(self.w):
            if pred is None or pred(k):
                self.s[k] *= factor
                self.w[k] *= factor


def _pairwise_gradient(strength: np.ndarray, order: np.ndarray) -> np.ndarray:
    """d/ds of the average pairwise log-likelihood that the observed order happened.

    `order` is a rank (lower = better); P(i ahead of j) = sigmoid(s_i - s_j).
    """
    n = len(strength)
    if n < 2:
        return np.zeros(n)
    diff = strength[:, None] - strength[None, :]
    p = 1.0 / (1.0 + np.exp(-diff))
    outcome = (order[:, None] < order[None, :]).astype(float)
    outcome[order[:, None] == order[None, :]] = 0.5
    np.fill_diagonal(outcome, 0.0)
    np.fill_diagonal(p, 0.0)
    return (outcome - p).sum(axis=1) / (n - 1)


def _segment_times(row, race_fuel_q3: bool) -> list[float]:
    """Qualifying times by knockout segment (single-session formats: one entry)."""
    segs = [row.q1_ms, row.q2_ms] + ([] if race_fuel_q3 else [row.q3_ms])
    if all(not np.isfinite(t) for t in segs):
        return [row.time_ms]
    return segs


def teammate_delta(a, b, race_fuel_q3: bool) -> float:
    """100*ln(t_a/t_b) in the deepest segment both drivers ran (NaN if none)."""
    ta, tb = _segment_times(a, race_fuel_q3), _segment_times(b, race_fuel_q3)
    for x, y in zip(reversed(ta), reversed(tb)):
        if np.isfinite(x) and np.isfinite(y) and x > 0 and y > 0:
            return float(np.clip(100 * np.log(x / y), -DELTA_CLIP_PCT, DELTA_CLIP_PCT))
    return np.nan


@dataclass
class SeasonBook:
    """Championship accumulators for the season in progress (actual points incl. sprints)."""

    driver_pts: dict = field(default_factory=lambda: defaultdict(float))
    team_pts: dict = field(default_factory=lambda: defaultdict(float))
    driver_wins: dict = field(default_factory=lambda: defaultdict(int))
    team_wins: dict = field(default_factory=lambda: defaultdict(int))
    races_run: int = 0

    @staticmethod
    def positions(pts: dict) -> dict:
        ranked = sorted(pts.items(), key=lambda kv: -kv[1])
        out, last_val, last_pos = {}, None, 0
        for i, (k, v) in enumerate(ranked, start=1):
            if v != last_val:
                last_pos, last_val = i, v
            out[k] = last_pos
        return out


class StateEngine:
    def __init__(self, params: StateParams | None = None):
        self.p = params or StateParams()
        # race Elo
        self.d_rating: dict = {}
        self.t_rating: dict = {}
        # pace filter
        self.pace_m: dict = {}
        self.pace_v: dict = {}
        self.team_last_year: dict = {}
        self.off_m: dict = {}
        self.off_v: dict = {}
        self.off_cov: dict = {}  # (driver_a, driver_b) sorted -> cross-covariance of their offsets
        self.last_mate: dict = {}  # driver -> teammate of their last offset update
        self.driver_team: dict = {}
        self.team_engine: dict = {}
        # form / reliability
        self.ewm = {h: Ewm(h) for h in self.p.form_halflives}
        self.ewm_slow = Ewm(10)
        self.circ = Ewm(2)  # team pace residual per circuit, over visits
        self.career_starts: dict = defaultdict(int)
        self.career_wins: dict = defaultdict(int)
        self.team_starts: dict = defaultdict(int)
        self.season = SeasonBook()
        self.prev_driver_pos: dict = {}
        self.prev_team_pos: dict = {}
        self.year: int | None = None
        self.races_since_reset = 0

    # ------------------------------------------------------------------ season handling
    def begin_race(self, race) -> None:
        """Advance the clock to `race` (season roll-over happens here, never in snapshot)."""
        if race["year"] != self.year:
            self._start_season(int(race["year"]))

    def _start_season(self, year: int) -> None:
        p = self.p
        if self.year is not None:
            self.prev_driver_pos = SeasonBook.positions(self.season.driver_pts)
            self.prev_team_pos = SeasonBook.positions(self.season.team_pts)
        major, minor = year in MAJOR_RESETS, year in MINOR_RESETS
        carry = p.team_carry_major if major else p.team_carry_minor if minor else p.team_carry
        if self.t_rating:
            mean = float(np.mean(list(self.t_rating.values())))
            for k in self.t_rating:
                self.t_rating[k] = mean + carry * (self.t_rating[k] - mean)
        if self.d_rating:
            mean = float(np.mean(list(self.d_rating.values())))
            for k in self.d_rating:
                self.d_rating[k] = mean + p.driver_carry * (self.d_rating[k] - mean)

        rho = p.pace_rho_major if major else p.pace_rho_minor if minor else p.pace_rho
        svar = p.pace_season_var_major if major else p.pace_season_var_minor if minor else p.pace_season_var
        active = [t for t, y in self.team_last_year.items() if self.year is not None and y == self.year]
        if active:
            mu = float(np.mean([self.pace_m[t] for t in active]))
            for t in self.pace_m:
                # AR(1) toward the field mean: x' = mu + rho (x - mu) + w,  Var = rho^2 v + svar
                self.pace_m[t] = mu + rho * (self.pace_m[t] - mu)
                self.pace_v[t] = rho**2 * self.pace_v[t] + svar

        form_carry = p.form_season_carry ** (2 if major else 1)
        is_team = lambda k: isinstance(k, tuple) and k[0] in ("t", "pu")  # noqa: E731
        for e in self.ewm.values():
            e.shrink(form_carry, is_team)
        self.ewm_slow.shrink(form_carry, is_team)
        if year in PU_RESETS:
            self.ewm_slow.shrink(0.0, lambda k: isinstance(k, tuple) and k[0] == "pu")
        self.circ.shrink(0.0 if major else form_carry)
        self.season = SeasonBook()
        if major:
            self.races_since_reset = 0
        self.year = year

    # ------------------------------------------------------------------ pace helpers
    def _ensure_team(self, t: str) -> None:
        if t in self.pace_m:
            return
        active = [self.pace_m[x] for x, y in self.team_last_year.items() if y in (self.year, (self.year or 0) - 1)]
        base = max(active) if active else 1.5
        self.pace_m[t] = base + self.p.new_team_offset
        self.pace_v[t] = self.p.new_team_var

    def _ensure_driver(self, d: str, t: str) -> None:
        if d not in self.off_m:
            self.off_m[d] = self.p.rookie_offset
            self.off_v[d] = self.p.rookie_var
        elif self.driver_team.get(d) not in (None, t):
            self.off_m[d] *= self.p.switch_shrink
            self.off_v[d] += self.p.switch_var

    def _raw_offset(self, d: str, t: str) -> tuple[float, float]:
        """(mean, var) of a driver's offset as it would stand at team t (switch shrink applied)."""
        p = self.p
        switched = self.driver_team.get(d) not in (None, t)
        om = self.off_m.get(d, p.rookie_offset) * (p.switch_shrink if switched else 1.0)
        ov = self.off_v.get(d, p.rookie_var) + (p.switch_var if switched else 0.0)
        return om, ov

    def _pace(self, t: str) -> tuple[float, float]:
        if t in self.pace_m:
            return self.pace_m[t], self.pace_v[t]
        active = [self.pace_m[x] for x, y in self.team_last_year.items() if y in (self.year, (self.year or 0) - 1)]
        return (max(active) if active else 1.5) + self.p.new_team_offset, self.p.new_team_var

    # ------------------------------------------------------------------ snapshot (pure)
    def snapshot(self, race, entrants: pd.DataFrame) -> pd.DataFrame:
        """Pre-race features for `entrants` (driver_id, team_id, engine_id) of `race`. Does not mutate."""
        p = self.p
        circuit = race["circuit_id"]
        sb = self.season
        d_pos = SeasonBook.positions(sb.driver_pts) if sb.driver_pts else {}
        t_pos = SeasonBook.positions(sb.team_pts) if sb.team_pts else {}
        lead_d = max(sb.driver_pts.values(), default=0.0)
        lead_t = max(sb.team_pts.values(), default=0.0)

        engines = entrants["engine_id"].to_numpy() if "engine_id" in entrants else np.full(len(entrants), None)
        pu_paces: dict = defaultdict(list)
        for t, e in zip(entrants["team_id"], engines):
            pu_paces[e].append(self._pace(t)[0])
        raw_off = {d: self._raw_offset(d, t) for d, t in zip(entrants["driver_id"], entrants["team_id"])}
        off_team = dict(zip(entrants["driver_id"], entrants["team_id"]))
        team_mean_off = pd.Series({d: v[0] for d, v in raw_off.items()}).groupby(off_team).mean().to_dict()

        rows = []
        for d, t, e in zip(entrants["driver_id"], entrants["team_id"], engines):
            dr = self.d_rating.get(d, p.new_driver_rating)
            tr = self.t_rating.get(t, p.new_team_rating)
            tm, tv = self._pace(t)
            om = raw_off[d][0] - team_mean_off[t]
            ov = raw_off[d][1]
            circ_w = self.circ.weight(("t", t, circuit))
            row = {
                "driver_id": d,
                "team_id": t,
                "engine_id": e,
                "d_rating": dr,
                "t_rating": tr,
                "rating": dr + tr,
                "t_pace": tm,
                "t_pace_sd": np.sqrt(tv),
                "d_offset": om,
                "d_offset_sd": np.sqrt(ov),
                "d_pace": tm + om,
                "d_pace_sd": np.sqrt(tv + ov),
                "pu_pace": float(np.mean(pu_paces[e])),
                "pu_mech_rate": self.ewm_slow.get(("pu", e, "mech")),
                "is_rookie": float(self.career_starts[d] == 0),
                "career_starts": self.career_starts[d],
                "career_wins": self.career_wins[d],
                "starts_with_team": self.team_starts[(d, t)],
                "season_pts": sb.driver_pts.get(d, 0.0),
                "season_pts_share": sb.driver_pts.get(d, 0.0) / lead_d if lead_d > 0 else np.nan,
                "champ_pos": d_pos.get(d, np.nan),
                "season_wins": sb.driver_wins.get(d, 0),
                "team_season_pts_share": sb.team_pts.get(t, 0.0) / lead_t if lead_t > 0 else np.nan,
                "team_champ_pos": t_pos.get(t, np.nan),
                "team_season_wins": sb.team_wins.get(t, 0),
                "prev_champ_pos": self.prev_driver_pos.get(d, np.nan),
                "prev_team_champ_pos": self.prev_team_pos.get(t, np.nan),
                "d_incident_rate": self.ewm_slow.get(("d", d, "incident")),
                "t_mech_rate": self.ewm_slow.get(("t", t, "mech")),
                "tm_race_h2h": self.ewm_slow.get(("d", d, "tm_r")),
                "t_circ_pace_resid": self.circ.get(("t", t, circuit)) * circ_w / (circ_w + 1.0) if circ_w > 0 else 0.0,
            }
            for h, ew in self.ewm.items():
                for ent, key in (("d", d), ("t", t)):
                    for m in ("pts", "win", "podium", "qpos", "qgap"):
                        row[f"{ent}_{m}_h{h}"] = ew.get((ent, key, m))
            rows.append(row)
        snap = pd.DataFrame(rows)
        snap["races_since_reset"] = self.races_since_reset
        snap["is_major_reset_season"] = float(self.year in MAJOR_RESETS)
        return snap

    # ------------------------------------------------------------------ update
    def update(self, race, res: pd.DataFrame, quali: pd.DataFrame, sprint: pd.DataFrame, grid: pd.DataFrame) -> None:
        """Absorb the outcome of `race`. `res` = its results rows (one per driver)."""
        p = self.p
        year = int(race["year"])
        circuit = race["circuit_id"]
        early = race["round"] <= p.early_rounds
        res = res.sort_values("display_order")
        drivers = res["driver_id"].to_numpy()
        teams = res["team_id"].to_numpy()
        engines = res["engine_id"].to_numpy()
        for d, t in zip(drivers, teams):
            self.d_rating.setdefault(d, p.new_driver_rating)
            self.t_rating.setdefault(t, p.new_team_rating)
            self._ensure_team(t)
            self._ensure_driver(d, t)
        cause = res["dnf_cause"].to_numpy()
        started = res["status"].to_numpy() != "DNS"

        # --- race Elo: drivers are not blamed for mechanical failures; cars are.
        order = res["display_order"].to_numpy(dtype=float)
        self._elo_update(drivers, teams, order, cause, started, 1.0)
        if len(sprint) and sprint["sprint_pos"].notna().any():
            sp = sprint.dropna(subset=["sprint_pos"]).merge(res[["driver_id", "team_id"]], on="driver_id")
            if len(sp) >= 2:
                n = len(sp)
                self._elo_update(
                    sp["driver_id"].to_numpy(), sp["team_id"].to_numpy(), sp["sprint_pos"].to_numpy(dtype=float),
                    np.full(n, None), np.ones(n, bool), p.sprint_k_scale,
                )  # fmt: skip

        # --- pace filter: team car pace (driver offsets removed) + teammate-relative driver offsets
        q = quali.merge(res[["driver_id", "team_id"]], on="driver_id", how="inner")
        lineup: dict = defaultdict(list)
        for d, t in zip(drivers, teams):
            lineup[t].append(d)
        self._pace_predict(early)
        self._pace_update(q, "quali_gap_pct", p.pace_obs_var, lineup, circuit=circuit)
        if len(sprint) and "sq_gap_pct" in sprint and sprint["sq_gap_pct"].notna().any():
            sq = sprint.dropna(subset=["sq_gap_pct"]).merge(res[["driver_id", "team_id"]], on="driver_id")
            self._pace_update(sq, "sq_gap_pct", p.pace_obs_var * p.sq_obs_var_scale, lineup)
        self._offset_update(q, year in RACE_FUEL_Q3_YEARS)
        for t in set(teams):
            self.team_last_year[t] = year
        for d, t, e in zip(drivers, teams, engines):
            self.driver_team[d] = t
            self.team_engine[t] = e

        # --- form EWMs
        pts = res["finish_pos"].map(MODERN_POINTS).fillna(0.0).to_numpy()
        win = (res["finish_pos"] == 1).to_numpy(dtype=float)
        podium = (res["finish_pos"] <= 3).to_numpy(dtype=float)
        qpos = dict(zip(q["driver_id"], q["quali_pos"]))
        qgap = dict(zip(q["driver_id"], q["quali_gap_pct"]))
        frame = pd.DataFrame({"t": teams, "pts": pts, "win": win, "podium": podium})
        frame["qpos"] = [qpos.get(d, np.nan) for d in drivers]
        frame["qgap"] = [qgap.get(d, np.nan) for d in drivers]
        team_agg = frame[started].groupby("t").agg(
            pts=("pts", "max"), win=("win", "max"), podium=("podium", "max"), qpos=("qpos", "min"), qgap=("qgap", "min")
        )
        driver_counts = started & (cause != "mechanical") & (cause != "other")
        for ew in self.ewm.values():
            for i, d in enumerate(drivers):
                if not started[i]:
                    continue
                if driver_counts[i]:
                    ew.update(("d", d, "pts"), pts[i])
                    ew.update(("d", d, "win"), win[i])
                    ew.update(("d", d, "podium"), podium[i])
                ew.update(("d", d, "qpos"), qpos.get(d, np.nan))
                ew.update(("d", d, "qgap"), qgap.get(d, np.nan))
            for t, r in team_agg.iterrows():
                for m in ("pts", "win", "podium", "qpos", "qgap"):
                    ew.update(("t", t, m), r[m])

        # --- reliability
        mech = cause == "mechanical"
        for i, d in enumerate(drivers):
            if started[i]:
                self.ewm_slow.update(("d", d, "incident"), float(cause[i] == "incident"))
        for t in set(teams[started]):
            self.ewm_slow.update(("t", t, "mech"), float(mech[started & (teams == t)].mean()))
        for e in set(engines[started]):
            self.ewm_slow.update(("pu", e, "mech"), float(mech[started & (engines == e)].mean()))

        # --- teammate race head-to-head (both drivers' results must reflect driving, not the car)
        by_team: dict = defaultdict(list)
        for i, t in enumerate(teams):
            by_team[t].append(i)
        for idx in by_team.values():
            if len(idx) == 2 and all(driver_counts[i] for i in idx):
                a, b = idx
                self.ewm_slow.update(("d", drivers[a], "tm_r"), float(order[a] < order[b]))
                self.ewm_slow.update(("d", drivers[b], "tm_r"), float(order[b] < order[a]))

        # --- season book + career counters (sprint points count toward the championship)
        sb = self.season
        for d, t, pt in zip(res["driver_id"], res["team_id"], res["points"]):
            sb.driver_pts[d] += float(pt)
            sb.team_pts[t] += float(pt)
        if len(sprint):
            sp = sprint.merge(res[["driver_id", "team_id"]], on="driver_id", how="inner")
            for d, t, pt in zip(sp["driver_id"], sp["team_id"], sp["sprint_points"].fillna(0.0)):
                sb.driver_pts[d] += float(pt)
                sb.team_pts[t] += float(pt)
        winners = res.loc[res["finish_pos"] == 1]
        for d, t in zip(winners["driver_id"], winners["team_id"]):
            sb.driver_wins[d] += 1
            sb.team_wins[t] += 1
            self.career_wins[d] += 1
        sb.races_run += 1
        self.races_since_reset += 1
        for i, (d, t) in enumerate(zip(drivers, teams)):
            if started[i]:
                self.career_starts[d] += 1
                self.team_starts[(d, t)] += 1

    def _elo_update(self, drivers, teams, order, cause, started, scale: float) -> None:
        p = self.p
        d_mask = started & (cause != "mechanical") & (cause != "other")
        t_mask = started & (cause != "other")
        strength = np.array([self.d_rating[d] + self.t_rating[t] for d, t in zip(drivers, teams)])
        if d_mask.sum() >= 2:
            g = _pairwise_gradient(strength[d_mask], order[d_mask])
            for d, gi in zip(drivers[d_mask], g):
                self.d_rating[d] += scale * p.k_driver * gi
        if t_mask.sum() >= 2:
            g = _pairwise_gradient(strength[t_mask], order[t_mask])
            tg: dict = defaultdict(list)
            for t, gi in zip(teams[t_mask], g):
                tg[t].append(gi)
            for t, gs in tg.items():
                self.t_rating[t] += scale * p.k_team * float(np.mean(gs))

    def _pace_predict(self, early: bool) -> None:
        """One Kalman predict step per race for every team (local-level random walk)."""
        proc = self.p.pace_proc_var_early if early else self.p.pace_proc_var
        for t in self.pace_v:
            self.pace_v[t] += proc

    def _pace_update(self, q: pd.DataFrame, col: str, obs_var: float, lineup: dict, circuit=None) -> None:
        """Measurement update of team pace from one session.

        Each gap is corrected by the driver's offset *centred within the team's line-up*, so the
        team state measures the line-up's average pace. Gaps at the canonical clip are censored
        (no representative lap) and skipped.
        """
        q = q[q[col].notna() & (q[col] < GAP_CENSOR_PCT)]
        for t, g in q.groupby("team_id"):
            offs = {d: self.off_m.get(d, self.p.rookie_offset) for d in lineup.get(t, list(g["driver_id"]))}
            centre = float(np.mean(list(offs.values())))
            y = float(np.mean([gap - (offs.get(d, centre) - centre) for d, gap in zip(g["driver_id"], g[col])]))
            m, v = self.pace_m[t], self.pace_v[t]
            if circuit is not None:
                self.circ.update(("t", t, circuit), y - m)
            k = v / (v + obs_var / len(g))
            self.pace_m[t] = m + k * (y - m)
            self.pace_v[t] = (1 - k) * v

    def _offset_update(self, q: pd.DataFrame, race_fuel_q3: bool) -> None:
        """Teammate delta = off_a - off_b + noise: exact 2-D Kalman update for the pair.

        Only the difference is identified by a pair, so the cross-covariance is kept per pair
        (it is what stops the marginal variances collapsing); it is dropped when line-ups change.
        """
        p = self.p
        for d in q["driver_id"]:
            if d in self.off_v:
                self.off_v[d] += p.offset_proc_var
        for _, g in q.groupby("team_id"):
            if len(g) != 2:
                continue
            a, b = sorted(g.itertuples(index=False), key=lambda r: r.driver_id)
            delta = teammate_delta(a, b, race_fuel_q3)
            if not np.isfinite(delta):
                continue
            da, db = a.driver_id, b.driver_id
            ma, va, mb, vb = self.off_m[da], self.off_v[da], self.off_m[db], self.off_v[db]
            # The pair covariance is only valid while the pairing is unbroken: a driver measured
            # against someone else in between has a newer, smaller variance.
            continuous = self.last_mate.get(da) == db and self.last_mate.get(db) == da
            c = self.off_cov.get((da, db), 0.0) if continuous else 0.0
            c = float(np.clip(c, -0.999 * np.sqrt(va * vb), 0.999 * np.sqrt(va * vb)))
            e = delta - (ma - mb)
            # Huber weighting: a compromised lap (wet session, deleted time) moves the pair less.
            r_eff = p.offset_obs_var * max(1.0, (abs(e) / HUBER_K_PCT) ** 2)
            s_ = va + vb - 2 * c + r_eff
            ka, kb = (va - c) / s_, (c - vb) / s_
            self.off_m[da], self.off_m[db] = ma + ka * e, mb + kb * e
            self.off_v[da] = va - (va - c) ** 2 / s_
            self.off_v[db] = vb - (c - vb) ** 2 / s_
            self.off_cov[(da, db)] = c - (va - c) * (c - vb) / s_
            self.last_mate[da], self.last_mate[db] = db, da
