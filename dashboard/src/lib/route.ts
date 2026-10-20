import type { Mode } from "../api/types";

export type Route =
  | { view: "forecast"; raceId: number | null }
  | { view: "history"; raceId: number | null; mode: Mode | null; scope: string | null };

const MODES: Mode[] = ["pre_weekend", "pre_quali", "pre_race"];

export function isMode(x: unknown): x is Mode {
  return typeof x === "string" && (MODES as string[]).includes(x);
}

function parseId(seg: string | undefined): number | null {
  if (!seg || !/^\d+$/.test(seg)) return null;
  return Number(seg);
}

/** "#/history/1101?mode=pre_race&scope=test" -> route. Anything unknown is the forecast view. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path, query = ""] = raw.split("?");
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "history") {
    const params = new URLSearchParams(query);
    const mode = params.get("mode");
    const scope = params.get("scope");
    return { view: "history", raceId: parseId(segs[1]), mode: isMode(mode) ? mode : null, scope: scope || null };
  }
  return { view: "forecast", raceId: segs[0] === "forecast" ? parseId(segs[1]) : null };
}

export function routeHref(route: Route): string {
  if (route.view === "forecast") return route.raceId != null ? `#/forecast/${route.raceId}` : "#/forecast";
  const params = new URLSearchParams();
  if (route.mode) params.set("mode", route.mode);
  if (route.scope) params.set("scope", route.scope);
  const q = params.toString();
  const base = route.raceId != null ? `#/history/${route.raceId}` : "#/history";
  return q ? `${base}?${q}` : base;
}
