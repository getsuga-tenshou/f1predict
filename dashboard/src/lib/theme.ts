export type ThemePref = "system" | "light" | "dark";

const KEY = "f1predict-theme";

export function parseThemePref(value: unknown): ThemePref {
  return value === "light" || value === "dark" ? value : "system";
}

export function readThemePref(): ThemePref {
  try {
    return parseThemePref(window.localStorage.getItem(KEY));
  } catch {
    return "system";
  }
}

export function writeThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, pref);
  } catch {
    // Storage can be unavailable (private window, blocked site data); the choice just won't persist.
  }
}

/** System = no attribute, so the prefers-color-scheme media query decides. */
export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}
