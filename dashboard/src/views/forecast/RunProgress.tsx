import { useNow } from "../../hooks/useNow";

/** Current stage, elapsed seconds and a thin indeterminate bar (static under reduced motion). */
export function RunProgress({ stage, startedAt }: { stage: string | null; startedAt: number }) {
  const now = useNow(1000);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        {/* Only the stage is announced; the seconds counter would be read out every second. */}
        <span role="status" className="min-w-0 leading-snug text-ink-1">
          {stage ?? "Queued"}
        </span>
        <span className="shrink-0 text-ink-muted tabular-nums">{`${secs} s`}</span>
      </div>
      <div aria-hidden className="relative h-0.5 overflow-hidden rounded-full bg-hair">
        <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-ink-2 motion-safe:animate-indeterminate" />
      </div>
    </div>
  );
}
