import { useId } from "react";
import type { ModeInfo, RaceRef, Run, RunSummary } from "../../api/types";
import { Button } from "../../components/Button";
import { Field, Select } from "../../components/controls";
import { Badge, HoverTip, InlineError, Notice, Skeleton } from "../../components/feedback";
import { ProbabilityTower } from "../../components/ProbabilityTower";
import { useNow } from "../../hooks/useNow";
import {
  describePoints,
  formatDateLong,
  formatProb,
  formatTimestamp,
  gridSourceLabel,
  horizonLabel,
  lineupChangesLabel,
  pointsDelta,
  relativeTime,
  sessionChips,
} from "../../lib/format";
import { rowDeltas } from "../../lib/forecast";
import type { Submission } from "./useRunSubmission";
import { RunProgress } from "./RunProgress";

export function RaceHeading({ race }: { race: RaceRef }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="m-0 text-[32px] leading-tight font-semibold tracking-tight text-ink-1">{`${race.grand_prix} Grand Prix`}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
        <span>{`Round ${race.round}, ${race.place}`}</span>
        <span className="text-ink-muted">{formatDateLong(race.date)}</span>
        {race.is_sprint ? <Badge>Sprint weekend</Badge> : null}
      </div>
    </div>
  );
}

function modeLabel(modes: ModeInfo[], id: string, key: "label" | "short" = "label"): string {
  return modes.find((m) => m.id === id)?.[key] ?? id;
}

function RunMeta({ run, modes, now }: { run: RunSummary; modes: ModeInfo[]; now: number }) {
  const chips = sessionChips(run.inputs.sessions_used);
  const grid = gridSourceLabel(run.inputs.grid);
  const changes = run.inputs.lineup_changes;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-2">
      <span className="font-medium text-ink-1">{modeLabel(modes, run.mode)}</span>
      <span>{horizonLabel(run.h)}</span>
      <span title={formatTimestamp(run.created_at)}>{`made ${relativeTime(run.created_at, now)}`}</span>
      <Badge>{run.source === "cli" ? "CLI" : "Dashboard"}</Badge>
      {run.label ? <Badge className="max-w-[220px] truncate">{run.label}</Badge> : null}
      {chips.map((c) => (
        <Badge key={c} className="font-mono">
          {c}
        </Badge>
      ))}
      {grid ? <Badge>{grid}</Badge> : null}
      {changes.length ? (
        <HoverTip
          triggerClassName="h-5 rounded-badge border border-hair px-1.5 text-xs font-medium text-ink-2 hover:bg-tint"
          tip={
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {changes.map((c) => (
                <li key={`${c.team}-${c.in.driver_id}`}>{c.out ? `${c.team}: ${c.in.name} in for ${c.out.name}` : `${c.team}: ${c.in.name} in`}</li>
              ))}
            </ul>
          }
        >
          {lineupChangesLabel(changes.length)}
        </HoverTip>
      ) : null}
    </div>
  );
}

