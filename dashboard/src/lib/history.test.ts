import { describe, expect, it } from "vitest";
import type { HistoryRace, Split } from "../api/types";
import { baselineWinnerP, computeKpis, filterRaces, scopeOptions, seasonStarts, sortRaces } from "./history";

const driver = (id: string) => ({ driver_id: id, name: id, abbr: id, number: null, team_id: "t", team: "T" });

function race(year: number, round: number, split: Split, opts: { won: boolean; rank: number; ll: number; base: number }): HistoryRace {
  return {
    race: {
      race_id: year * 100 + round,
      year,
      round,
      date: `${year}-05-${String(round).padStart(2, "0")}`,
      grand_prix: `GP${round}`,
      circuit: "c",
      place: "p",
      country_id: "x",
      is_sprint: false,
      status: "completed",
      race_start_utc: null,
      quali_start_utc: null,
    },
    split,
    field_size: 20,
    favourite: { driver: driver("fav"), p: 0.4 },
    winner: { driver: driver(opts.won ? "fav" : "other"), p: Math.exp(-opts.ll), rank: opts.rank },
    favourite_won: opts.won,
    logloss: opts.ll,
    baseline_logloss: opts.base,
  };
}

const races: HistoryRace[] = [
  race(2022, 1, "validation", { won: true, rank: 1, ll: 0.9, base: 1.2 }),
  race(2022, 2, "validation", { won: false, rank: 4, ll: 2.1, base: 1.8 }),
  race(2023, 1, "test", { won: true, rank: 1, ll: 0.7, base: 1.0 }),
  race(2023, 2, "test", { won: false, rank: 2, ll: 1.5, base: 1.6 }),
  race(2026, 1, "holdout", { won: false, rank: 3, ll: 1.3, base: 1.4 }),
];

const splits = [
  { id: "validation" as const, label: "Validation", seasons: [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022] },
  { id: "test" as const, label: "Test", seasons: [2023, 2024, 2025] },
  { id: "holdout" as const, label: "Holdout", seasons: [2026] },
];

describe("scopeOptions", () => {
  it("lists all, the splits, then every season newest first", () => {
    const opts = scopeOptions({ splits, races });
    expect(opts.map((o) => [o.value, o.label, o.group])).toEqual([
      ["all", "All seasons, 2022-26", "splits"],
      ["validation", "Validation, 2014-22", "splits"],
      ["test", "Test, 2023-25", "splits"],
      ["holdout", "2026 season", "splits"],
      ["2026", "2026", "seasons"],
      ["2023", "2023", "seasons"],
      ["2022", "2022", "seasons"],
    ]);
  });
});

describe("filterRaces", () => {
  it("filters by split and by season", () => {
    expect(filterRaces(races, "all")).toHaveLength(5);
    expect(filterRaces(races, "test")).toHaveLength(2);
    expect(filterRaces(races, "2022").map((r) => r.race.round)).toEqual([1, 2]);
    expect(filterRaces(races, "1999")).toHaveLength(0);
  });
});

describe("computeKpis", () => {
  it("aggregates the filtered races", () => {
    const k = computeKpis(filterRaces(races, "validation"));
    expect(k).not.toBeNull();
    expect(k?.races).toBe(2);
    expect(k?.favouriteWon).toBe(1);
    expect(k?.favouriteWonRate).toBeCloseTo(0.5);
    expect(k?.top3).toBe(1);
    expect(k?.meanLogloss).toBeCloseTo(1.5);
    expect(k?.meanBaselineLogloss).toBeCloseTo(1.5);
    expect(k?.diff).toBeCloseTo(0);
  });
  it("counts the winner in the top 3", () => {
    expect(computeKpis(races)?.top3).toBe(4);
  });
  it("is null with no races", () => {
    expect(computeKpis([])).toBeNull();
  });
});

describe("sortRaces", () => {
  it("sorts newest first by default order and by log-loss", () => {
    expect(sortRaces(races, "date", "desc").map((r) => r.race.race_id)).toEqual([202601, 202302, 202301, 202202, 202201]);
    expect(sortRaces(races, "logloss", "asc").map((r) => r.logloss)).toEqual([0.7, 0.9, 1.3, 1.5, 2.1]);
    expect(sortRaces(races, "logloss", "desc")[0].logloss).toBe(2.1);
  });
});

describe("helpers", () => {
  it("converts baseline log-loss to the probability it gave the winner", () => {
    expect(baselineWinnerP({ baseline_logloss: Math.log(4) })).toBeCloseTo(0.25);
  });
  it("finds the first race of each season", () => {
    expect(seasonStarts(races)).toEqual([
      { index: 0, year: 2022 },
      { index: 2, year: 2023 },
      { index: 4, year: 2026 },
    ]);
  });
});
