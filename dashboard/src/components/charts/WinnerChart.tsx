import { scaleLinear } from "d3-scale";
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { HistoryRace } from "../../api/types";
import { useElementWidth } from "../../hooks/useElementWidth";
import { formatLogloss, formatProb, ordinal, raceWithYear } from "../../lib/format";
import { baselineWinnerP, seasonStarts } from "../../lib/history";
import { ChartTooltip, TipRow, roundedTopRect } from "./ChartFrame";

const M = { top: 10, right: 6, bottom: 28, left: 40 };
const PLOT_H = 200;
const TICKS = [0, 0.25, 0.5, 0.75, 1];
/** Widths of the axis labels at 12px ("2026", "R22"), with a little air. */
const YEAR_W = 30;
const ROUND_W = 24;
const LABEL_GAP = 6;

/**
 * Axis labels that fit inside the chart: only the right edge pushes a label left, and a label
 * that would touch the one to its right is dropped (the latest labels win). x is the left edge.
 */
function fitAxisLabels<T>(items: { x: number; item: T }[], w: number, minX: number, maxX: number): { x: number; item: T }[] {
  const out: { x: number; item: T }[] = [];
  let limit = maxX;
  for (let k = items.length - 1; k >= 0; k--) {
    const x = Math.min(items[k].x, maxX - w);
    if (x < minX || x + w > limit) continue;
    out.push({ x, item: items[k].item });
    limit = x - LABEL_GAP;
  }
  return out.reverse();
}

/**
 * Probability the model gave the actual winner, one column per race in date order.
 * Emphasis: accent where the favourite won, de-emphasis grey otherwise; the baseline's
 * probability for the same winner is a short muted tick across each column.
 */
