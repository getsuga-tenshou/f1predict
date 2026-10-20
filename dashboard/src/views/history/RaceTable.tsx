import { ArrowDownIcon, ArrowUpIcon, CheckIcon } from "@phosphor-icons/react";
import { useState, type Ref } from "react";
import type { HistoryRace, Split } from "../../api/types";
import { Button } from "../../components/Button";
import { Badge } from "../../components/feedback";
import { formatLogloss, formatProb, ordinal } from "../../lib/format";
import { sortRaces, type RaceSortKey, type SortDir } from "../../lib/history";

const PAGE = 30;
const SPLIT_TEXT: Record<Split, string> = { validation: "Validation", test: "Test", holdout: "Holdout" };

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className = "",
}: {
  label: string;
  k: RaceSortKey;
  sort: { key: RaceSortKey; dir: SortDir };
  onSort: (k: RaceSortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={`py-2 font-medium ${className}`}>
      <button type="button" onClick={() => onSort(k)} className={`inline-flex items-center gap-1 rounded-badge ${active ? "text-ink-1" : "hover:text-ink-1"}`}>
        {label}
        {active ? sort.dir === "asc" ? <ArrowUpIcon size={12} aria-hidden /> : <ArrowDownIcon size={12} aria-hidden /> : null}
      </button>
    </th>
  );
}

/** Every race in scope, the table twin of the winner-probability chart. */
export function RaceTable({
  races,
  hrefFor,
  onOpen,
  ref,
}: {
  races: HistoryRace[];
  hrefFor: (raceId: number) => string;
  onOpen: (raceId: number) => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const [sort, setSort] = useState<{ key: RaceSortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  const [limit, setLimit] = useState(PAGE);
  const sorted = sortRaces(races, sort.key, sort.dir);
  const visible = sorted.slice(0, limit);

  const onSort = (k: RaceSortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "date" ? "desc" : "asc" }));

  return (
    <div ref={ref} tabIndex={-1} role="region" className="flex flex-col gap-3 rounded-panel outline-offset-4" aria-labelledby="races-title">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="races-title" className="m-0 text-lg font-semibold text-ink-1">
          Races
        </h2>
        <span className="text-[13px] text-ink-muted">{`${races.length} in scope`}</span>
      </div>
      <div>
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Races in scope with the favourite, the winner and log-loss. Select a race for details.</caption>
          <thead>
            <tr className="border-b border-hair text-left text-xs text-ink-muted">
              <SortHeader label="Race" k="date" sort={sort} onSort={onSort} className="pr-3" />
              <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">
                Split
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Favourite
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Winner
              </th>
              <SortHeader label="Log-loss" k="logloss" sort={sort} onSort={onSort} className="text-right" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.race.race_id} onClick={() => onOpen(r.race.race_id)} className="h-10 cursor-pointer border-b border-hair transition-colors hover:bg-tint hover:tint-lift">
                <td className="py-1.5 pr-3">
                  <a href={hrefFor(r.race.race_id)} className="rounded-badge text-ink-1 hover:underline" onClick={(e) => e.stopPropagation()}>
                    <span className="tabular-nums">{`${r.race.year} R${r.race.round}`}</span>
                    <span className="ml-2 text-ink-2">{r.race.grand_prix}</span>
                  </a>
                </td>
                <td className="hidden py-1.5 pr-3 sm:table-cell">
                  <Badge>{SPLIT_TEXT[r.split]}</Badge>
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className="font-mono font-semibold text-ink-1">{r.favourite.driver.abbr}</span>{" "}
                  <span className="tabular-nums">{formatProb(r.favourite.p)}</span>
                </td>
                <td className="py-1.5 pr-3">
                  <span className="inline-flex flex-wrap items-center gap-x-1.5">
                    {r.favourite_won ? <CheckIcon size={14} aria-hidden className="shrink-0 text-ink-1" /> : null}
                    <span className="text-ink-1">{r.winner.driver.name}</span>
                    <span className="text-ink-2 tabular-nums whitespace-nowrap">{`${formatProb(r.winner.p)}, ${ordinal(r.winner.rank)}`}</span>
                    {r.favourite_won ? <span className="sr-only">(favourite won)</span> : null}
                  </span>
                </td>
                <td className="py-1.5 text-right whitespace-nowrap tabular-nums">
                  <span className="text-ink-1">{formatLogloss(r.logloss)}</span>
                  <span className="hidden text-ink-muted sm:inline">{` / ${formatLogloss(r.baseline_logloss)}`}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-4 text-[13px] text-ink-muted">
        <span className="hidden sm:inline">Log-loss shows model / baseline.</span>
        {limit < sorted.length ? (
          <Button size="sm" className="ml-auto" onClick={() => setLimit((l) => l + PAGE)}>
            {`Show ${Math.min(PAGE, sorted.length - limit)} more`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
