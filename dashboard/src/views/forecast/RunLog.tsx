import { TrashIcon, XIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { del, errorMessage } from "../../api/client";
import type { ModeInfo, RunSummary } from "../../api/types";
import { refetchWhere } from "../../api/useApi";
import { Button, IconButton } from "../../components/Button";
import { HoverTip, InlineError, Skeleton } from "../../components/feedback";
import { useNow } from "../../hooks/useNow";
import { formatProb, formatTimestamp, raceShort, relativeTime } from "../../lib/format";
import { byNewest, isActiveStatus } from "../../lib/forecast";

const VISIBLE = 8;

/** Most recent runs across all races. Picking a done run displays it. */
export function RunLog({
  runs,
  error,
  isFirstLoad,
  isStale,
  onRetry,
  modes,
  displayedId,
  onPick,
  onDeleted,
}: {
  runs: RunSummary[] | undefined;
  error: unknown;
  isFirstLoad: boolean;
  isStale: boolean;
  onRetry: () => void;
  modes: ModeInfo[];
  displayedId: string | null;
  onPick: (run: RunSummary) => void;
  onDeleted: (id: string) => void;
}) {
  const now = useNow();
  const [showAll, setShowAll] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  // The delete button is swapped for the confirm pair (and back), so focus is moved by hand.
  const [refocus, setRefocus] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const all = runs ? byNewest(runs) : [];
  const list = showAll ? all : all.slice(0, VISIBLE);
  const short = (id: string) => modes.find((m) => m.id === id)?.short ?? id;

  const remove = async (id: string) => {
    setDeleting(id);
    setDeleteError(null);
    try {
      await del(`/api/runs/${id}`);
      setConfirming(null);
      titleRef.current?.focus();
      onDeleted(id);
      refetchWhere((u) => u === "/api/runs" || u === `/api/runs/${id}`);
    } catch (err) {
      setDeleteError({ id, message: errorMessage(err) });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section aria-labelledby="runlog-title" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="runlog-title" ref={titleRef} tabIndex={-1} className="m-0 text-lg font-semibold text-ink-1 outline-none">
          Run log
        </h2>
        {all.length > VISIBLE ? (
          <Button size="sm" variant="ghost" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>
            {showAll ? "Show fewer" : `Show all ${all.length}`}
          </Button>
        ) : null}
      </div>

      {error && !runs ? <InlineError error={error} onRetry={onRetry} title="Could not load the run log" /> : null}

      {isFirstLoad ? (
        <div aria-hidden className="flex flex-col">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex h-10 items-center gap-4 border-b border-hair">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="ml-auto h-3 w-16" />
            </div>
          ))}
        </div>
      ) : null}

      {runs && all.length === 0 ? (
        <p className="m-0 border-t border-hair pt-4 text-sm text-ink-2">No runs yet. Use the form to run a forecast; it will be listed here.</p>
      ) : null}

      {all.length ? (
        <div className={`transition-opacity duration-200 ${isStale ? "opacity-60" : ""}`}>
          <table className="w-full border-collapse text-[13px]">
            <caption className="sr-only">Recent forecast runs, newest first</caption>
            <thead>
              <tr className="border-b border-hair text-left text-xs text-ink-muted">
                <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">
                  Made
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Race
                </th>
                <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">Moment</th>
                <th scope="col" className="hidden py-2 pr-3 font-medium lg:table-cell">Label</th>
                <th scope="col" className="py-2 pr-3 font-medium">Favourite</th>
                <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">Source</th>
                <th scope="col" className="py-2 pr-1 font-medium">Status</th>
                <th scope="col" className="w-8 p-0">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const done = r.status === "done";
                const current = r.id === displayedId;
                return (
                  <tr
                    key={r.id}
                    aria-current={current ? "true" : undefined}
                    onClick={done ? () => onPick(r) : undefined}
                    className={`h-10 border-b border-hair transition-colors ${done ? "cursor-pointer hover:bg-tint" : ""} ${current ? "bg-tint" : ""}`}
                  >
                    <td className="hidden py-1.5 pr-3 whitespace-nowrap text-ink-2 sm:table-cell" title={formatTimestamp(r.created_at)}>
                      {relativeTime(r.created_at, now)}
                    </td>
                    <td className="py-1.5 pr-3">
                      {/* Below 640px the made time sits under the race instead of in its own column. */}
                      <span className="block text-xs text-ink-muted sm:hidden">{relativeTime(r.created_at, now)}</span>
                      {done ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPick(r);
                          }}
                          className={`rounded-badge text-left text-ink-1 hover:underline ${current ? "font-medium" : ""}`}
                        >
                          {raceShort(r.race)}
                          {current ? <span className="sr-only"> (shown)</span> : null}
                        </button>
                      ) : (
                        <span className="text-ink-1">{raceShort(r.race)}</span>
                      )}
                    </td>
                    <td className="hidden py-1.5 pr-3 whitespace-nowrap text-ink-2 sm:table-cell">{short(r.mode)}</td>
                    <td className="hidden max-w-[160px] truncate py-1.5 pr-3 text-ink-2 lg:table-cell" title={r.label ?? undefined}>
                      {r.label ?? ""}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {r.favourite ? (
                        <>
                          <span className="font-mono font-semibold text-ink-1">{r.favourite.driver.abbr}</span>{" "}
                          <span className="text-ink-1 tabular-nums">{formatProb(r.favourite.p)}</span>
                        </>
                      ) : null}
                    </td>
                    <td className="hidden py-1.5 pr-3 text-ink-2 md:table-cell">{r.source === "cli" ? "CLI" : "Dashboard"}</td>
                    <td className="py-1.5 pr-1">
                      <RunStatusCell run={r} />
                    </td>
                    <td className="py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                      {r.source === "dashboard" && !isActiveStatus(r.status) ? (
                        confirming === r.id ? (
                          <span className="inline-flex items-center gap-1">
                            <IconButton
                              size="sm"
                              label="Cancel delete"
                              icon={<XIcon size={16} aria-hidden />}
                              autoFocus
                              onClick={() => {
                                setConfirming(null);
                                setRefocus(r.id);
                              }}
                              disabled={deleting === r.id}
                            />
                            <Button size="sm" variant="primary" onClick={() => void remove(r.id)} disabled={deleting === r.id}>
                              {deleting === r.id ? "Deleting" : "Confirm delete"}
                            </Button>
                          </span>
                        ) : (
                          <IconButton
                            size="sm"
                            label={`Delete run for ${raceShort(r.race)}, ${relativeTime(r.created_at, now)}`}
                            icon={<TrashIcon size={16} aria-hidden />}
                            autoFocus={refocus === r.id}
                            onFocus={refocus === r.id ? () => setRefocus(null) : undefined}
                            onClick={() => {
                              setConfirming(r.id);
                              setRefocus(null);
                              setDeleteError(null);
                            }}
                          />
                        )
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {deleteError ? (
            <div className="mt-3">
              <InlineError error={new Error(deleteError.message)} title="Could not delete the run" />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RunStatusCell({ run }: { run: RunSummary }) {
  if (run.status === "done") return <span className="text-ink-2">Done</span>;
  if (run.status === "error") {
    return (
      <HoverTip align="end" triggerClassName="rounded-badge text-ink-1 underline decoration-ink-3 underline-offset-2" tip={run.error ?? "No error message."}>
        Failed
      </HoverTip>
    );
  }
  return <span className="text-ink-2">{run.stage ?? (run.status === "queued" ? "Queued" : "Running")}</span>;
}
