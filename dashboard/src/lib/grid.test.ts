import { describe, expect, it } from "vitest";
import {
  effectiveQuali,
  gridForField,
  gridFromQuali,
  gridToSend,
  initGrid,
  isEditedAfterLoad,
  moveRow,
  syncGridWithField,
  toGridEntries,
  updateRow,
  type GridDriver,
} from "./grid";

const d = (id: string): GridDriver => ({ driver_id: id, abbr: id.toUpperCase(), name: id });
const field = ["ver", "ham", "lec", "nor"].map(d);

const ref = (id: string) => ({ driver_id: id, name: id, abbr: id, number: null, team_id: "t", team: "T" });

describe("initGrid", () => {
  it("keeps field order without a forecast", () => {
    expect(initGrid(field).rows.map((r) => r.driver_id)).toEqual(["ver", "ham", "lec", "nor"]);
  });
  it("orders by forecast, unknown drivers after", () => {
    const g = initGrid(field, ["lec", "nor"]);
    expect(g.rows.map((r) => r.driver_id)).toEqual(["lec", "nor", "ver", "ham"]);
    expect(g.origin).toBe("manual");
  });
});

describe("moving rows", () => {
  it("moves up and down and ignores out-of-range moves", () => {
    const rows = initGrid(field).rows;
    expect(moveRow(rows, 1, -1).map((r) => r.driver_id)).toEqual(["ham", "ver", "lec", "nor"]);
    expect(moveRow(rows, 1, 1).map((r) => r.driver_id)).toEqual(["ver", "lec", "ham", "nor"]);
    expect(moveRow(rows, 0, -1)).toBe(rows);
    expect(moveRow(rows, 3, 1)).toBe(rows);
  });
});

describe("toGridEntries", () => {
  it("uses the slot as grid_pos and leaves an unset quali to the server (same as the slot)", () => {
    let rows = initGrid(field).rows;
    rows = updateRow(rows, "lec", { quali: 1, pitLane: true });
    expect(toGridEntries(rows)).toEqual([
      { driver_id: "ver", quali_pos: null, grid_pos: 1, pit_lane_start: false },
      { driver_id: "ham", quali_pos: null, grid_pos: 2, pit_lane_start: false },
      { driver_id: "lec", quali_pos: 1, grid_pos: 3, pit_lane_start: true },
      { driver_id: "nor", quali_pos: null, grid_pos: 4, pit_lane_start: false },
    ]);
    // The editor still shows the slot; only explicit values are sent, so they can't collide.
    expect(effectiveQuali(rows[0], 0)).toBe(1);
  });
});

describe("gridForField", () => {
  const quali = [
    { driver: ref("nor"), quali_pos: 1, gap_pct: 0 },
    { driver: ref("bea"), quali_pos: 2, gap_pct: 0.1 }, // a substitute, not in the default field
    { driver: ref("ver"), quali_pos: 3, gap_pct: 0.2 },
  ];

  it("rebuilds an OpenF1 grid from the classification, so a substitute takes his own slot", () => {
    const loaded = gridFromQuali(field, quali); // bea is not in the field yet; ham and lec unclassified
    const withBea = gridForField(loaded, [d("ver"), d("bea"), d("lec"), d("nor")]);
    expect(withBea.rows.map((r) => [r.driver_id, r.quali])).toEqual([
      ["nor", 1],
      ["bea", 2],
      ["ver", 3],
      ["lec", null],
    ]);
    expect(isEditedAfterLoad(withBea)).toBe(false);
    expect(gridToSend(withBea, true)).toBeUndefined(); // OpenF1's own grid is used, no bogus penalty
  });

  it("keeps a manual grid's order and swaps the newcomer into the leaver's slot", () => {
    const manual = { ...initGrid(field), rows: moveRow(initGrid(field).rows, 3, -1) }; // ver ham nor lec
    const next = gridForField(manual, [d("ver"), d("bea"), d("lec"), d("nor")]);
    expect(next.rows.map((r) => r.driver_id)).toEqual(["ver", "bea", "nor", "lec"]);
    expect(next.origin).toBe("manual");
  });
});

describe("gridToSend", () => {
  const quali = [
    { driver: ref("nor"), quali_pos: 1, gap_pct: 0 },
    { driver: ref("ver"), quali_pos: 2, gap_pct: 0.1 },
    { driver: ref("lec"), quali_pos: 3, gap_pct: 0.2 },
  ];

  it("live off sends the manual grid", () => {
    const g = initGrid(field);
    expect(gridToSend(g, false)?.map((e) => e.driver_id)).toEqual(["ver", "ham", "lec", "nor"]);
  });

  it("live on omits a manual grid", () => {
    expect(gridToSend(initGrid(field), true)).toBeUndefined();
  });

  it("orders OpenF1 qualifying by position with unclassified drivers last", () => {
    const g = gridFromQuali(field, quali);
    expect(g.rows.map((r) => [r.driver_id, r.quali])).toEqual([
      ["nor", 1],
      ["ver", 2],
      ["lec", 3],
      ["ham", null],
    ]);
  });

  it("live on omits an unedited OpenF1 grid and sends an edited one", () => {
    const g = gridFromQuali(field, quali);
    expect(isEditedAfterLoad(g)).toBe(false);
    expect(gridToSend(g, true)).toBeUndefined();

    // Norris gets a penalty: moved back one slot, still qualified first.
    const edited = { ...g, rows: moveRow(g.rows, 0, 1) };
    expect(isEditedAfterLoad(edited)).toBe(true);
    const sent = gridToSend(edited, true);
    expect(sent?.[1]).toEqual({ driver_id: "nor", quali_pos: 1, grid_pos: 2, pit_lane_start: false });
  });

  it("a pit-lane flag counts as an edit", () => {
    const g = gridFromQuali(field, quali);
    const edited = { ...g, rows: updateRow(g.rows, "lec", { pitLane: true }) };
    expect(gridToSend(edited, true)).toHaveLength(4);
  });

  it("nothing to send without rows", () => {
    expect(gridToSend(null, false)).toBeUndefined();
  });
});

describe("syncGridWithField", () => {
  it("replaces a driver who left with the one who joined, in the same slot", () => {
    const rows = updateRow(initGrid(field).rows, "ham", { quali: 5 });
    const next = syncGridWithField(rows, [d("ver"), d("bea"), d("lec"), d("nor")]);
    expect(next.map((r) => r.driver_id)).toEqual(["ver", "bea", "lec", "nor"]);
    expect(next[1].quali).toBe(5);
  });
  it("returns the same rows when nothing changed", () => {
    const rows = initGrid(field).rows;
    expect(syncGridWithField(rows, field)).toBe(rows);
  });
  it("appends extra newcomers", () => {
    const rows = initGrid(field).rows;
    const next = syncGridWithField(rows, [...field, d("col")]);
    expect(next.map((r) => r.driver_id)).toEqual(["ver", "ham", "lec", "nor", "col"]);
  });
});
