"""Readable names for model features, used to explain a forecast ("why")."""

from __future__ import annotations

import re

_BASE = {
    "d_pace": "Driver pace",
    "t_pace": "Car pace",
    "d_offset": "Pace vs teammate",
    "d_pace_sd": "Driver pace uncertainty",
    "t_pace_sd": "Car pace uncertainty",
    "d_offset_sd": "Teammate gap uncertainty",
    "pu_pace": "Power-unit pace",
    "pu_mech_rate": "Power-unit failure rate",
    "t_mech_rate": "Car failure rate",
    "d_incident_rate": "Incident rate",
    "rating": "Race Elo",
    "d_rating": "Driver Elo",
    "t_rating": "Team Elo",
    "d_pts": "driver points form",
    "t_pts": "team points form",
    "d_win": "driver win form",
    "t_win": "team win form",
    "d_podium": "driver podium form",
    "t_podium": "team podium form",
    "d_qpos": "driver qualifying-position form",
    "t_qpos": "team qualifying-position form",
    "d_qgap": "driver qualifying-gap form",
    "t_qgap": "team qualifying-gap form",
    "season_pts_share": "Championship points share",
    "team_season_pts_share": "Team points share",
    "champ_pos": "Championship position",
    "team_champ_pos": "Team championship position",
    "season_wins": "Wins this season",
    "team_season_wins": "Team wins this season",
    "prev_champ_pos": "Last season's championship position",
    "prev_team_champ_pos": "Team's last-season position",
    "career_starts": "Career starts",
    "career_wins": "Career wins",
    "starts_with_team": "Starts with this team",
    "is_rookie": "Rookie",
    "tm_race_h2h": "Race head-to-head vs teammate",
    "t_circ_pace_resid": "Team's past pace at this circuit",
    "fp_gap_mean": "Practice gap",
    "fp_gap_min": "Best practice gap",
    "n_fp": "Practice sessions run",
    "fp_missing": "No practice time",
    "car_fp_gap_mean": "Car's practice gap",
    "sprint_pos": "Sprint result",
    "log_sprint_pos": "Sprint result",
    "sprint_quali_pos": "Sprint qualifying position",
    "log_sprint_quali_pos": "Sprint qualifying position",
    "sq_gap_pct": "Sprint qualifying gap",
    "quali_pos": "Qualifying position",
    "log_quali_pos": "Qualifying position",
    "quali_gap_pct": "Qualifying gap to pole",
    "quali_missing": "No qualifying time",
    "grid_pos": "Grid slot",
    "log_grid": "Grid slot",
    "pit_lane_start": "Pit-lane start",
    "grid_penalty_places": "Grid penalty",
    "round": "Round",
    "races_since_reset": "Races since the rules reset",
    "is_major_reset_season": "Rules-reset season",
    "is_street": "Street circuit",
    "is_sprint_weekend": "Sprint weekend",
    "field_size": "Field size",
}
_PARTS = re.compile(r"^(?P<base>.*?)(?:_h(?P<h>\d+))?(?P<suffix>_rel|_rank)?$")


def feature_label(feature: str, short_halflife: int = 3) -> str:
    """'t_pts_h3_rel' -> 'Recent team points form vs the field's best'."""
    m = _PARTS.match(feature)
    base, h, suffix = m["base"], m["h"], m["suffix"]
    text = _BASE.get(base)
    if text is None:
        text = feature.replace("_", " ").capitalize()
        return text
    if h is not None:
        text = f"{'Recent' if int(h) <= short_halflife else 'Long-run'} {text}"
    if suffix == "_rel":
        text += " vs the field's best"
    elif suffix == "_rank":
        text += " (rank in field)"
    return text[0].upper() + text[1:]


def parse_why(why: object, short_halflife: int = 3) -> list[dict]:
    """'t_pts_h3_rel +0.95; d_pace_rel +0.81' (the forecast's `why` column) -> contributions."""
    if not isinstance(why, str) or not why.strip():
        return []
    out = []
    for part in why.split(";"):
        name, _, value = part.strip().rpartition(" ")
        try:
            v = float(value)
        except ValueError:
            continue
        out.append({"feature": name, "label": feature_label(name, short_halflife), "value": v})
    return out
