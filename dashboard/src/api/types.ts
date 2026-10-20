/**
 * API contract between the FastAPI backend (src/f1predict/dashboard) and this frontend.
 *
 * All endpoints live under /api and return JSON. Dates are "YYYY-MM-DD"; timestamps are ISO-8601
 * UTC ("2026-10-20T09:14:03Z"). Probabilities are floats in [0, 1] and sum to 1 within a race.
 * Errors come back as HTTP 4xx/5xx with body { detail: string }.
 */

export type Mode = "pre_weekend" | "pre_quali" | "pre_race";

/** A driver as entered for one specific race (team = the constructor's name *at that race*). */
export interface DriverRef {
  driver_id: string; // "max-verstappen"
  name: string; // "Max Verstappen"
  abbr: string; // "VER"
  number: number | null; // permanent number, if any
  team_id: string; // lineage id used by the model ("audi" for Sauber/Kick Sauber/Audi)
  team: string; // constructor name at that race ("Sauber" in 2014, "Audi" in 2026)
}

export interface RaceRef {
  race_id: number;
  year: number;
  round: number;
  date: string; // race day
  grand_prix: string; // "United States"
  circuit: string; // "Americas"
  place: string; // "Austin"
  country_id: string; // "united-states-of-america"
  is_sprint: boolean;
  status: "completed" | "upcoming";
  race_start_utc: string | null;
  quali_start_utc: string | null;
}

export interface ModeInfo {
  id: Mode;
  label: string; // "Before the weekend" | "After practice" | "After qualifying"
  short: string; // "Pre-weekend" | "Pre-quali" | "Pre-race"
  knows: string; // one sentence on what information this moment can use
}

/* ------------------------------------------------------------------ GET /api/status */
export interface Status {
  data_version: string; // "v2026.17.0"
  season: number; // 2026
  last_race: RaceRef & { winner: DriverRef | null };
  next_race: RaceRef | null;
  modes: ModeInfo[];
  model: {
    name: string; // "Conditional logit"
    train_from: number; // 2003
    config_path: string; // "configs/final.json"
  };
  latest_release: {
    checked: boolean; // false when GitHub could not be reached
    tag: string | null; // newest F1DB release tag
    newer: boolean; // tag differs from data_version
    update_command: string | null; // shell command to update when newer
  };
  server_time: string;
}

/* ------------------------------------------------------------------ GET /api/calendar?season=2026 */
export interface CalendarRace extends RaceRef {
  winner: DriverRef | null; // null for upcoming races
}
export interface Calendar {
  season: number;
  races: CalendarRace[]; // by round
}

/* ------------------------------------------------------------------ GET /api/lineup?race_id=1167 */
export interface Entrant extends DriverRef {
  engine_id: string; // "mercedes"
}
export interface Lineup {
  race: RaceRef;
  /** Default field the model assumes: the entrants of the most recent completed race. */
  entrants: Entrant[];
  /** Drivers who can be swapped into a seat (anyone who entered a race in the last three seasons). */
  candidates: Omit<DriverRef, "team_id" | "team">[];
  /** Seats: one row per team with the engine it runs. */
  teams: { team_id: string; team: string; engine_id: string }[];
}

/* ------------------------------------------------------------------ GET /api/live?race_id=1167 */
export type SessionKind = "fp1" | "fp2" | "fp3" | "sq" | "sprint" | "q";
export interface LiveWeekend {
  race: RaceRef;
  reachable: boolean; // false when OpenF1 could not be reached
  error: string | null;
  /** Finished sessions OpenF1 serves for this weekend (served ~30 min after a session ends). */
  sessions: { kind: SessionKind; name: string; ended_at: string }[];
  /** Qualifying classification when GP qualifying has finished, else null. */
  quali: { driver: DriverRef; quali_pos: number | null; gap_pct: number | null }[] | null;
}

/* ------------------------------------------------------------------ POST /api/runs */
export interface GridEntry {
  driver_id: string;
  /** Qualifying classification. Ignored when live qualifying exists (OpenF1 times are used). */
  quali_pos: number | null;
  /** Starting slot after penalties. */
  grid_pos: number;
  pit_lane_start: boolean;
}
export interface LineupEntry {
  driver_id: string;
  team_id: string;
  engine_id: string;
}
export interface RunRequest {
  race_id: number; // must be an upcoming race
  mode: Mode;
  live: boolean; // pull this weekend's finished sessions from OpenF1
  /** pre_race only. With live qualifying: penalty / pit-lane overrides. Without: a manual scenario. */
  grid?: GridEntry[] | null;
  /** Full field for this race; null or omitted = default line-up. */
  lineup?: LineupEntry[] | null;
  label?: string | null; // free text, max 80 chars
}
/** Response of POST /api/runs (HTTP 202). Poll GET /api/runs/{id} until status is done or error. */
export interface RunAccepted {
  id: string;
  status: RunStatus;
}

