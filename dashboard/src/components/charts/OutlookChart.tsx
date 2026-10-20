import { useState } from "react";
import type { Outlook } from "../../api/types";
import { useElementWidth } from "../../hooks/useElementWidth";
import { formatPercent, formatProb, raceShort } from "../../lib/format";
import { bestRace, type OutlookDriver } from "../../lib/forecast";
import { ChartTooltip, TipRow } from "./ChartFrame";

/**
 * Expected wins over the remaining races, one horizontal bar per contender (single series,
 * accent), value at the bar tip, plus the chance of at least one win as a number column.
 */
/** Tooltip anchor: above the bar tip of the hovered row (offsets are relative to the chart wrapper). */
function anchor(i: number, el: HTMLElement, frac: number) {
  const barW = Math.max(0, el.offsetWidth - 48);
  return { i, x: el.offsetLeft + barW * frac, y: el.offsetTop + 4 };
}

export function OutlookChart({ outlook, drivers }: { outlook: Outlook; drivers: OutlookDriver[] }) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [shown, setShown] = useState<{ i: number; x: number; y: number } | null>(null);
  const max = Math.max(...drivers.map((d) => d.expected_wins), 0);
  const ROW = 30;
  const tip = shown != null ? drivers[shown.i] : null;
  const best = tip ? bestRace(outlook, tip) : null;

  return (
    <div ref={wrapRef} className="relative">
      <div className="grid grid-cols-[minmax(0,1fr)_88px] items-end gap-x-4 border-b border-hair pb-1.5 text-xs text-ink-muted sm:grid-cols-[150px_minmax(0,1fr)_120px]">
        <span className="hidden sm:block">Driver</span>
        <span>Expected wins</span>
        <span className="text-right leading-tight">Chance of at least one win</span>
      </div>
      <ul className="m-0 list-none p-0">
        {drivers.map((d, i) => {
          const frac = max > 0 ? d.expected_wins / max : 0;
          return (
            <li key={d.driver.driver_id} className="grid grid-cols-[minmax(0,1fr)_88px] items-center gap-x-4 sm:grid-cols-[150px_minmax(0,1fr)_120px]" style={{ minHeight: ROW }}>
              <span className="col-span-2 flex min-w-0 items-baseline gap-2 pt-1.5 sm:col-span-1 sm:pt-0">
                <span className="w-9 shrink-0 font-mono text-[13px] font-semibold text-ink-1">{d.driver.abbr}</span>
                <span className="truncate text-[13px] text-ink-2">{d.driver.name}</span>
              </span>
              <button
                type="button"
                className="group relative flex h-7 min-w-0 items-center text-left outline-offset-0"
                aria-label={`${d.driver.name}: ${d.expected_wins.toFixed(2)} expected wins, ${formatPercent(d.p_at_least_one, 1)} chance of at least one win`}
                onPointerEnter={(e) => setShown(anchor(i, e.currentTarget, frac))}
                onPointerLeave={() => setShown(null)}
                onFocus={(e) => setShown(anchor(i, e.currentTarget, frac))}
                onBlur={() => setShown(null)}
              >
                <span className="relative mr-12 block h-2.5 w-full">
                  <span
                    className="absolute inset-y-0 left-0 rounded-r-[4px] bg-accent transition-opacity group-hover:opacity-85"
                    style={{ width: `${Math.max(frac * 100, 0.5)}%` }}
                  >
                    <span className="absolute top-1/2 left-full ml-1.5 -translate-y-1/2 text-[13px] whitespace-nowrap text-ink-1 tabular-nums">
                      {d.expected_wins.toFixed(2)}
                    </span>
                  </span>
                </span>
              </button>
              <span className="text-right text-[13px] text-ink-1 tabular-nums">{formatPercent(d.p_at_least_one, 1)}</span>
            </li>
          );
        })}
      </ul>
      {tip && shown != null ? (
        <ChartTooltip x={shown.x} y={shown.y} containerWidth={width}>
          <div className="mb-1 font-medium text-ink-1">{tip.driver.name}</div>
          <TipRow keyColor="var(--accent)" value={tip.expected_wins.toFixed(2)} label={`expected wins in ${outlook.races.length} races`} />
          <TipRow value={formatPercent(tip.p_at_least_one, 1)} label="chance of at least one win" />
          {best ? <TipRow value={formatProb(best.p)} label={`best chance, ${raceShort(outlook.races[best.index])}`} /> : null}
        </ChartTooltip>
      ) : null}
    </div>
  );
}

/** Table view: every driver by every remaining race. */
export function OutlookTable({ outlook }: { outlook: Outlook }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">Win probability per driver and remaining race</caption>
        <thead>
          <tr className="border-b border-hair text-xs text-ink-muted">
            <th scope="col" className="sticky left-0 bg-page py-2 pr-3 text-left font-medium">
              Driver
            </th>
            {outlook.races.map((r) => (
              <th key={r.race_id} scope="col" className="px-2 py-2 text-right font-medium whitespace-nowrap" title={raceShort(r)}>
                {`R${r.round}`}
                <span className="sr-only">{` ${r.grand_prix}`}</span>
              </th>
            ))}
            <th scope="col" className="px-2 py-2 text-right font-medium whitespace-nowrap">
              Expected wins
            </th>
            <th scope="col" className="py-2 pl-2 text-right font-medium whitespace-nowrap">
              At least one
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hair">
          {outlook.drivers.map((d) => (
            <tr key={d.driver.driver_id}>
              <th scope="row" className="sticky left-0 bg-page py-1.5 pr-3 text-left font-normal whitespace-nowrap">
                <span className="font-mono font-semibold text-ink-1">{d.driver.abbr}</span>
                <span className="ml-2 hidden text-ink-2 sm:inline">{d.driver.name}</span>
              </th>
              {d.p.map((p, i) => (
                <td key={outlook.races[i]?.race_id ?? i} className="px-2 py-1.5 text-right tabular-nums">
                  {formatProb(p)}
                </td>
              ))}
              <td className="px-2 py-1.5 text-right tabular-nums">{d.expected_wins.toFixed(2)}</td>
              <td className="py-1.5 pl-2 text-right tabular-nums">{formatPercent(d.p_at_least_one, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
