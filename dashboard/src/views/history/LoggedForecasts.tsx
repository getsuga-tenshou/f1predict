import { CheckCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import type { ModeInfo, RunList } from "../../api/types";
import { useApi } from "../../api/useApi";
import { InlineError, Skeleton } from "../../components/feedback";
import { useNow } from "../../hooks/useNow";
import { formatDateShort, formatProb, formatTimestamp, ordinal, raceShort, relativeTime } from "../../lib/format";
import { byNewest } from "../../lib/forecast";

/** Forecasts run before a race, scored once the result is in the data. */
export function LoggedForecasts({ modes }: { modes: ModeInfo[] }) {
  const api = useApi<RunList>("/api/runs");
  const now = useNow();
  const done = api.data ? byNewest(api.data.runs.filter((r) => r.status === "done")) : [];
  const short = (id: string) => modes.find((m) => m.id === id)?.short ?? id;

  return (
    <section aria-labelledby="logged-title" className="flex flex-col gap-3 border-t border-hair pt-8">
      <div>
        <h2 id="logged-title" className="m-0 text-lg font-semibold text-ink-1">
          Logged forecasts
        </h2>
        <p className="m-0 mt-0.5 text-[13px] text-ink-muted">Every run made before a race, newest first. The moment and scope filters above do not apply here.</p>
      </div>
      {api.error && !api.data ? <InlineError error={api.error} onRetry={api.refetch} title="Could not load logged forecasts" /> : null}
      {api.isFirstLoad ? (
        <div aria-hidden className="flex flex-col gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : null}
      {api.data && done.length === 0 ? (
        <p className="m-0 border-t border-hair pt-4 text-sm text-ink-2">Forecasts you run before a race show up here, scored once the result is in the data.</p>
      ) : null}
      {done.length ? (
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Logged forecasts and their outcome</caption>
          <thead>
            <tr className="border-b border-hair text-left text-xs text-ink-muted">
              <th scope="col" className="py-2 pr-3 font-medium">Made</th>
              <th scope="col" className="py-2 pr-3 font-medium">Race</th>
              <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">Moment</th>
              <th scope="col" className="py-2 pr-3 font-medium">Favourite</th>
              <th scope="col" className="py-2 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {done.map((r) => (
              <tr key={r.id} className="border-b border-hair align-top">
                <td className="py-2 pr-3 whitespace-nowrap text-ink-2" title={formatTimestamp(r.created_at)}>
                  {relativeTime(r.created_at, now)}
                </td>
                <td className="py-2 pr-3 text-ink-1">{`${r.race.year} ${raceShort(r.race)}`}</td>
                <td className="hidden py-2 pr-3 whitespace-nowrap text-ink-2 sm:table-cell">{short(r.mode)}</td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {r.favourite ? (
                    <>
                      <span className="font-mono font-semibold text-ink-1">{r.favourite.driver.abbr}</span>{" "}
                      <span className="tabular-nums">{formatProb(r.favourite.p)}</span>
                    </>
                  ) : null}
                </td>
                <td className="py-2">
                  {r.outcome ? (
                    <div className="flex flex-col gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-ink-1">
                        {r.outcome.favourite_won ? (
                          <CheckCircleIcon size={16} aria-hidden className="shrink-0 text-good" />
                        ) : (
                          <XCircleIcon size={16} aria-hidden className="shrink-0 text-critical" />
                        )}
                        {r.outcome.favourite_won ? "Favourite won" : "Favourite lost"}
                      </span>
                      <span className="text-ink-2 tabular-nums">
                        {`${r.outcome.winner.name} won, given ${formatProb(r.outcome.p_winner)}, ranked ${ordinal(r.outcome.winner_rank)}`}
                      </span>
                    </div>
                  ) : (
                    <span className="text-ink-2">{`Awaiting result, race on ${formatDateShort(r.race.date)}`}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