export function WinnerChart({
  races,
  baselineLabel,
  onOpen,
}: {
  races: HistoryRace[];
  baselineLabel: string;
  onOpen: (raceId: number) => void;
}) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const colRefs = useRef<(SVGRectElement | null)[]>([]);

  const n = races.length;
  const plotW = Math.max(0, width - M.left - M.right);
  const band = n ? plotW / n : 0;
  // A 2px surface gap between touching columns while there is room for it; dense scopes thin it.
  const gap = band >= 4 ? 2 : band >= 2.5 ? 1 : 0;
  const barW = Math.max(0.75, Math.min(24, band - gap));
  const y = useMemo(() => scaleLinear().domain([0, 1]).range([PLOT_H, 0]), []);
  const xOf = (i: number) => i * band + (band - barW) / 2;

  const seasons = useMemo(() => seasonStarts(races), [races]);
  const labelStep = useMemo(() => {
    if (seasons.length < 2 || band === 0) return 1;
    const minGap = Math.min(...seasons.slice(1).map((s, i) => (s.index - seasons[i].index) * band));
    return Math.max(1, Math.ceil((YEAR_W + 4) / Math.max(minGap, 1)));
  }, [seasons, band]);

  // One season in scope: label rounds instead of years, at least ~30px apart.
  const roundStep = band > 0 ? Math.max(1, Math.ceil(30 / band)) : 1;
  const labelMin = -M.left + 2;
  const labelMax = plotW + M.right;
  const yearLabels =
    seasons.length > 1
      ? fitAxisLabels(
          seasons.filter((_, k) => k % labelStep === 0).map((s) => ({ x: s.index * band, item: s })),
          YEAR_W,
          labelMin,
          labelMax,
        )
      : [];
  const roundLabels =
    seasons.length > 1
      ? []
      : fitAxisLabels(
          races.flatMap((r, i) => (i % roundStep === 0 ? [{ x: xOf(i) + barW / 2 - ROUND_W / 2, item: r }] : [])),
          ROUND_W,
          labelMin,
          labelMax,
        );

  const shown = focused ?? hover;
  const activeIdx = Math.min(active, Math.max(0, n - 1));

  const indexAt = (e: MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    return Math.max(0, Math.min(n - 1, Math.floor(px / band)));
  };

  const focusCol = (i: number) => {
    setActive(i);
    colRefs.current[i]?.focus();
  };

  const onKey = (e: KeyboardEvent<SVGRectElement>, i: number) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, PageDown: 10, PageUp: -10 };
    if (e.key in moves) {
      e.preventDefault();
      focusCol(Math.max(0, Math.min(n - 1, i + moves[e.key])));
    } else if (e.key === "Home") {
      e.preventDefault();
      focusCol(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusCol(n - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(races[i].race.race_id);
    }
  };

  const tip = shown != null && races[shown] ? races[shown] : null;
  const totalH = M.top + PLOT_H + M.bottom;

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height: totalH }}>
      {width > 0 && n > 0 ? (
        <svg width={width} height={totalH} className="block overflow-visible" role="group" aria-label="Probability given to each race winner">
          <g transform={`translate(${M.left},${M.top})`}>
            {TICKS.map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line x1={0} x2={plotW} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={-8} dy="0.32em" textAnchor="end" className="fill-ink-muted text-xs tabular-nums">
                  {`${Math.round(t * 100)}%`}
                </text>
              </g>
            ))}

            {shown != null ? (
              <rect x={shown * band} y={0} width={Math.max(band, 2)} height={PLOT_H} fill="var(--hair)" pointerEvents="none" />
            ) : null}

            {races.map((r, i) => {
              const p = r.winner.p;
              const top = y(p);
              const x = xOf(i);
              const bp = baselineWinnerP(r);
              const tx1 = x - (barW < 4 ? 0.5 : 1);
              const tx2 = x + barW + (barW < 4 ? 0.5 : 1);
              return (
                <g key={r.race.race_id} pointerEvents="none">
                  <path d={roundedTopRect(x, top, barW, PLOT_H - top)} fill={r.favourite_won ? "var(--accent)" : "var(--deemph)"} />
                  {/* Surface ring under the tick, so it stays visible where it crosses a column. */}
                  <line x1={tx1} x2={tx2} y1={y(bp)} y2={y(bp)} stroke="var(--surface)" strokeWidth={3.5} />
                  <line x1={tx1} x2={tx2} y1={y(bp)} y2={y(bp)} stroke="var(--ink-3)" strokeWidth={1.5} />
                </g>
              );
            })}

            {seasons.length > 1
              ? seasons.map((s) => (
                  <line
                    key={s.year}
                    x1={s.index * band}
                    x2={s.index * band}
                    y1={PLOT_H}
                    y2={PLOT_H + 5}
                    stroke="var(--axis)"
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                ))
              : null}
            {yearLabels.map(({ x, item }) => (
              <text key={item.year} x={x} y={PLOT_H + 18} className="fill-ink-muted text-xs tabular-nums">
                {item.year}
              </text>
            ))}
            {roundLabels.map(({ x, item }) => (
              <text key={item.race.race_id} x={x + ROUND_W / 2} y={PLOT_H + 18} textAnchor="middle" className="fill-ink-muted text-xs tabular-nums">
                {`R${item.race.round}`}
              </text>
            ))}

            {/* Pointer layer: the nearest column wins, so thin columns are still easy to hit. */}
            <rect
              x={0}
              y={0}
              width={plotW}
              height={PLOT_H}
              fill="transparent"
              className="cursor-pointer"
              onPointerMove={(e) => setHover(indexAt(e))}
              onPointerLeave={() => setHover(null)}
              onClick={(e) => onOpen(races[indexAt(e)].race.race_id)}
            />

            {/* Keyboard layer: one focusable column at a time (roving tabindex). */}
            {races.map((r, i) => (
              <rect
                key={r.race.race_id}
                ref={(el) => {
                  colRefs.current[i] = el;
                }}
                x={i * band}
                y={0}
                width={Math.max(band, 1)}
                height={PLOT_H}
                fill="none"
                pointerEvents="none"
                tabIndex={i === activeIdx ? 0 : -1}
                role="button"
                aria-label={`${raceWithYear(r.race)}. Winner ${r.winner.driver.name}, ${formatProb(r.winner.p)}, ranked ${ordinal(r.winner.rank)}. ${r.favourite_won ? "Favourite won" : "Favourite lost"}. Open race details.`}
                className="outline-none"
                onFocus={() => {
                  setFocused(i);
                  setActive(i);
                }}
                onBlur={() => setFocused(null)}
                onKeyDown={(e) => onKey(e, i)}
              />
            ))}
            {focused != null ? (
              <rect
                x={focused * band - 2}
                y={-2}
                width={Math.max(band, 1) + 4}
                height={PLOT_H + 4}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
                rx={2}
                pointerEvents="none"
              />
            ) : null}
          </g>
        </svg>
      ) : null}

      {tip && shown != null ? (
        <ChartTooltip x={M.left + shown * band + band / 2} y={M.top + y(tip.winner.p)} containerWidth={width}>
          <div className="mb-1 font-medium text-ink-1">{raceWithYear(tip.race)}</div>
          <TipRow
            keyColor={tip.favourite_won ? "var(--accent)" : "var(--deemph)"}
            value={formatProb(tip.winner.p)}
            label={`${tip.winner.driver.name} won, ranked ${ordinal(tip.winner.rank)}`}
          />
          {!tip.favourite_won ? <TipRow value={formatProb(tip.favourite.p)} label={`${tip.favourite.driver.name}, the favourite`} /> : null}
          <TipRow keyColor="var(--ink-3)" value={formatProb(baselineWinnerP(tip))} label={baselineLabel} />
          <div className="mt-1 text-ink-2 tabular-nums">
            Log-loss {formatLogloss(tip.logloss)} vs {formatLogloss(tip.baseline_logloss)}
          </div>
        </ChartTooltip>
      ) : null}
    </div>
  );
}
