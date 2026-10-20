import type { Lineup, LineupEntry } from "../api/types";
import type { GridDriver } from "./grid";

/** Seats per team: team_id -> driver_id in each seat, in the default entrants' order. */
export type Seats = Record<string, string[]>;

export type DriverOption = Lineup["candidates"][number];

export function defaultSeats(lineup: Pick<Lineup, "teams" | "entrants">): Seats {
  const seats: Seats = {};
  for (const t of lineup.teams) seats[t.team_id] = [];
  for (const e of lineup.entrants) {
    (seats[e.team_id] ??= []).push(e.driver_id);
  }
  return seats;
}

function findSeat(seats: Seats, driverId: string): { team: string; idx: number } | null {
  for (const [team, ids] of Object.entries(seats)) {
    const idx = ids.indexOf(driverId);
    if (idx >= 0) return { team, idx };
  }
  return null;
}

/**
 * Put `driverId` in a seat. A driver can only hold one seat: if they were seated elsewhere,
 * that seat goes back to its default driver, or, when the default is already seated (or is
 * the driver being moved), it takes the driver who was just displaced.
 */
export function assignSeat(seats: Seats, defaults: Seats, teamId: string, seatIdx: number, driverId: string): Seats {
  const current = seats[teamId]?.[seatIdx];
  if (current === undefined || current === driverId) return seats;
  const other = findSeat(seats, driverId);
  const next: Seats = Object.fromEntries(Object.entries(seats).map(([k, v]) => [k, [...v]]));
  next[teamId][seatIdx] = driverId;
  if (other) {
    const fallback = defaults[other.team]?.[other.idx];
    const fallbackSeated = fallback === undefined || fallback === driverId || findSeat(next, fallback) !== null;
    next[other.team][other.idx] = fallbackSeated ? current : fallback;
  }
  return next;
}

/** Keys "team_id:seat" of seats that differ from the default line-up. */
export function changedSeats(seats: Seats, defaults: Seats): Set<string> {
  const out = new Set<string>();
  for (const [team, ids] of Object.entries(seats)) {
    ids.forEach((id, i) => {
      if (defaults[team]?.[i] !== id) out.add(`${team}:${i}`);
    });
  }
  return out;
}

export function isLineupChanged(seats: Seats, defaults: Seats): boolean {
  return changedSeats(seats, defaults).size > 0;
}

/** Full field for the run request, in team order. */
export function toLineupEntries(seats: Seats, teams: Lineup["teams"]): LineupEntry[] {
  return teams.flatMap((t) =>
    (seats[t.team_id] ?? []).map((driver_id) => ({ driver_id, team_id: t.team_id, engine_id: t.engine_id })),
  );
}

/** Everyone who can be picked for a seat: candidates plus default entrants, by name. */
export function driverOptions(lineup: Pick<Lineup, "candidates" | "entrants">): DriverOption[] {
  const byId = new Map<string, DriverOption>();
  for (const c of lineup.candidates) byId.set(c.driver_id, c);
  for (const e of lineup.entrants) {
    if (!byId.has(e.driver_id)) {
      byId.set(e.driver_id, { driver_id: e.driver_id, name: e.name, abbr: e.abbr, number: e.number });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The field the seats describe, as grid drivers, in team order. */
export function fieldFromSeats(seats: Seats, teams: Lineup["teams"], options: DriverOption[]): GridDriver[] {
  const byId = new Map(options.map((o) => [o.driver_id, o]));
  return teams.flatMap((t) =>
    (seats[t.team_id] ?? []).map((id) => {
      const d = byId.get(id);
      return { driver_id: id, abbr: d?.abbr ?? id.slice(0, 3).toUpperCase(), name: d?.name ?? id };
    }),
  );
}
