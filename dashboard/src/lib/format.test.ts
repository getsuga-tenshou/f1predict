import { describe, expect, it } from "vitest";
import {
  describePoints,
  finishLabel,
  formatDateLong,
  formatDateShort,
  formatProb,
  formatSigned,
  formatTimestamp,
  gridSourceLabel,
  horizonLabel,
  lineupChangesLabel,
  ordinal,
  raceShort,
  raceWithYear,
  relativeTime,
  seasonRange,
  sessionChips,
} from "./format";

describe("formatProb", () => {
  it("uses one decimal at every magnitude above a tenth of a percent", () => {
    expect(formatProb(0.219)).toBe("21.9%");
    expect(formatProb(0.037)).toBe("3.7%");
    expect(formatProb(0.005)).toBe("0.5%");
    expect(formatProb(0.001)).toBe("0.1%");
  });
  it("collapses tiny probabilities", () => {
    expect(formatProb(0.0009)).toBe("<0.1%");
    expect(formatProb(0)).toBe("<0.1%");
  });
});

describe("signed numbers and points", () => {
  it("formats with an ASCII sign and no sign on zero", () => {
    expect(formatSigned(0.95)).toBe("+0.95");
    expect(formatSigned(-0.322, 2)).toBe("-0.32");
    expect(formatSigned(-0.0001)).toBe("0.00");
  });
  it("describes changes in points", () => {
    expect(describePoints(3.14)).toBe("up 3.1 points");
    expect(describePoints(-0.4)).toBe("down 0.4 points");
    expect(describePoints(1.02)).toBe("up 1.0 point");
    expect(describePoints(0.01)).toBe("unchanged");
  });
});

describe("dates", () => {
  it("formats race days without timezone drift", () => {
    expect(formatDateLong("2026-10-25")).toBe("Sun 25 Oct 2026");
    expect(formatDateShort("2026-10-25")).toBe("25 Oct");
  });
  it("formats timestamps in UTC", () => {
    expect(formatTimestamp("2026-10-20T09:14:03Z")).toBe("Tue 20 Oct 2026, 09:14 UTC");
  });
  it("gives relative times", () => {
    const now = Date.parse("2026-10-20T10:00:00Z");
    expect(relativeTime("2026-10-20T09:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-10-20T09:56:00Z", now)).toBe("4 min ago");
    expect(relativeTime("2026-10-20T07:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-10-18T10:00:00Z", now)).toBe("2 days ago");
    expect(relativeTime("2026-10-01T10:00:00Z", now)).toBe("1 Oct");
  });
});

describe("labels", () => {
  it("ordinals", () => {
    expect([1, 2, 3, 4, 9, 11, 12, 13, 21, 22, 23].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "9th", "11th", "12th", "13th", "21st", "22nd", "23rd",
    ]);
  });
  it("races", () => {
    const race = { year: 2024, round: 6, grand_prix: "Miami" };
    expect(raceShort(race)).toBe("R6 Miami");
    expect(raceWithYear(race)).toBe("2024 R6 Miami");
  });
  it("horizons and line-up changes", () => {
    expect(horizonLabel(1)).toBe("1 race ahead");
    expect(horizonLabel(3)).toBe("3 races ahead");
    expect(lineupChangesLabel(1)).toBe("1 line-up change");
    expect(lineupChangesLabel(2)).toBe("2 line-up changes");
  });
  it("groups practice sessions into one chip", () => {
    expect(sessionChips(["fp2", "fp1", "fp3"])).toEqual(["FP1 FP2 FP3"]);
    expect(sessionChips(["q", "fp1", "sq", "sprint"])).toEqual(["FP1", "Sprint qualifying", "Sprint", "Qualifying"]);
    expect(sessionChips([])).toEqual([]);
  });
  it("grid sources", () => {
    expect(gridSourceLabel("none")).toBeNull();
    expect(gridSourceLabel("manual")).toBe("Manual grid");
    expect(gridSourceLabel("live")).toBe("OpenF1 qualifying");
    expect(gridSourceLabel("live+overrides")).toBe("OpenF1 qualifying + penalties");
  });
  it("finishes", () => {
    expect(finishLabel(1, "FIN")).toBe("P1");
    expect(finishLabel(null, "DNF")).toBe("DNF");
    expect(finishLabel(null, "FIN")).toBe("NC");
  });
  it("season ranges use a hyphen", () => {
    expect(seasonRange([2014, 2018, 2022])).toBe("2014-22");
    expect(seasonRange([2026])).toBe("2026");
    expect(seasonRange([])).toBe("");
  });
});
