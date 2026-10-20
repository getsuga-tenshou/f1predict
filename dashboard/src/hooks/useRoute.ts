import { useCallback, useSyncExternalStore } from "react";
import { parseHash, routeHref, type Route } from "../lib/route";

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

const getHash = () => window.location.hash;

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const href = routeHref(route);
  if (href === window.location.hash) return;
  if (opts.replace) {
    window.history.replaceState(null, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = href;
  }
}

export function useRoute(): [Route, (route: Route, opts?: { replace?: boolean }) => void] {
  const hash = useSyncExternalStore(subscribe, getHash, () => "");
  const go = useCallback((route: Route, opts?: { replace?: boolean }) => navigate(route, opts), []);
  return [parseHash(hash), go];
}
