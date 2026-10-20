import type { GridSource, RaceRef, SessionKind } from "../api/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Win probability as shown everywhere: one decimal, "<0.1%" below a tenth of a percent. */
export function formatProb(p: number): string {
  if (!Number.isFinite(p)) return "";
  if (p < 0.001) return "<0.1%";
  return `${(p * 100).toFixed(1)}%`;
}

/** A plain percentage of a rate (0-1), default no decimals: "63%". */
export function formatPercent(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** Signed number with an ASCII sign: "+0.95", "-0.32", "0.00". */
export function formatSigned(x: number, digits = 2): string {
  const s = Math.abs(x).toFixed(digits);
  if (Number(s) === 0) return s;
  return x > 0 ? `+${s}` : `-${s}`;
}

/** Change in percentage points between two probabilities, signed, one decimal. */
export function pointsDelta(p: number, previous: number): number {
  return (p - previous) * 100;
}

/** "up 3.1 points", "down 0.4 points", "unchanged". */
export function describePoints(delta: number): string {
  const abs = Math.abs(delta);
  if (abs < 0.05) return "unchanged";
  const n = abs.toFixed(1);
  const unit = n === "1.0" ? "point" : "points";
  return `${delta > 0 ? "up" : "down"} ${n} ${unit}`;
}

function parseDay(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

/** "Sun 25 Oct 2026" from "2026-10-25". */
export function formatDateLong(date: string): string {
  const d = parseDay(date);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "25 Oct" from "2026-10-25". */
export function formatDateShort(date: string): string {
  const d = parseDay(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Tue 20 Oct 2026, 09:14 UTC" from an ISO timestamp. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** "just now", "4 min ago", "3 h ago", "2 days ago", then "12 Oct". */
export function relativeTime(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return days === 1 ? "1 day ago" : `${days} days ago`;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 22 -> "22nd". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "R18 United States". */
export function raceShort(race: Pick<RaceRef, "round" | "grand_prix">): string {
  return `R${race.round} ${race.grand_prix}`;
}

/** "2024 R6 Miami". */
export function raceWithYear(race: Pick<RaceRef, "year" | "round" | "grand_prix">): string {
  return `${race.year} R${race.round} ${race.grand_prix}`;
}

/** "1 race ahead", "3 races ahead". */
export function horizonLabel(h: number): string {
  return h === 1 ? "1 race ahead" : `${h} races ahead`;
}

const SESSION_LABEL: Record<SessionKind, string> = {
  fp1: "FP1",
  fp2: "FP2",
  fp3: "FP3",
  sq: "Sprint qualifying",
  sprint: "Sprint",
  q: "Qualifying",
};
const SESSION_ORDER: SessionKind[] = ["fp1", "fp2", "fp3", "sq", "sprint", "q"];

/** Chips for the sessions a run used: practice grouped ("FP1 FP2 FP3"), the rest one chip each. */
export function sessionChips(kinds: SessionKind[]): string[] {
  const set = new Set(kinds);
  const ordered = SESSION_ORDER.filter((k) => set.has(k));
  const practice = ordered.filter((k) => k.startsWith("fp")).map((k) => SESSION_LABEL[k]);
  const rest = ordered.filter((k) => !k.startsWith("fp")).map((k) => SESSION_LABEL[k]);
  return practice.length ? [practice.join(" "), ...rest] : rest;
}

/** Text for how the starting grid was supplied, or null when the run used none. */
export function gridSourceLabel(source: GridSource): string | null {
  switch (source) {
    case "manual":
      return "Manual grid";
    case "live":
      return "OpenF1 qualifying";
    case "live+overrides":
      return "OpenF1 qualifying + penalties";
    default:
      return null;
  }
}

/** "1 line-up change", "3 line-up changes". */
export function lineupChangesLabel(n: number): string {
  return n === 1 ? "1 line-up change" : `${n} line-up changes`;
}

/** Actual finish as shown in tables: "P1", or the F1DB status ("DNF", "DSQ") when unclassified. */
export function finishLabel(finishPos: number | null, status?: string | null): string {
  if (finishPos != null) return `P${finishPos}`;
  if (status && status !== "FIN") return status;
  return "NC";
}

/** "2014-22" for a span of seasons; a single season is just "2026". */
export function seasonRange(seasons: number[]): string {
  if (!seasons.length) return "";
  const lo = Math.min(...seasons);
  const hi = Math.max(...seasons);
  if (lo === hi) return String(lo);
  const sameCentury = Math.floor(lo / 100) === Math.floor(hi / 100);
  return `${lo}-${sameCentury ? String(hi).slice(2) : hi}`;
}

/** Log-loss with three decimals, as in the evaluation report. */
export function formatLogloss(x: number): string {
  return x.toFixed(3);
}
