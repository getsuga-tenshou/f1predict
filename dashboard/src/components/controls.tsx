import { CaretDownIcon } from "@phosphor-icons/react";
import { useId, useRef, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes } from "react";

/** Label above, control, helper below. */
export function Field({ label, htmlFor, helper, children }: { label: ReactNode; htmlFor: string; helper?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-1">
        {label}
      </label>
      {children}
      {helper ? (
        <div id={`${htmlFor}-help`} className="text-[13px] leading-snug text-ink-muted">
          {helper}
        </div>
      ) : null}
    </div>
  );
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex min-w-0 ${className}`}>
      <select className="control-select w-full text-sm text-ink-1" {...rest}>
        {children}
      </select>
      <CaretDownIcon size={14} aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-2" />
    </span>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/**
 * Single-choice segmented control (radio group). Arrow keys move the selection. The selected
 * segment carries the accent indicator: an underline in a row, a left bar in a column.
 * layout: "row"; "column" (for narrow panels with long labels); "responsive" (column below 640px).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  size = "md",
  layout = "row",
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
  labelledBy?: string;
  size?: "sm" | "md";
  layout?: "row" | "column" | "responsive";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const enabled = options.flatMap((o, j) => (o.disabled ? [] : [j]));
    const at = enabled.indexOf(i);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = enabled[(at + 1) % enabled.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (next == null || next < 0) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  const h = size === "sm" ? "h-8 text-[13px]" : "h-9 text-sm";
  const group = {
    row: "inline-flex flex-row",
    column: "flex w-full flex-col",
    responsive: "flex w-full flex-col sm:inline-flex sm:w-auto sm:flex-row",
  }[layout];
  const item = {
    row: "justify-center",
    column: "justify-start pl-3.5",
    responsive: "justify-start pl-3.5 sm:justify-center sm:pl-2.5",
  }[layout];
  // Underline in a row, left bar in a column.
  const indicator = {
    row: "inset-x-2 bottom-0.5 h-0.5",
    column: "inset-y-1.5 left-1 w-0.5",
    responsive: "inset-y-1.5 left-1 w-0.5 sm:inset-y-auto sm:inset-x-2 sm:bottom-0.5 sm:left-2 sm:h-0.5 sm:w-auto",
  }[layout];
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`${group} min-w-0 max-w-full items-stretch rounded-control border border-ink-3 bg-surface p-0.5`}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={o.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={`relative flex min-w-0 flex-auto items-center truncate rounded-badge px-2.5 whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${h} ${item} ${
              selected ? "bg-tint font-medium text-ink-1" : "text-ink-2 enabled:hover:text-ink-1"
            }`}
          >
            {o.label}
            <span
              aria-hidden
              className={`absolute rounded-full bg-accent transition-opacity duration-150 ${indicator} ${selected ? "opacity-100" : "opacity-0"}`}
            />
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-45 ${
          checked ? "border-ink-1 bg-ink-1" : "border-ink-3 bg-surface"
        }`}
      >
        <span
          aria-hidden
          className={`inline-block size-3.5 rounded-full transition-transform duration-150 ${
            checked ? "translate-x-[18px] bg-surface" : "translate-x-[2px] bg-ink-3"
          }`}
        />
      </button>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-[13px] font-medium text-ink-1">
          {label}
        </label>
        {description ? <div className="text-[13px] leading-snug text-ink-muted">{description}</div> : null}
      </div>
    </div>
  );
}
