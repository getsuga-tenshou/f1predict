import { scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import { useMemo, useState } from "react";
import type { CalibrationBin } from "../../api/types";
import { useElementWidth } from "../../hooks/useElementWidth";
import { formatPercent, formatProb } from "../../lib/format";
import { ChartTooltip, TipRow } from "./ChartFrame";

const M = { top: 12, right: 14, bottom: 40, left: 52 };
const TICKS = [0, 0.25, 0.5, 0.75, 1];

export function binRange(b: Pick<CalibrationBin, "lo" | "hi">): string {
  const f = (x: number) => `${+(x * 100).toFixed(1)}`;
  return `${f(b.lo)}-${f(b.hi)}%`;
}

/** Reliability diagram: mean predicted probability vs observed win rate per bin. */
export function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);

  const sorted = useMemo(() => [...bins].filter((b) => b.n > 0).sort((a, b) => a.mean_p - b.mean_p), [bins]);
  const size = Math.max(0, Math.min(width, 420));
  const plot = Math.max(0, size - M.left - M.right);
  const x = useMemo(() => scaleLinear().domain([0, 1]).range([0, plot]), [plot]);
  const y = useMemo(() => scaleLinear().domain([0, 1]).range([plot, 0]), [plot]);
  const path = useMemo(
    () =>
      line<CalibrationBin>()
        .x((b) => x(b.mean_p))
        .y((b) => y(b.win_rate))(sorted) ?? "",
    [sorted, x, y],
  );

  const shown = focused ?? hover;
  const tip = shown != null ? sorted[shown] : null;
  const totalH = M.top + plot + M.bottom;

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height: totalH || 300 }}>
      {plot > 0 ? (
        <svg width={size} height={totalH} className="block overflow-visible" role="group" aria-label="Calibration: predicted probability against observed win rate">
          <g transform={`translate(${M.left},${M.top})`}>
            {TICKS.map((t) => (
              <g key={`y${t}`}>
                <line x1={0} x2={plot} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} shapeRendering="crispEdges" />
                <text x={-8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-muted text-xs tabular-nums">
                  {`${t * 100}%`}
                </text>
              </g>
            ))}
            {TICKS.map((t) => (
              <g key={`x${t}`}>
                {t > 0 ? <line x1={x(t)} x2={x(t)} y1={0} y2={plot} stroke="var(--grid)" shapeRendering="crispEdges" /> : null}
                <text x={x(t)} y={plot + 18} textAnchor="middle" className="fill-ink-muted text-xs tabular-nums">
                  {`${t * 100}%`}
                </text>
              </g>
            ))}
            <line x1={0} x2={0} y1={0} y2={plot} stroke="var(--axis)" shapeRendering="crispEdges" />
            <text x={plot / 2} y={plot + 36} textAnchor="middle" className="fill-ink-muted text-xs">
              Predicted probability
            </text>
            <text transform={`translate(${-42},${plot / 2}) rotate(-90)`} textAnchor="middle" className="fill-ink-muted text-xs">
              Observed win rate
            </text>

            {/* Perfect calibration. */}
            <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--ink-3)" strokeWidth={1} />

            <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {sorted.map((b, i) => (
              <circle
                key={`${b.lo}-${b.hi}`}
                cx={x(b.mean_p)}
                cy={y(b.win_rate)}
                r={shown === i ? 5.5 : 4.5}
                fill="var(--accent)"
                stroke="var(--surface)"
                strokeWidth={2}
                pointerEvents="none"
              />
            ))}
            {sorted.map((b, i) => (
              <circle
                key={`hit-${b.lo}-${b.hi}`}
                cx={x(b.mean_p)}
                cy={y(b.win_rate)}
                r={12}
                fill="transparent"
                tabIndex={0}
                role="img"
                aria-label={`Bin ${binRange(b)}: ${b.n} rows, mean predicted ${formatProb(b.mean_p)}, observed ${formatProb(b.win_rate)}`}
                className="outline-none"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setFocused(i)}
                onBlur={() => setFocused(null)}
              />
            ))}
            {focused != null && sorted[focused] ? (
              <circle
                cx={x(sorted[focused].mean_p)}
                cy={y(sorted[focused].win_rate)}
                r={9}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
                pointerEvents="none"
              />
            ) : null}
          </g>
        </svg>
      ) : null}
      {tip && shown != null ? (
        <ChartTooltip x={M.left + x(tip.mean_p)} y={M.top + y(tip.win_rate)} containerWidth={size}>
          <div className="mb-1 font-medium text-ink-1">Predicted {binRange(tip)}</div>
          <TipRow value={formatPercent(tip.win_rate, 1)} label="observed win rate" />
          <TipRow value={formatPercent(tip.mean_p, 1)} label="mean predicted" />
          <TipRow value={tip.n.toLocaleString("en-GB")} label="driver-race rows" />
        </ChartTooltip>
      ) : null}
    </div>
  );
}

export function CalibrationTable({ bins }: { bins: CalibrationBin[] }) {
  const sorted = [...bins].sort((a, b) => a.lo - b.lo);
  return (
    <table className="w-full border-collapse text-[13px]">
      <caption className="sr-only">Calibration bins</caption>
      <thead>
        <tr className="border-b border-hair text-left text-xs text-ink-muted">
          <th scope="col" className="py-2 pr-3 font-medium">Predicted</th>
          <th scope="col" className="py-2 pr-3 text-right font-medium">Rows</th>
          <th scope="col" className="py-2 pr-3 text-right font-medium">Mean predicted</th>
          <th scope="col" className="py-2 text-right font-medium">Observed</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-hair">
        {sorted.map((b) => (
          <tr key={`${b.lo}-${b.hi}`}>
            <td className="py-1.5 pr-3 tabular-nums">{binRange(b)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{b.n.toLocaleString("en-GB")}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{formatPercent(b.mean_p, 1)}</td>
            <td className="py-1.5 text-right tabular-nums">{formatPercent(b.win_rate, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
