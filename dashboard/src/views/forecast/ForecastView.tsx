import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Calendar, RaceRef, Run, RunList, Status } from "../../api/types";
import { refetchWhere, useApi } from "../../api/useApi";
import { InlineError } from "../../components/feedback";
import { navigate } from "../../hooks/useRoute";
import { useStickyTop } from "../../hooks/useStickyTop";
import { compareCandidates, isActiveStatus, pickDisplayedRun } from "../../lib/forecast";
import { EmptyForecast, ForecastPanel, ForecastSkeleton } from "./ForecastPanel";
import { RunForm } from "./RunForm";
import { RunLog } from "./RunLog";
import { SeasonOutlook } from "./SeasonOutlook";
import { useRunSubmission } from "./useRunSubmission";

const LIST_POLL_MS = 2000;

export function ForecastView({ status, routeRaceId }: { status: Status; routeRaceId: number | null }) {
  const runsApi = useApi<RunList>("/api/runs");
  const calendarApi = useApi<Calendar>(`/api/calendar?season=${status.season}`);
  const [chosenRunId, setChosenRunId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [formRef, stickyTop] = useStickyTop<HTMLDivElement>(24);

  const raceId = routeRaceId ?? status.next_race?.race_id ?? null;
  const runs = useMemo(() => runsApi.data?.runs ?? [], [runsApi.data]);
  const displayed = raceId != null ? pickDisplayedRun(runs, raceId, chosenRunId) : null;
  const runApi = useApi<Run>(displayed ? `/api/runs/${displayed.id}` : null);
  const candidates = raceId != null ? compareCandidates(runs, raceId, displayed?.id ?? null) : [];
  const activeCompare = compareId && candidates.some((c) => c.id === compareId) ? compareId : null;
  const compareApi = useApi<Run>(activeCompare ? `/api/runs/${activeCompare}` : null);

  const upcoming = useMemo(() => (calendarApi.data?.races ?? []).filter((r) => r.status === "upcoming"), [calendarApi.data]);
  const race: RaceRef | null =
    calendarApi.data?.races.find((r) => r.race_id === raceId) ??
    (displayed?.race.race_id === raceId ? displayed.race : null) ??
    (status.next_race?.race_id === raceId ? status.next_race : null);
  const raceIsUpcoming = upcoming.some((r) => r.race_id === raceId);
  const formRaceId = raceIsUpcoming ? raceId : (status.next_race?.race_id ?? upcoming[0]?.race_id ?? null);

  // Remember what was displayed, so a finished run can be compared with it.
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;

  const onDone = useCallback((run: Run) => {
    const prev = displayedRef.current;
    setCompareId(prev && prev.race.race_id === run.race.race_id && prev.id !== run.id ? prev.id : null);
    setChosenRunId(run.id);
    navigate({ view: "forecast", raceId: run.race.race_id });
  }, []);
  const submission = useRunSubmission(onDone);

  // A run started elsewhere (CLI, another tab) is still going: refresh the list until it settles.
  // Re-arm after every settled fetch, failed ones included (a failure keeps the same data object).
  const listHasActive = runs.some((r) => isActiveStatus(r.status));
  useEffect(() => {
    if (!listHasActive || submission.state.kind === "active" || runsApi.isLoading) return;
    const id = window.setTimeout(() => refetchWhere((u) => u === "/api/runs"), LIST_POLL_MS);
    return () => window.clearTimeout(id);
  }, [listHasActive, runsApi.data, runsApi.error, runsApi.isLoading, submission.state.kind]);

  const forecastOrder = useMemo(
    () => (runApi.data && runApi.data.race.race_id === formRaceId ? runApi.data.rows.map((r) => r.driver.driver_id) : []),
    [runApi.data, formRaceId],
  );

  const runPreWeekend = () => {
    if (raceId != null) submission.submit({ race_id: raceId, mode: "pre_weekend", live: false });
  };

  let main;
  if (runsApi.isFirstLoad || (calendarApi.isFirstLoad && !race)) {
    main = <ForecastSkeleton />;
  } else if (raceId == null) {
    main = <p className="text-sm text-ink-2">There is no upcoming race in the data. Update the F1DB release to forecast the next season.</p>;
  } else if (!race) {
    main = calendarApi.error ? (
      <InlineError error={calendarApi.error} onRetry={calendarApi.refetch} title="Could not load the calendar" />
    ) : (
      <p className="text-sm text-ink-2">This race is not in the current season's calendar.</p>
    );
  } else if (runsApi.error && !runsApi.data) {
    main = <InlineError error={runsApi.error} onRetry={runsApi.refetch} title="Could not load forecasts" />;
  } else if (!displayed) {
    main = (
      <EmptyForecast
        race={race}
        canRun={raceIsUpcoming}
        submission={submission.state}
        onRun={runPreWeekend}
        onRetry={() => {
          if (submission.state.kind === "error") submission.submit(submission.state.request);
        }}
      />
    );
  } else {
    main = (
      <ForecastPanel
        race={race}
        run={runApi.data}
        runError={runApi.error}
        runStale={runApi.isStale}
        onRetryRun={runApi.refetch}
        compare={compareApi.data}
        compareOptions={candidates}
        compareId={activeCompare}
        onCompare={setCompareId}
        modes={status.modes}
      />
    );
  }

  return (
    <div className="flex flex-col gap-12 lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-[auto_auto_1fr] lg:gap-x-10 lg:gap-y-14">
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">{main}</div>

      <div className="min-w-0 lg:col-start-2 lg:row-span-3 lg:row-start-1">
        <div ref={formRef} className="lg:sticky" style={{ top: stickyTop }}>
          <RunForm
            key={formRaceId ?? "none"}
            raceId={formRaceId}
            upcoming={upcoming}
            calendarLoading={calendarApi.isFirstLoad}
            onRaceChange={(id) => navigate({ view: "forecast", raceId: id })}
            modes={status.modes}
            forecastOrder={forecastOrder}
            submission={submission.state}
            onSubmit={submission.submit}
            onDismissError={submission.dismiss}
          />
        </div>
      </div>

      <div className="min-w-0 lg:col-start-1 lg:row-start-2">
        <RunLog
          runs={runsApi.data?.runs}
          error={runsApi.error}
          isFirstLoad={runsApi.isFirstLoad}
          isStale={runsApi.isStale && submission.state.kind !== "active" && !listHasActive}
          onRetry={runsApi.refetch}
          modes={status.modes}
          displayedId={displayed?.id ?? null}
          onPick={(r) => {
            setChosenRunId(r.id);
            if (r.race.race_id !== raceId) setCompareId(null);
            navigate({ view: "forecast", raceId: r.race.race_id });
          }}
          onDeleted={(id) => {
            if (chosenRunId === id) setChosenRunId(null);
            if (compareId === id) setCompareId(null);
          }}
        />
      </div>

      <div className="min-w-0 lg:col-start-1 lg:row-start-3">
        <SeasonOutlook />
      </div>
    </div>
  );
}
