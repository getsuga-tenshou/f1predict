import { ArrowClockwiseIcon, WarningIcon } from "@phosphor-icons/react";
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { errorMessage } from "../api/client";
import { Button } from "./Button";

/** Small text badge: 4px radius, hairline border, ink text. */
export function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center rounded-badge border border-hair px-1.5 text-xs leading-none font-medium whitespace-nowrap text-ink-2 ${className}`}
    >
      {children}
    </span>
  );
}

/** Inline notice: warning icon + ink text on a subtle tint. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-control border border-hair bg-tint px-3 py-2 text-[13px] leading-snug text-ink-1">
      <WarningIcon size={16} aria-hidden className="mt-px shrink-0 text-ink-2" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Contextual error with a retry. */
export function InlineError({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-control border border-hair bg-tint px-3 py-2.5 text-[13px]">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <WarningIcon size={16} aria-hidden className="mt-px shrink-0 text-critical" />
        <div className="min-w-0">
          <div className="font-medium text-ink-1">{title ?? "Could not load this"}</div>
          <div className="break-words text-ink-2">{errorMessage(error)}</div>
        </div>
      </div>
      {onRetry ? (
        <Button size="sm" onClick={onRetry} icon={<ArrowClockwiseIcon size={14} aria-hidden />}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Skeleton block; pulses only when motion is allowed. */
export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden style={style} className={`rounded-badge bg-hair motion-safe:animate-pulse ${className}`} />;
}

/**
 * A focusable trigger with a hover / focus tooltip. The tip stays in the DOM (hidden when idle)
 * so the trigger can reference it with aria-describedby. Content is React text, never HTML.
 */
export function HoverTip({
  tip,
  children,
  className = "",
  triggerClassName = "",
  align = "start",
}: {
  tip: ReactNode;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`relative inline-flex ${className}`}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-describedby={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className={`inline-flex items-center ${triggerClassName}`}
      >
        {children}
      </button>
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        className={`absolute top-full z-[var(--z-tooltip)] mt-1.5 w-max max-w-[min(280px,calc(100vw-2rem))] rounded-panel border border-hair bg-surface px-3 py-2 text-[13px] leading-snug font-normal text-ink-1 shadow-float ${
          align === "end" ? "right-0" : "left-0"
        }`}
      >
        {tip}
      </span>
    </span>
  );
}
