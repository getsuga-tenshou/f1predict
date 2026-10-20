import { useId, useMemo, useRef, type ReactNode } from "react";
import type { History, Metrics, Mode, Status } from "../../api/types";
import { useApi } from "../../api/useApi";
import { Button } from "../../components/Button";
import { CalibrationChart, CalibrationTable } from "../../components/charts/CalibrationChart";
import { ChartFrame, Legend } from "../../components/charts/ChartFrame";
import { WinnerChart } from "../../components/charts/WinnerChart";
import { Segmented, Select } from "../../components/controls";
import { InlineError, Skeleton } from "../../components/feedback";
import { navigate } from "../../hooks/useRoute";
import { formatLogloss, formatPercent, formatSigned } from "../../lib/format";
import { computeKpis, filterRaces, isSplitScope, scopeOptions, type Kpis, type Scope } from "../../lib/history";
import { routeHref } from "../../lib/route";
import { LoggedForecasts } from "./LoggedForecasts";
import { RaceDrawer } from "./RaceDrawer";
import { RaceTable } from "./RaceTable";

function StatTile({ label, value, detail, note }: { label: string; value: string; detail?: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-1 md:border-l md:border-hair md:pl-5 md:first:border-l-0 md:first:pl-0">
      <span className="text-[13px] text-ink-2">{label}</span>
      <span className="text-[28px] leading-tight font-semibold tracking-tight text-ink-1">{value}</span>
      {detail ? <span className="text-[13px] text-ink-2">{detail}</span> : null}
      {note ? <span className="text-xs leading-snug text-ink-muted">{note}</span> : null}
    </div>
  );
}

