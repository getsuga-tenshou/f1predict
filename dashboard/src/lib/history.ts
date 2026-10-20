import type { History, HistoryRace, Split } from "../api/types";
import { seasonRange } from "./format";

/** "all", a split id, or a season as a string ("2024"). Also the key into `history.calibration`. */
export type Scope = string;

export interface ScopeOption {
  value: Scope;
  label: string;
  group: "splits" | "seasons";
}

const SPLIT_NAMES: Record<Split, string> = { validation: "Validation", test: "Test", holdout: "Holdout" };

function splitLabel(id: Split, seasons: number[]): string {
  if (id === "holdout" && seasons.length === 1) return `${seasons[0]} season`;
  return `${SPLIT_NAMES[id]}, ${seasonRange(seasons)}`;
}

/**
 * Scope choices: all seasons, each split, then every season newest first (the spec's list; the
 * 2026 holdout appears both as its split and as a season, in separate groups).
 */
export function scopeOptions(history: Pick<History, "splits" | "races">): ScopeOption[] {
  const years = [...new Set(history.races.map((r) => r.race.year))].sort((a, b) => b - a);
  const out: ScopeOption[] = [];
  if (years.length) out.push({ value: "all", label: `All seasons, ${seasonRange(years)}`, group: "splits" });
  for (const s of history.splits) {
    if (s.seasons.length) out.push({ value: s.id, label: splitLabel(s.id, s.seasons), group: "splits" });
  }
  for (const y of years) out.push({ value: String(y), label: String(y), group: "seasons" });
  return out;
}

export function isSplitScope(scope: Scope): scope is Split {
  return scope === "validation" || scope === "test" || scope === "holdout";
}

export function filterRaces(races: HistoryRace[], scope: Scope): HistoryRace[] {
  if (scope === "all") return races;
  if (isSplitScope(scope)) return races.filter((r) => r.split === scope);
  const year = Number(scope);
  return races.filter((r) => r.race.year === year);
}

export interface Kpis {
  races: number;
  favouriteWon: number;
  favouriteWonRate: number;
  top3: number;
  top3Rate: number;
  meanLogloss: number;
  meanBaselineLogloss: number;
  /** Model minus baseline; negative means the model was better. */
  diff: number;
}

export function computeKpis(races: HistoryRace[]): Kpis | null {
  const n = races.length;
  if (n === 0) return null;
  let won = 0;
  let top3 = 0;
  let ll = 0;
  let base = 0;
  for (const r of races) {
    if (r.favourite_won) won += 1;
    if (r.winner.rank <= 3) top3 += 1;
    ll += r.logloss;
    base += r.baseline_logloss;
  }
  const meanLogloss = ll / n;
  const meanBaselineLogloss = base / n;
  return {
    races: n,
    favouriteWon: won,
    favouriteWonRate: won / n,
    top3,
    top3Rate: top3 / n,
    meanLogloss,
    meanBaselineLogloss,
    diff: meanLogloss - meanBaselineLogloss,
  };
}

export type RaceSortKey = "date" | "logloss";
export type SortDir = "asc" | "desc";

/** History races are chronological; "date desc" is newest first. Ties keep date order. */
export function sortRaces(races: HistoryRace[], key: RaceSortKey, dir: SortDir): HistoryRace[] {
  const sign = dir === "asc" ? 1 : -1;
  return races
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const primary = key === "date" ? a.i - b.i : a.r.logloss - b.r.logloss;
      return primary !== 0 ? sign * primary : sign * (a.i - b.i);
    })
    .map(({ r }) => r);
}

/** Probability the mode's simple baseline gave the actual winner. */
export function baselineWinnerP(race: Pick<HistoryRace, "baseline_logloss">): number {
  return Math.exp(-race.baseline_logloss);
}

/** Index of the first race of each season, for axis labels. */
export function seasonStarts(races: HistoryRace[]): { index: number; year: number }[] {
  const out: { index: number; year: number }[] = [];
  races.forEach((r, i) => {
    if (i === 0 || races[i - 1].race.year !== r.race.year) out.push({ index: i, year: r.race.year });
  });
  return out;
}
