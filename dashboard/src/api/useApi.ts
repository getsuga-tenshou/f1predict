import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { getJSON } from "./client";

/** A tiny cache-by-URL store: one in-flight request per URL, subscribers re-render on change. */

interface Snapshot {
  data: unknown;
  error: unknown;
  loading: boolean;
}

interface Entry {
  snapshot: Snapshot;
  inflight: Promise<void> | null;
  listeners: Set<() => void>;
}

const EMPTY: Snapshot = { data: undefined, error: undefined, loading: false };
const store = new Map<string, Entry>();

function entryFor(url: string): Entry {
  let e = store.get(url);
  if (!e) {
    e = { snapshot: EMPTY, inflight: null, listeners: new Set() };
    store.set(url, e);
  }
  return e;
}

function update(e: Entry, patch: Partial<Snapshot>): void {
  e.snapshot = { ...e.snapshot, ...patch };
  for (const l of [...e.listeners]) l();
}

function load(url: string, force: boolean): Promise<void> {
  const e = entryFor(url);
  if (e.inflight) return e.inflight;
  if (!force && e.snapshot.data !== undefined) return Promise.resolve();
  update(e, { loading: true });
  e.inflight = getJSON<unknown>(url)
    .then(
      (data) => update(e, { data, error: undefined, loading: false }),
      (error: unknown) => update(e, { error, loading: false }),
    )
    .finally(() => {
      e.inflight = null;
    });
  return e.inflight;
}

/** Refetch every cached URL that matches; unwatched matches are dropped so they load fresh later. */
export function refetchWhere(match: (url: string) => boolean): void {
  for (const [url, e] of store) {
    if (!match(url)) continue;
    if (e.listeners.size > 0) void load(url, true);
    else store.delete(url);
  }
}

/** Put a response in the cache (e.g. a finished run that was just polled). */
export function primeCache(url: string, data: unknown): void {
  update(entryFor(url), { data, error: undefined, loading: false });
}

export interface ApiState<T> {
  /** Data for this URL, or the previous URL's data while this one loads (keep-previous). */
  data: T | undefined;
  error: unknown;
  /** Nothing to show yet: render a skeleton. */
  isFirstLoad: boolean;
  /** Showing older data while new data loads: dim it, keep the frame. */
  isStale: boolean;
  /** A request for this URL is in flight. */
  isLoading: boolean;
  refetch: () => void;
}

export function useApi<T>(url: string | null): ApiState<T> {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!url) return () => {};
      const e = entryFor(url);
      e.listeners.add(cb);
      return () => {
        e.listeners.delete(cb);
      };
    },
    [url],
  );
  const getSnapshot = useCallback(() => (url ? entryFor(url).snapshot : EMPTY), [url]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (url) void load(url, false);
  }, [url]);

  const previous = useRef<T | undefined>(undefined);
  const current = snap.data as T | undefined;
  if (current !== undefined) previous.current = current;
  if (!url) previous.current = undefined;
  // Keep the previous URL's data only while this one loads; once it has failed, show the failure
  // instead of an old view that would stay dimmed forever.
  const data = url ? (current ?? (snap.error ? undefined : previous.current)) : undefined;

  const refetch = useCallback(() => {
    if (url) void load(url, true);
  }, [url]);

  return {
    data,
    error: url ? snap.error : undefined,
    isFirstLoad: url != null && data === undefined && !snap.error,
    isStale: data !== undefined && (current === undefined || snap.loading),
    isLoading: url != null && snap.loading,
    refetch,
  };
}