function KpiRow({ kpis, baselineLabel, ci }: { kpis: Kpis; baselineLabel: string; ci: Metrics["modes"][Mode]["splits"]["test"]["vs_baseline"] | null }) {
  const better = kpis.diff < 0;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
      <StatTile label="Races" value={String(kpis.races)} />
      <StatTile label="Favourite won" value={formatPercent(kpis.favouriteWonRate)} detail={`${kpis.favouriteWon} of ${kpis.races}`} />
      <StatTile label="Winner in the top 3" value={formatPercent(kpis.top3Rate)} detail={`${kpis.top3} of ${kpis.races}`} />
      <StatTile
        label="Mean log-loss (model)"
        value={formatLogloss(kpis.meanLogloss)}
        detail={
          <>
            {`vs ${formatLogloss(kpis.meanBaselineLogloss)} for ${baselineLabel}, `}
            <span className={better ? "font-medium text-success" : "text-ink-1"}>{formatSigned(kpis.diff, 3)}</span>
          </>
        }
        note={ci ? `Paired difference ${formatSigned(ci.diff)} (95% CI ${formatSigned(ci.ci_low)} to ${formatSigned(ci.ci_high)})` : undefined}
      />
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-8 w-20" />
          </div>
        ))}
      </div>
      <Skeleton className="h-[238px] w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function HistoryView({
  status,
  raceId,
  routeMode,
  routeScope,
}: {
  status: Status;
  raceId: number | null;
  routeMode: Mode | null;
  routeScope: string | null;
}) {
  const mode: Mode = routeMode ?? "pre_race";
  const historyApi = useApi<History>(`/api/history?mode=${mode}`);
  const metricsApi = useApi<Metrics>("/api/metrics");
  const history = historyApi.data;
  const tableRef = useRef<HTMLDivElement>(null);
  const scopeSelectId = useId();
  const momentLabelId = useId();

  const options = useMemo(() => (history ? scopeOptions(history) : []), [history]);
  const scope: Scope = routeScope && (options.length === 0 || options.some((o) => o.value === routeScope)) ? routeScope : "all";
  const races = useMemo(() => (history ? filterRaces(history.races, scope) : []), [history, scope]);
  const kpis = useMemo(() => computeKpis(races), [races]);
  const ci = isSplitScope(scope) ? (metricsApi.data?.modes[mode]?.splits[scope]?.vs_baseline ?? null) : null;
  const temperature = isSplitScope(scope) ? (metricsApi.data?.modes[mode]?.splits[scope]?.temperature ?? null) : null;
  const bins = history?.calibration[scope] ?? [];
  const baselineLabel = history?.baseline.label ?? "Baseline";

  const go = (next: { mode?: Mode; scope?: Scope; raceId?: number | null }, replace = false) =>
    navigate(
      {
        view: "history",
        raceId: next.raceId !== undefined ? next.raceId : raceId,
        mode: next.mode ?? mode,
        scope: next.scope ?? scope,
      },
      { replace },
    );
  const hrefFor = (id: number) => routeHref({ view: "history", raceId: id, mode, scope });
  const open = (id: number) => go({ raceId: id });

  const splitOptions = options.filter((o) => o.group === "splits");
  const seasonOptions = options.filter((o) => o.group === "seasons");

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-[32px] leading-tight font-semibold tracking-tight text-ink-1">Predictions vs winners</h1>
        <p className="m-0 max-w-[75ch] text-sm text-ink-2">
          {`${status.model.name}, trained on races from ${status.model.train_from}. Every race below was forecast before it happened and scored against the actual winner.`}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-2">
            <span id={momentLabelId} className="text-[13px] font-medium text-ink-1">
              Moment
            </span>
            <Segmented
              labelledBy={momentLabelId}
              options={status.modes.map((m) => ({ value: m.id, label: m.label }))}
              value={mode}
              onChange={(m) => go({ mode: m }, true)}
              layout="responsive"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor={scopeSelectId} className="text-[13px] font-medium text-ink-1">
              Scope
            </label>
            <Select id={scopeSelectId} value={scope} onChange={(e) => go({ scope: e.target.value }, true)} className="w-64 max-w-full" disabled={!history}>
              {options.length === 0 ? <option value="all">All seasons</option> : null}
              {splitOptions.length ? (
                <optgroup label="Splits">
                  {splitOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {seasonOptions.length ? (
                <optgroup label="Seasons">
                  {seasonOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
          </div>
        </div>
        <p className="m-0 max-w-[90ch] text-[13px] leading-snug text-ink-muted">
          Every forecast here was made walk-forward: the model was refit before each race using only earlier races. Validation seasons were used to choose the
          model; test seasons were scored once after it was frozen.
        </p>
      </div>

      {historyApi.error && !history ? <InlineError error={historyApi.error} onRetry={historyApi.refetch} title="Could not load the backtest" /> : null}
      {historyApi.isFirstLoad ? <HistorySkeleton /> : null}

      {history ? (
        <div className={`flex flex-col gap-12 transition-opacity duration-200 ${historyApi.isStale ? "opacity-60" : ""}`} aria-busy={historyApi.isStale}>
          {kpis ? <KpiRow kpis={kpis} baselineLabel={baselineLabel} ci={ci} /> : <p className="m-0 text-sm text-ink-2">No races in this scope. Pick another scope.</p>}

          {races.length ? (
            <ChartFrame
              id="winner-chart"
              level={2}
              title="Probability given to the actual winner, race by race"
              subtitle="Each column is one race. The tick shows what the simple baseline gave the same winner."
              legend={
                <Legend
                  items={[
                    { label: "Favourite won", color: "var(--accent)", shape: "rect" },
                    { label: "Favourite lost", color: "var(--deemph)", shape: "rect" },
                    { label: baselineLabel, color: "var(--ink-3)", shape: "line" },
                  ]}
                />
              }
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const el = tableRef.current;
                    if (!el) return;
                    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
                    el.focus({ preventScroll: true });
                  }}
                >
                  Table
                </Button>
              }
            >
              <WinnerChart races={races} baselineLabel={baselineLabel} onOpen={open} />
            </ChartFrame>
          ) : null}

          {races.length ? (
            <div className="grid grid-cols-1 gap-x-12 gap-y-6 lg:grid-cols-2">
              <ChartFrame id="calibration" level={2} title="Calibration" subtitle="Predicted win probability against how often those drivers won." table={bins.length ? <CalibrationTable bins={bins} /> : undefined}>
                {bins.length ? <CalibrationChart bins={bins} /> : <p className="m-0 text-sm text-ink-2">No calibration bins for this scope.</p>}
              </ChartFrame>
              <div className="flex max-w-[60ch] flex-col gap-3 text-sm text-ink-2 lg:pt-12">
                <p className="m-0">
                  Each point groups driver-race forecasts by predicted probability. On the diagonal, drivers given 20% won about 20% of the time. Points below it mean
                  the model was too confident in that range; points above it, not confident enough.
                </p>
                {temperature ? (
                  <p className="m-0">
                    {`Max-likelihood winner temperature ${temperature.T.toFixed(2)} (95% CI ${temperature.T_lo.toFixed(2)} to ${temperature.T_hi.toFixed(2)}). A value of 1 means calibrated; below 1 the model was under-confident, above 1 over-confident.`}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {races.length ? <RaceTable ref={tableRef} races={races} hrefFor={hrefFor} onOpen={open} /> : null}
        </div>
      ) : null}

      <LoggedForecasts modes={status.modes} />

      {raceId != null ? (
        <RaceDrawer key={raceId} raceId={raceId} defaultMode={mode} modes={status.modes} metrics={metricsApi.data} onClose={() => go({ raceId: null })} />
      ) : null}
    </div>
  );
}
