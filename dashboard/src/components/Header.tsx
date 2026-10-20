import { CheckIcon, CopyIcon, DownloadSimpleIcon, MonitorIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import type { Status } from "../api/types";
import { applyThemePref, readThemePref, writeThemePref, type ThemePref } from "../lib/theme";
import { Button } from "./Button";
import { Skeleton } from "./feedback";

type View = "forecast" | "history";

export function Header({ status, view }: { status: Status | undefined; view: View }) {
  return (
    <header className="border-b border-hair bg-page">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 pb-2 sm:px-6 lg:h-[60px] lg:flex-nowrap lg:gap-x-8 lg:py-0 xl:px-8">
        <a href="#/forecast" className="order-1 flex shrink-0 items-baseline gap-2 rounded-badge">
          <span className="font-mono text-[15px] font-semibold tracking-tight text-ink-1">f1predict</span>
          <span className="hidden text-[13px] text-ink-muted sm:inline">race-winner model</span>
        </a>
        <nav aria-label="Views" className="order-3 flex h-10 w-full items-stretch gap-5 lg:order-2 lg:h-full lg:w-auto">
          <Tab href="#/forecast" current={view === "forecast"}>
            Forecast
          </Tab>
          <Tab href="#/history" current={view === "history"}>
            History
          </Tab>
        </nav>
        <div className="order-4 flex w-full min-w-0 items-center gap-2 pb-1 lg:order-3 lg:ml-auto lg:w-auto lg:gap-3 lg:pb-0">
          <DataChip status={status} />
          {status?.latest_release.newer ? <UpdatePopover status={status} /> : null}
        </div>
        <div className="order-2 ml-auto lg:order-4 lg:ml-0">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function Tab({ href, current, children }: { href: string; current: boolean; children: string }) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={`relative flex items-center text-sm font-medium transition-colors ${current ? "text-ink-1" : "text-ink-2 hover:text-ink-1"}`}
    >
      {children}
      <span aria-hidden className={`absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-accent ${current ? "opacity-100" : "opacity-0"}`} />
    </a>
  );
}

function DataChip({ status }: { status: Status | undefined }) {
  if (!status) return <Skeleton className="h-6 w-64 max-w-full" />;
  const last = status.last_race;
  return (
    <span
      className="inline-block h-7 min-w-0 truncate rounded-control border border-hair px-2.5 font-mono text-xs leading-[26px] text-ink-2"
      title={`Model data: F1DB ${status.data_version}`}
    >
      {`F1DB ${status.data_version}, data through R${last.round} ${last.grand_prix}`}
    </span>
  );
}

function UpdatePopover({ status }: { status: Status }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const reduce = useReducedMotion() ?? false;
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const command = status.latest_release.update_command ?? "";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div ref={wrap} className="relative">
      <Button
        ref={trigger}
        size="sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((o) => !o);
          setCopied("idle");
        }}
        icon={<DownloadSimpleIcon size={14} aria-hidden />}
      >
        New data available
      </Button>
      <AnimatePresence>
        {open ? (
          <motion.div
            id={id}
            role="dialog"
            aria-label="Update the data"
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full right-0 z-[var(--z-popover)] mt-2 w-[min(360px,calc(100vw-2rem))] rounded-panel border border-hair bg-surface p-4 shadow-float"
          >
            <p className="m-0 text-[13px] text-ink-1">
              {status.latest_release.tag ? `F1DB ${status.latest_release.tag} is out. ` : null}
              {command ? "Run this in the project folder:" : "Update the data in the project folder."}
            </p>
            {command ? (
              <>
                <pre className="mt-2 mb-0 overflow-x-auto rounded-control border border-hair bg-page px-3 py-2 font-mono text-xs leading-relaxed text-ink-1">
                  <code>{command}</code>
                </pre>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-[13px] text-ink-muted" aria-live="polite">
                    {copied === "done"
                      ? "Copied. Then restart the dashboard."
                      : copied === "failed"
                        ? "Copy failed. Select the command instead."
                        : "Then restart the dashboard."}
                  </span>
                  <Button
                    size="sm"
                    onClick={copy}
                    icon={copied === "done" ? <CheckIcon size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
                  >
                    Copy
                  </Button>
                </div>
              </>
            ) : (
              <p className="mt-2 mb-0 text-[13px] text-ink-muted">Then restart the dashboard.</p>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const THEMES: { value: ThemePref; label: string; Icon: typeof SunIcon }[] = [
  { value: "system", label: "Use system theme", Icon: MonitorIcon },
  { value: "light", label: "Use light theme", Icon: SunIcon },
  { value: "dark", label: "Use dark theme", Icon: MoonIcon },
];

function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(() => readThemePref());
  const choose = (p: ThemePref) => {
    setPref(p);
    writeThemePref(p);
    applyThemePref(p);
  };
  return (
    <div role="group" aria-label="Theme" className="flex shrink-0 items-center rounded-control border border-hair p-0.5">
      {THEMES.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={pref === value}
          title={label}
          onClick={() => choose(value)}
          className={`relative inline-flex size-7 items-center justify-center rounded-badge transition-colors ${
            pref === value ? "bg-tint text-ink-1" : "text-ink-2 hover:text-ink-1"
          }`}
        >
          <Icon size={16} aria-hidden />
          {/* The tint alone is too faint to mark the choice; the accent underline matches tabs and segments. */}
          <span
            aria-hidden
            className={`absolute inset-x-1.5 bottom-0.5 h-0.5 rounded-full bg-accent transition-opacity duration-150 ${pref === value ? "opacity-100" : "opacity-0"}`}
          />
        </button>
      ))}
    </div>
  );
}
