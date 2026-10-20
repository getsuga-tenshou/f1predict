import type { Outlook, RunRow, RunStatus, RunSummary } from "../api/types";
import { pointsDelta } from "./format";

export function byNewest<T extends { created_at: string }>(runs: T[]): T[] {
  return [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function isActiveStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

/** Done runs for one race, newest first. */
export function doneRunsForRace(runs: RunSummary[], raceId: number): RunSummary[] {
  return byNewest(runs.filter((r) => r.status === "done" && r.race.race_id === raceId));
}

/** The run to show: the one picked in the run log (if it belongs to this race), else the newest done run. */
export function pickDisplayedRun(runs: RunSummary[], raceId: number, chosenId: string | null): RunSummary | null {
  const done = doneRunsForRace(runs, raceId);
  if (chosenId) {
    const chosen = done.find((r) => r.id === chosenId);
    if (chosen) return chosen;
  }
  return done[0] ?? null;
}

/** Runs the displayed run can be compared with: the other done runs of the same race. */
export function compareCandidates(runs: RunSummary[], raceId: number, displayedId: string | null): RunSummary[] {
  return doneRunsForRace(runs, raceId).filter((r) => r.id !== displayedId);
}

export type RowDelta = { kind: "points"; value: number } | { kind: "new" };

/** Per driver: change in points against the comparison run, or "new" when the driver was not in it. */
export function rowDeltas(rows: RunRow[], compareRows: RunRow[]): Map<string, RowDelta> {
  const prev = new Map(compareRows.map((r) => [r.driver.driver_id, r.p]));
  const out = new Map<string, RowDelta>();
  for (const r of rows) {
    const p0 = prev.get(r.driver.driver_id);
    out.set(r.driver.driver_id, p0 == null ? { kind: "new" } : { kind: "points", value: pointsDelta(r.p, p0) });
  }
  return out;
}

/** Largest |contribution| across every driver's "why", so all rows share one scale. */
export function maxAbsContribution(rows: RunRow[]): number {
  let m = 0;
  for (const r of rows) for (const c of r.why) m = Math.max(m, Math.abs(c.value));
  return m;
}

export type OutlookDriver = Outlook["drivers"][number];

/** Drivers worth a bar in the season outlook (expected wins >= threshold), most first. */
export function outlookContenders(outlook: Outlook, threshold = 0.05): OutlookDriver[] {
  return [...outlook.drivers].filter((d) => d.expected_wins >= threshold).sort((a, b) => b.expected_wins - a.expected_wins);
}

/** The remaining race where a driver's chance is highest. */
export function bestRace(outlook: Outlook, driver: OutlookDriver): { index: number; p: number } | null {
  let best: { index: number; p: number } | null = null;
  driver.p.forEach((p, index) => {
    if (index < outlook.races.length && (best === null || p > best.p)) best = { index, p };
  });
  return best;
}
