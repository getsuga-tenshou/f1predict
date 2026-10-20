import { describe, expect, it } from "vitest";
import type { Lineup } from "../api/types";
import {
  assignSeat,
  changedSeats,
  defaultSeats,
  driverOptions,
  fieldFromSeats,
  isLineupChanged,
  toLineupEntries,
} from "./lineup";

const entrant = (driver_id: string, team_id: string) => ({
  driver_id,
  name: driver_id.toUpperCase(),
  abbr: driver_id.slice(0, 3).toUpperCase(),
  number: null,
  team_id,
  team: team_id,
  engine_id: team_id === "haas" ? "ferrari" : team_id,
});

const lineup: Pick<Lineup, "teams" | "entrants" | "candidates"> = {
  teams: [
    { team_id: "ferrari", team: "Ferrari", engine_id: "ferrari" },
    { team_id: "haas", team: "Haas", engine_id: "ferrari" },
  ],
  entrants: [entrant("lec", "ferrari"), entrant("ham", "ferrari"), entrant("oco", "haas"), entrant("bea", "haas")],
  candidates: [
    { driver_id: "zhou", name: "ZHOU", abbr: "ZHO", number: 24 },
    { driver_id: "lec", name: "LEC", abbr: "LEC", number: 16 },
  ],
};

const defaults = defaultSeats(lineup);

describe("defaultSeats", () => {
  it("groups the entrants by team in order", () => {
    expect(defaults).toEqual({ ferrari: ["lec", "ham"], haas: ["oco", "bea"] });
  });
});

describe("assignSeat", () => {
  it("puts an unseated candidate in a seat", () => {
    const s = assignSeat(defaults, defaults, "haas", 0, "zhou");
    expect(s).toEqual({ ferrari: ["lec", "ham"], haas: ["zhou", "bea"] });
    expect(defaults.haas).toEqual(["oco", "bea"]);
  });

  it("swaps when a driver moves out of their own default seat", () => {
    const s = assignSeat(defaults, defaults, "haas", 1, "ham");
    expect(s).toEqual({ ferrari: ["lec", "bea"], haas: ["oco", "ham"] });
  });

  it("resets the other seat to its default when that default is free", () => {
    let s = assignSeat(defaults, defaults, "haas", 0, "zhou"); // Ocon out
    s = assignSeat(s, defaults, "ferrari", 1, "zhou"); // Zhou moves to Ferrari: Haas seat back to Ocon
    expect(s).toEqual({ ferrari: ["lec", "zhou"], haas: ["oco", "bea"] });
  });

  it("is a no-op when the seat already holds the driver", () => {
    expect(assignSeat(defaults, defaults, "ferrari", 0, "lec")).toBe(defaults);
  });

  it("never seats a driver twice", () => {
    let s = defaults;
    s = assignSeat(s, defaults, "haas", 0, "lec");
    s = assignSeat(s, defaults, "ferrari", 1, "oco");
    s = assignSeat(s, defaults, "haas", 1, "ham");
    const all = Object.values(s).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("changes and request body", () => {
  it("marks changed seats", () => {
    const s = assignSeat(defaults, defaults, "haas", 0, "zhou");
    expect([...changedSeats(s, defaults)]).toEqual(["haas:0"]);
    expect(isLineupChanged(s, defaults)).toBe(true);
    expect(isLineupChanged(defaults, defaults)).toBe(false);
  });

  it("sends the full field with each team's engine", () => {
    const s = assignSeat(defaults, defaults, "haas", 0, "zhou");
    expect(toLineupEntries(s, lineup.teams)).toEqual([
      { driver_id: "lec", team_id: "ferrari", engine_id: "ferrari" },
      { driver_id: "ham", team_id: "ferrari", engine_id: "ferrari" },
      { driver_id: "zhou", team_id: "haas", engine_id: "ferrari" },
      { driver_id: "bea", team_id: "haas", engine_id: "ferrari" },
    ]);
  });
});

describe("driver lists", () => {
  it("merges candidates and entrants without duplicates", () => {
    const ids = driverOptions(lineup).map((o) => o.driver_id);
    expect(ids.sort()).toEqual(["bea", "ham", "lec", "oco", "zhou"]);
  });

  it("builds the field for the grid editor", () => {
    const s = assignSeat(defaults, defaults, "haas", 0, "zhou");
    const field = fieldFromSeats(s, lineup.teams, driverOptions(lineup));
    expect(field.map((f) => f.abbr)).toEqual(["LEC", "HAM", "ZHO", "BEA"]);
  });
});