/** First-load placeholder shaped like the forecast; `heading` is off when the real heading is already shown. */
export function ForecastSkeleton({ heading = true }: { heading?: boolean }) {
  return (
    <div aria-hidden className="flex flex-col gap-6">
      {heading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-72 max-w-full" />
          <Skeleton className="h-4 w-56" />
        </div>
      ) : null}
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-40" />
        <Skeleton className="h-4 w-60" />
      </div>
      <div className="flex flex-col">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="flex h-[30px] items-center gap-3 border-b border-hair">
            <Skeleton className="h-3 w-4" />
            <Skeleton className="h-3 w-9" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-2.5" style={{ width: `${Math.max(8, 70 - i * 6)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ForecastPanel({
  race,
  run,
  runError,
  runStale,
  onRetryRun,
  compare,
  compareOptions,
  compareId,
  onCompare,
  modes,
}: {
  race: RaceRef;
  run: Run | undefined;
  runError: unknown;
  runStale: boolean;
  onRetryRun: () => void;
  compare: Run | undefined;
  compareOptions: RunSummary[];
  compareId: string | null;
  onCompare: (id: string | null) => void;
  modes: ModeInfo[];
}) {
  const now = useNow();
  const selectId = useId();
  const comparing = compare && compareId === compare.id ? compare : undefined;
  const deltas = run && comparing ? rowDeltas(run.rows, comparing.rows) : null;
  const fav = run?.rows[0];
  const favPrev = fav && comparing ? comparing.rows.find((r) => r.driver.driver_id === fav.driver.driver_id) : undefined;

  const compareText = (() => {
    if (!fav || !comparing) return null;
    const what = `the ${modeLabel(modes, comparing.mode, "short").toLowerCase()} forecast`;
    const when = comparing.mode === run?.mode ? ` from ${relativeTime(comparing.created_at, now)}` : "";
    if (!favPrev) return `Not in ${what}${when}`;
    return `${describePoints(pointsDelta(fav.p, favPrev.p))} vs ${what}${when}`;
  })();

  return (
    <section aria-labelledby="forecast-title" className="flex flex-col gap-5">
      <div id="forecast-title">
        <RaceHeading race={race} />
      </div>

      {runError && !run ? <InlineError error={runError} onRetry={onRetryRun} title="Could not load this forecast" /> : null}
      {!run && !runError ? <ForecastSkeleton heading={false} /> : null}

      {run ? (
        <div className={`flex flex-col gap-5 transition-opacity duration-200 ${runStale ? "opacity-60" : ""}`} aria-busy={runStale}>
          <RunMeta run={run} modes={modes} now={now} />
          {run.warnings.length ? (
            <div className="flex flex-col gap-2">
              {run.warnings.map((w) => (
                <Notice key={w}>{w}</Notice>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            {fav ? (
              <div className="flex min-w-0 flex-col gap-1">
                <div className="text-[56px] leading-none font-semibold tracking-tight text-ink-1">{formatProb(fav.p)}</div>
                <div className="text-[15px] text-ink-1">{`${fav.driver.name} is the favourite`}</div>
                <div className="text-[13px] text-ink-muted">{fav.driver.team}</div>
                {compareText ? <div className="mt-1 text-[13px] text-ink-2">{`${compareText[0].toUpperCase()}${compareText.slice(1)}`}</div> : null}
              </div>
            ) : null}
            {compareOptions.length ? (
              <div className="w-full sm:w-72">
                <Field label="Compare with" htmlFor={selectId}>
                  <Select id={selectId} value={compareId ?? ""} onChange={(e) => onCompare(e.target.value || null)} className="w-full">
                    <option value="">None</option>
                    {compareOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {[modeLabel(modes, o.mode, "short"), relativeTime(o.created_at, now), o.label].filter(Boolean).join(", ")}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : null}
          </div>

          {run.rows.length ? (
            <ProbabilityTower rows={run.rows} deltas={deltas} />
          ) : (
            <p className="text-sm text-ink-2">This run has no rows.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function EmptyForecast({
  race,
  canRun,
  submission,
  onRun,
  onRetry,
}: {
  race: RaceRef;
  canRun: boolean;
  submission: Submission;
  onRun: () => void;
  onRetry: () => void;
}) {
  const active = submission.kind === "active";
  // A failed run for this race is shown here too, next to the button that started it.
  const failed = submission.kind === "error" && submission.request.race_id === race.race_id ? submission : null;
  return (
    <section aria-labelledby="forecast-title" className="flex flex-col gap-6">
      <div id="forecast-title">
        <RaceHeading race={race} />
      </div>
      <div className="flex max-w-xl flex-col items-start gap-3 border-t border-hair pt-6">
        <h2 className="m-0 text-lg font-semibold text-ink-1">No forecast for this race yet</h2>
        <p className="m-0 text-sm text-ink-2">
          {canRun
            ? "A pre-weekend forecast uses everything up to the previous race. Run one now, or set up a different moment in the form."
            : "No forecast was logged for this race before it was run."}
        </p>
        {canRun ? (
          <Button variant="primary" onClick={onRun} disabled={active}>
            Run a pre-weekend forecast
          </Button>
        ) : null}
        {active ? (
          <div className="w-full max-w-sm">
            <RunProgress stage={submission.stage} startedAt={submission.startedAt} />
          </div>
        ) : null}
        {failed ? (
          <div className="flex w-full max-w-sm flex-col gap-2 rounded-control border border-hair bg-tint px-3 py-2.5 text-[13px]">
            <div className="font-medium text-ink-1">The run failed</div>
            <div className="break-words text-ink-2">{failed.message}</div>
            <div>
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
