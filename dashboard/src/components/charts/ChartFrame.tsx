import { ChartBarIcon, TableIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../Button";

/** Toggle between a chart and its table twin. Pressed = table showing. */
export function TableToggle({ pressed, onChange, controls }: { pressed: boolean; onChange: (v: boolean) => void; controls?: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={pressed}
      aria-controls={controls}
      onClick={() => onChange(!pressed)}
      icon={pressed ? <ChartBarIcon size={16} aria-hidden /> : <TableIcon size={16} aria-hidden />}
    >
      {pressed ? "Chart" : "Table"}
    </Button>
  );
}

/**
 * Chart container: title, optional legend, chart or its table view, caption. The chart's own
 * height includes its x-axis band, so the frame never scrolls.
 */
export function ChartFrame({
  id,
  title,
  level = 3,
  subtitle,
  legend,
  table,
  actions,
  caption,
  children,
}: {
  id: string;
  title: ReactNode;
  /** Heading level of the title, so the outline never skips a level. */
  level?: 2 | 3;
  subtitle?: ReactNode;
  legend?: ReactNode;
  table?: ReactNode;
  actions?: ReactNode;
  caption?: ReactNode;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const bodyId = `${id}-body`;
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-3" aria-labelledby={`${id}-title`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Heading id={`${id}-title`} className="m-0 text-[15px] leading-snug font-semibold text-ink-1">
            {title}
          </Heading>
          {subtitle ? <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">{subtitle}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {table ? <TableToggle pressed={showTable} onChange={setShowTable} controls={bodyId} /> : null}
        </div>
      </div>
      {legend && !showTable ? legend : null}
      <div id={bodyId} className="min-w-0">
        {showTable && table ? table : children}
      </div>
      {caption ? <figcaption className="text-[13px] leading-snug text-ink-muted">{caption}</figcaption> : null}
    </figure>
  );
}

export interface LegendItem {
  label: string;
  /** CSS colour (a token var). */
  color: string;
  shape: "rect" | "line";
}

/** Legend mirrors the marks: rect swatch for bars, short line for ticks/lines. Text stays ink. */
export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-x-5 gap-y-1.5 p-0 text-[13px] text-ink-2">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-2">
          {it.shape === "rect" ? (
            <span aria-hidden className="inline-block h-3 w-2.5 rounded-t-[2px]" style={{ background: it.color }} />
          ) : (
            <span aria-hidden className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: it.color }} />
          )}
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Floating readout inside a chart (the parent must be position: relative). Anchored above
 * (x, y) and clamped to the container width.
 */
export function ChartTooltip({ x, y, containerWidth, children }: { x: number; y: number; containerWidth: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  }, [children]);
  const left = Math.max(0, Math.min(x - w / 2, containerWidth - w));
  const flip = y < 90;
  return (
    <div
      ref={ref}
      role="presentation"
      className="pointer-events-none absolute z-[var(--z-tooltip)] w-max max-w-[260px] rounded-panel border border-hair bg-surface px-3 py-2 text-[13px] leading-snug text-ink-1 shadow-float"
      style={{ left, top: flip ? y + 14 : y - 10, transform: flip ? undefined : "translateY(-100%)", visibility: w ? "visible" : "hidden" }}
    >
      {children}
    </div>
  );
}

/** One tooltip line: value first (strong), label after; optional short line-key in a mark colour. */
export function TipRow({ value, label, keyColor }: { value: ReactNode; label: ReactNode; keyColor?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      {keyColor ? <span aria-hidden className="inline-block h-0.5 w-3 shrink-0 translate-y-[-3px] rounded-full" style={{ background: keyColor }} /> : null}
      <span className="font-semibold tabular-nums text-ink-1">{value}</span>
      <span className="text-ink-2">{label}</span>
    </div>
  );
}

/** Path for a column/bar with a rounded data end (4px) and a square baseline end. */
export function roundedTopRect(x: number, y: number, w: number, h: number, r = 4): string {
  if (w <= 0 || h <= 0) return "";
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