export type RunStatus = "queued" | "running" | "done" | "error";
export type GridSource = "none" | "manual" | "live" | "live+overrides";

export interface FeatureContribution {
  feature: string; // "d_pace_rel"
  label: string; // "Driver pace vs fastest"
  value: number; // log-odds contribution vs the field average; positive helps
}

export interface RunRow {
  driver: DriverRef;
  p: number;
  rank: number; // 1 = favourite
  why: FeatureContribution[]; // top 3 by |value|, may be empty for CLI runs
  quali_pos: number | null; // inputs the model saw (pre_race), null otherwise
  grid_pos: number | null;
  finish_pos: number | null; // actual result, once the race is in the data
}

export interface RunOutcome {
  winner: DriverRef;
  p_winner: number; // probability this run gave the actual winner
  winner_rank: number;
  favourite_won: boolean;
  logloss: number; // -ln(p_winner)
}

export interface RunSummary {
  id: string;
  source: "dashboard" | "cli";
  created_at: string;
  status: RunStatus;
  stage: string | null; // human-readable progress while queued/running
  error: string | null;
  race: RaceRef;
  mode: Mode;
  h: number; // races ahead of the latest data (1 = next race)
  data_version: string;
  label: string | null;
  inputs: {
    live: boolean;
    sessions_used: SessionKind[]; // OpenF1 sessions that fed this run
    grid: GridSource;
    lineup_changes: { team: string; out: DriverRef | null; in: DriverRef }[];
  };
  favourite: { driver: DriverRef; p: number } | null; // null until done
  outcome: RunOutcome | null; // null until the race result is in the data
  warnings: string[];
}

export interface Run extends RunSummary {
  rows: RunRow[]; // sorted by p desc; empty until done
}

/* ------------------------------------------------------------------ GET /api/runs, GET/DELETE /api/runs/{id} */
export interface RunList {
  runs: RunSummary[]; // newest first
}

/* ------------------------------------------------------------------ GET /api/outlook */
export interface Outlook {
  data_version: string;
  after: RaceRef; // latest completed race
  races: (RaceRef & { h: number })[]; // remaining races, by date
  /** Per driver, sorted by expected_wins desc. p[i] aligns with races[i]. */
  drivers: {
    driver: DriverRef;
    p: number[];
    expected_wins: number; // sum of p
    p_at_least_one: number; // 1 - prod(1 - p), treating races as independent
  }[];
}

/* ------------------------------------------------------------------ GET /api/history?mode=pre_race */
export type Split = "validation" | "test" | "holdout";

export interface HistoryRace {
  race: RaceRef;
  split: Split; // validation 2014-22 (model selection), test 2023-25 (scored once), holdout 2026
  field_size: number;
  favourite: { driver: DriverRef; p: number };
  winner: { driver: DriverRef; p: number; rank: number };
  favourite_won: boolean;
  logloss: number;
  baseline_logloss: number; // the mode's reference simple model, same race
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number; // driver-race rows in the bin
  mean_p: number;
  win_rate: number;
}

export interface History {
  mode: Mode;
  baseline: { id: string; label: string }; // pace: "Pace-only model", grid: "Grid-slot prior"
  splits: { id: Split; label: string; seasons: number[] }[];
  races: HistoryRace[]; // chronological
  /** Reliability bins keyed by scope: "all", "validation", "test", "holdout", or a season "2024". */
  calibration: Record<string, CalibrationBin[]>;
}

/* ------------------------------------------------------------------ GET /api/history/{race_id} */
export interface HistoryModeDetail {
  rows: {
    driver: DriverRef;
    p: number;
    rank: number;
    finish_pos: number | null;
    status: string; // F1DB status: "FIN", "DNF", "DSQ", ...
  }[]; // sorted by p desc
  p_winner: number;
  winner_rank: number;
  logloss: number;
  baseline_logloss: number;
}
export interface HistoryRaceDetail {
  race: RaceRef;
  split: Split;
  winner: DriverRef;
  modes: Partial<Record<Mode, HistoryModeDetail>>;
}

/* ------------------------------------------------------------------ GET /api/metrics */
export interface SplitMetrics {
  races: number;
  logloss: number;
  top1: number; // favourite won
  top3: number; // winner in the top 3
  mean_p_winner: number;
  baseline_logloss: number;
  /** Race-paired difference to the baseline with a 95% bootstrap interval (negative = model better). */
  vs_baseline: { diff: number; ci_low: number; ci_high: number; seasons_better: number; seasons: number };
  temperature: { T: number; T_lo: number; T_hi: number }; // 1 = calibrated
}
export interface Metrics {
  data_version: string;
  modes: Record<Mode, { baseline: { id: string; label: string }; splits: Record<Split, SplitMetrics> }>;
  /** pre_weekend log-loss on the test seasons by races ahead (1..6). */
  horizons: { h: number; logloss: number }[];
}
