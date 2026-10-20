import { describe, expect, it } from "vitest";
import { parseHash, routeHref } from "./route";

describe("parseHash", () => {
  it("defaults to the forecast view", () => {
    expect(parseHash("")).toEqual({ view: "forecast", raceId: null });
    expect(parseHash("#/nowhere")).toEqual({ view: "forecast", raceId: null });
    expect(parseHash("#/forecast")).toEqual({ view: "forecast", raceId: null });
  });
  it("reads a race id", () => {
    expect(parseHash("#/forecast/1167")).toEqual({ view: "forecast", raceId: 1167 });
    expect(parseHash("#/forecast/abc")).toEqual({ view: "forecast", raceId: null });
  });
  it("reads history filters and drill-down", () => {
    expect(parseHash("#/history?mode=pre_race&scope=test")).toEqual({
      view: "history",
      raceId: null,
      mode: "pre_race",
      scope: "test",
    });
    expect(parseHash("#/history/1101?mode=bogus")).toEqual({ view: "history", raceId: 1101, mode: null, scope: null });
  });
});

describe("routeHref", () => {
  it("round-trips", () => {
    const routes = ["#/forecast", "#/forecast/1167", "#/history", "#/history/1101?mode=pre_quali&scope=2024"];
    for (const r of routes) expect(routeHref(parseHash(r))).toBe(r);
  });
});
