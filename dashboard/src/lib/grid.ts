import type { GridEntry, LiveWeekend } from "../api/types";

/** A driver who can sit on the grid. */
export interface GridDriver {
  driver_id: string;
  abbr: string;
  name: string;
}

/** One row of the grid editor. The row's index is its starting slot (grid_pos = index + 1). */
export interface GridRow extends GridDriver {
  /** Qualifying classification; null means "same as the slot". */
  quali: number | null;
  pitLane: boolean;
}

/** Where the current grid came from. Decides what is sent with the run. */
export type GridOrigin = "manual" | "openf1";

export interface GridState {
  rows: GridRow[];
  origin: GridOrigin;
  /** Snapshot of the rows when the grid was last loaded from OpenF1, to detect penalty edits. */
  loaded: GridRow[] | null;
  /** OpenF1's qualifying classification the grid was built from (origin "openf1"). */
  classification?: NonNullable<LiveWeekend["quali"]>;
}

/** Rows ordered by `order` (driver ids) first, then any remaining drivers in field order. */
export function orderRows<T extends { driver_id: string }>(rows: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ra = rank.get(a.row.driver_id);
      const rb = rank.get(b.row.driver_id);
      if (ra != null && rb != null) return ra - rb;
      if (ra != null) return -1;
      if (rb != null) return 1;
      return a.i - b.i;
    })
    .map(({ row }) => row);
}

/** A fresh manual grid for a field, optionally ordered like a forecast. */
export function initGrid(field: GridDriver[], forecastOrder: string[] = []): GridState {
  const rows = field.map((d) => ({ ...d, quali: null, pitLane: false }));
  return { rows: orderRows(rows, forecastOrder), origin: "manual", loaded: null };
}

/** Grid built from OpenF1 qualifying: ordered by classification, unclassified drivers last. */
export function gridFromQuali(field: GridDriver[], quali: NonNullable<LiveWeekend["quali"]>): GridState {
  const pos = new Map(quali.map((q) => [q.driver.driver_id, q.quali_pos]));
  const ordered = [...field]
    .map((d, i) => ({ d, i, q: pos.get(d.driver_id) ?? null }))
    .sort((a, b) => {
      if (a.q != null && b.q != null) return a.q - b.q;
      if (a.q != null) return -1;
      if (b.q != null) return 1;
      return a.i - b.i;
    });
  const rows: GridRow[] = ordered.map(({ d, q }) => ({ ...d, quali: q, pitLane: false }));
  return { rows, origin: "openf1", loaded: rows.map((r) => ({ ...r })), classification: quali };
}

/**
 * The grid for a changed field (line-up edits). An OpenF1 grid is rebuilt from the classification,
 * so a substitute who qualified takes his own slot instead of inheriting a seat at the back, and
 * the rebuilt grid counts as unedited (nothing is sent as a penalty). A manual grid keeps its order.
 */
export function gridForField(state: GridState, field: GridDriver[]): GridState {
  if (state.origin === "openf1" && state.classification) return gridFromQuali(field, state.classification);
  return { ...state, rows: syncGridWithField(state.rows, field) };
}

/** Move one row up (-1) or down (+1). Out-of-range moves return the same array. */
export function moveRow(rows: GridRow[], index: number, delta: -1 | 1): GridRow[] {
  const target = index + delta;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  const [row] = next.splice(index, 1);
  next.splice(target, 0, row);
  return next;
}

export function updateRow(rows: GridRow[], driverId: string, patch: Partial<Pick<GridRow, "quali" | "pitLane">>): GridRow[] {
  return rows.map((r) => (r.driver_id === driverId ? { ...r, ...patch } : r));
}

/** The qualifying position shown in the editor: the explicit value, else the slot. */
export function effectiveQuali(row: GridRow, index: number): number {
  return row.quali ?? index + 1;
}

export function toGridEntries(rows: GridRow[]): GridEntry[] {
  return rows.map((r, i) => ({
    driver_id: r.driver_id,
    // null = "same as the slot": the server fills it in, so it can't clash with an explicit value.
    quali_pos: r.quali,
    grid_pos: i + 1,
    pit_lane_start: r.pitLane,
  }));
}

function sameRows(a: GridRow[], b: GridRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i];
    return r.driver_id === o.driver_id && effectiveQuali(r, i) === effectiveQuali(o, i) && r.pitLane === o.pitLane;
  });
}

/** True when an OpenF1-loaded grid was changed afterwards (penalties, pit-lane starts). */
export function isEditedAfterLoad(state: GridState): boolean {
  return state.origin === "openf1" && state.loaded != null && !sameRows(state.rows, state.loaded);
}

/**
 * The `grid` field of a run request.
 * Live off: always the manual scenario. Live on: only an OpenF1 grid that was edited afterwards.
 */
export function gridToSend(state: GridState | null, live: boolean): GridEntry[] | undefined {
  if (!state || state.rows.length === 0) return undefined;
  if (!live) return toGridEntries(state.rows);
  return isEditedAfterLoad(state) ? toGridEntries(state.rows) : undefined;
}

/**
 * Keep the grid in step with a changed field (line-up edits): drivers who left are replaced
 * in place by the drivers who joined, in order; any extra newcomers go to the back.
 */
export function syncGridWithField(rows: GridRow[], field: GridDriver[]): GridRow[] {
  const inField = new Set(field.map((d) => d.driver_id));
  const onGrid = new Set(rows.map((r) => r.driver_id));
  const joined = field.filter((d) => !onGrid.has(d.driver_id));
  if (joined.length === 0 && rows.every((r) => inField.has(r.driver_id))) return rows;
  const queue = [...joined];
  const next: GridRow[] = [];
  for (const r of rows) {
    if (inField.has(r.driver_id)) {
      next.push(r);
    } else {
      const d = queue.shift();
      if (d) next.push({ ...d, quali: r.quali, pitLane: r.pitLane });
    }
  }
  for (const d of queue) next.push({ ...d, quali: null, pitLane: false });
  return next;
}
