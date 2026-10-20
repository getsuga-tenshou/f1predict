import { CaretDownIcon, CaretRightIcon, CaretUpIcon } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Fragment, useState } from "react";
import type { FeatureContribution, RunRow } from "../api/types";
import { formatProb, formatSigned } from "../lib/format";
import { maxAbsContribution, type RowDelta } from "../lib/forecast";

const SPRING = { type: "spring", stiffness: 120, damping: 22 } as const;

/**
 * The forecast as a semantic table (it is its own table view): one row per driver, a single
 * accent bar scaled to the favourite, the value at the bar tip. Rows with a "why" expand to
 * show the three largest log-odds contributions.
 */
export function ProbabilityTower({ rows, deltas }: { rows: RunRow[]; deltas: Map<string, RowDelta> | null }) {
  const reduce = useReducedMotion() ?? false;
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const maxP = Math.max(...rows.map((r) => r.p), 0);
  const whyScale = maxAbsContribution(rows);
  const cols = deltas ? 5 : 4;

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <table className="w-full table-fixed border-collapse">
      <caption className="sr-only">Win probability for every driver, favourite first</caption>
      <thead>
        <tr className="border-b border-hair text-left text-xs text-ink-muted">
          <th scope="col" className="w-8 py-2 font-medium">
            <span className="sr-only">Rank</span>
            <span aria-hidden>#</span>
          </th>
          {/* Phones show the three-letter code only, like a timing tower; the team column steps aside
              between lg and xl, where the run form takes 420px of the width. */}
          <th scope="col" className="w-[72px] py-2 font-medium sm:w-[30%] lg:w-[40%] xl:w-[30%]">
            Driver
          </th>
          <th scope="col" className="hidden w-[20%] py-2 font-medium sm:table-cell lg:hidden xl:table-cell">
            Team
          </th>
          <th scope="col" className="py-2 font-medium">
            Win probability
          </th>
          {deltas ? (
            <th scope="col" className="w-[68px] py-2 text-right font-medium">
              Change
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const id = r.driver.driver_id;
          const expandable = r.why.length > 0;
          const isOpen = expandable && open.has(id);
          const frac = maxP > 0 ? r.p / maxP : 0;
          const panelId = `why-${id}`;
          return (
            <Fragment key={id}>
              <motion.tr
                layout={reduce ? false : "position"}
                transition={SPRING}
                onClick={expandable ? () => toggle(id) : undefined}
                className={`h-[30px] border-b border-hair transition-colors hover:bg-tint hover:tint-lift ${expandable ? "cursor-pointer" : ""} ${isOpen ? "bg-tint tint-lift" : ""}`}
              >
                <td className="py-0 text-[13px] text-ink-muted tabular-nums">{r.rank}</td>
                <td className="py-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-9 shrink-0 font-mono text-[13px] font-semibold text-ink-1">{r.driver.abbr}</span>
                    {expandable ? (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={panelId}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(id);
                        }}
                        className="flex min-w-0 items-center gap-1 rounded-badge text-left text-[13px] text-ink-1"
                      >
                        <span className="sr-only sm:not-sr-only sm:truncate">{r.driver.name}</span>
                        <CaretRightIcon
                          size={12}
                          aria-hidden
                          className={`shrink-0 text-ink-2 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
                        />
                        <span className="sr-only">, show why</span>
                      </button>
                    ) : (
                      <span className="sr-only text-[13px] text-ink-1 sm:not-sr-only sm:truncate">{r.driver.name}</span>
                    )}
                  </div>
                </td>
                <td className="hidden truncate py-0 pr-3 text-[13px] text-ink-muted sm:table-cell lg:hidden xl:table-cell">{r.driver.team}</td>
                <td className="py-0">
                  <div className="relative mr-14 h-[11px]">
                    <motion.div
                      className="absolute inset-y-0 left-0 rounded-r-[4px] bg-accent"
                      initial={false}
                      animate={{ width: `${Math.max(frac * 100, 0.4)}%` }}
                      transition={reduce ? { duration: 0 } : SPRING}
                    >
                      <span className="absolute top-1/2 left-full ml-1.5 -translate-y-1/2 text-[13px] whitespace-nowrap text-ink-1 tabular-nums">
                        {formatProb(r.p)}
                      </span>
                    </motion.div>
                  </div>
                </td>
                {deltas ? (
                  <td className="py-0 text-right text-[13px] text-ink-1 tabular-nums">
                    <DeltaCell delta={deltas.get(id)} />
                  </td>
                ) : null}
              </motion.tr>
              {isOpen ? (
                <tr id={panelId} className="border-b border-hair bg-tint tint-lift">
                  <td />
                  <td colSpan={cols - 1} className="pt-1 pb-3 pr-2">
                    <WhyBars why={r.why} scale={whyScale} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function DeltaCell({ delta }: { delta: RowDelta | undefined }) {
  if (!delta) return null;
  if (delta.kind === "new") return <span className="text-ink-2">new</span>;
  const v = delta.value;
  const text = Math.abs(v) < 0.05 ? "0.0" : formatSigned(v, 1);
  return (
    <span className="inline-flex items-center justify-end gap-0.5">
      {v >= 0.05 ? <CaretUpIcon size={12} aria-hidden className="text-ink-2" /> : null}
      {v <= -0.05 ? <CaretDownIcon size={12} aria-hidden className="text-ink-2" /> : null}
      {text}
      <span className="sr-only"> points</span>
    </span>
  );
}

/** Three contributions as diverging bars around zero: helps (blue, right), hurts (red, left). */
export function WhyBars({ why, scale }: { why: FeatureContribution[]; scale: number }) {
  const s = scale > 0 ? scale : 1;
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {why.map((c) => {
          const half = Math.min(Math.abs(c.value) / s, 1) * 50;
          const positive = c.value >= 0;
          return (
            <li key={c.feature} className="grid grid-cols-[minmax(0,1fr)_minmax(90px,38%)_48px] items-center gap-3 text-[13px]">
              <span className="truncate text-ink-2" title={c.label}>
                {c.label}
              </span>
              <span className="relative block h-4" aria-hidden>
                <span className="absolute inset-y-0 left-1/2 w-px bg-axis" />
                <span
                  className={`absolute top-1/2 h-2 -translate-y-1/2 ${positive ? "left-1/2 rounded-r-[4px] bg-pos" : "right-1/2 rounded-l-[4px] bg-neg"}`}
                  style={{ width: `${half}%` }}
                />
              </span>
              <span className="text-right text-ink-1 tabular-nums">{formatSigned(c.value, 2)}</span>
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-xs text-ink-muted">Log-odds contribution relative to the field average.</p>
    </div>
  );
}
