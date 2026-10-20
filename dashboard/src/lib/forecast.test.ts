import { describe, expect, it } from "vitest";
import type { Outlook, RunRow, RunStatus, RunSummary } from "../api/types";
import { bestRace, compareCandidates, maxAbsContribution, outlookContenders, pickDisplayedRun, rowDeltas } from "./forecast";
import { parseThemePref } from "./theme";

const raceRef = (race_id: number) => ({
  race_id,
  year: 2026,
  round: race_id - 1149,
  date: "2026-10-25",
  grand_prix: "United States",
  circuit: "Americas",
  place: "Austin",
  country_id: "united-states-of-america",
  is_sprint: false,
  status: "upcoming" as const,
  race_start_utc: null,
  quali_start_utc: null,
});

function run(id: string, race_id: number, created_at: string, status: RunStatus = "done"): RunSummary {
  return {
    id,
    source: "dashboard",
    created_at,
    status,
    stage: null,
    error: null,
    race: raceRef(race_id),
    mode: "pre_weekend",
    h: 1,
    data_version: "v2026.17.0",
    label: null,
    inputs: { live: false, sessions_used: [], grid: "none", lineup_changes: [] },
    favourite: null,
    outcome: null,
    warnings: [],
  };
}

const runs = [
  run("a", 1167, "2026-10-20T08:00:00Z"),
  run("b", 1167, "2026-10-20T09:00:00Z"),
  run("c", 1167, "2026-10-20T10:00:00Z", "error"),
  run("d", 1168, "2026-10-20T11:00:00Z"),
];

describe("pickDisplayedRun", () => {
  it("shows the newest done run for the race", () => {
    expect(pickDisplayedRun(runs, 1167, null)?.id).toBe("b");
  });
  it("honours the chosen run when it belongs to the race", () => {
    expect(pickDisplayedRun(runs, 1167, "a")?.id).toBe("a");
    expect(pickDisplayedRun(runs, 1167, "d")?.id).toBe("b");
  });
  it("is null when the race has no done run", () => {
    expect(pickDisplayedRun(runs, 1170, null)).toBeNull();
  });
  it("lists other done runs to compare with", () => {
    expect(compareCandidates(runs, 1167, "b").map((r) => r.id)).toEqual(["a"]);
  });
});

const driver = (id: string) => ({ driver_id: id, name: id, abbr: id, number: null, team_id: "t", team: "T" });
const row = (id: string, p: number, values: number[] = []): RunRow => ({
  driver: driver(id),
  p,
  rank: 1,
  why: values.map((value, i) => ({ feature: `f${i}`, label: `F${i}`, value })),
  quali_pos: null,
  grid_pos: null,
  finish_pos: null,
});

describe("rowDeltas", () => {
  it("gives points against the comparison and flags new drivers", () => {
    const d = rowDeltas([row("ant", 0.25), row("col", 0.01)], [row("ant", 0.219)]);
    const ant = d.get("ant");
    expect(ant?.kind).toBe("points");
    if (ant?.kind === "points") expect(ant.value).toBeCloseTo(3.1);
    expect(d.get("col")).toEqual({ kind: "new" });
  });
  it("finds the shared contribution scale", () => {
    expect(maxAbsContribution([row("a", 0.5, [0.2, -0.9]), row("b", 0.5, [0.4])])).toBeCloseTo(0.9);
    expect(maxAbsContribution([row("a", 1)])).toBe(0);
  });
});

describe("outlook", () => {
  const outlook: Outlook = {
    data_version: "v",
    after: raceRef(1166),
    races: [
      { ...raceRef(1167), h: 1 },
      { ...raceRef(1168), h: 2 },
    ],
    drivers: [
      { driver: driver("low"), p: [0.01, 0.02], expected_wins: 0.03, p_at_least_one: 0.0298 },
      { driver: driver("ant"), p: [0.22, 0.25], expected_wins: 0.47, p_at_least_one: 0.415 },
      { driver: driver("ver"), p: [0.2, 0.19], expected_wins: 0.39, p_at_least_one: 0.352 },
    ],
  };
  it("keeps contenders above the threshold, most expected wins first", () => {
    expect(outlookContenders(outlook).map((d) => d.driver.driver_id)).toEqual(["ant", "ver"]);
  });
  it("finds the best remaining race", () => {
    expect(bestRace(outlook, outlook.drivers[2])).toEqual({ index: 0, p: 0.2 });
  });
});

describe("theme preference", () => {
  it("falls back to system", () => {
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref(null)).toBe("system");
    expect(parseThemePref("sepia")).toBe("system");
  });
});
