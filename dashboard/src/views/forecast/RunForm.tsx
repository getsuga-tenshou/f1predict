import { useId, useMemo, useState } from "react";
import type { CalendarRace, LiveWeekend, Lineup, Mode, ModeInfo, RunRequest } from "../../api/types";
import { refetchWhere, useApi } from "../../api/useApi";
import { Button } from "../../components/Button";
import { Field, Segmented, Select, Switch } from "../../components/controls";
import { Badge, InlineError, Skeleton } from "../../components/feedback";
import { formatDateShort, raceShort } from "../../lib/format";
import { gridForField, gridFromQuali, gridToSend, initGrid, orderRows, type GridState } from "../../lib/grid";
import { assignSeat, defaultSeats, driverOptions, fieldFromSeats, isLineupChanged, toLineupEntries, type Seats } from "../../lib/lineup";
import { GridEditor } from "./GridEditor";
import { LineupEditor } from "./LineupEditor";
import { RunProgress } from "./RunProgress";
import type { Submission } from "./useRunSubmission";

const LABEL_MAX = 80;

function LiveSessions({ raceId, mode, onLoadQuali }: { raceId: number; mode: Mode; onLoadQuali: (q: NonNullable<LiveWeekend["quali"]>) => void }) {
  const [requested, setRequested] = useState(false);
  const url = `/api/live?race_id=${raceId}`;
  const live = useApi<LiveWeekend>(requested ? url : null);
  // Every click asks the server again: a result cached earlier in the session may predate a session.
  const check = () => {
    if (requested) {
      live.refetch();
    } else {
      refetchWhere((u) => u === url); // drops an unwatched cached result, so the first load is fresh
      setRequested(true);
    }
  };
  const checking = requested && (live.isFirstLoad || live.isStale);
  const data = live.data;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          size="sm"
          onClick={check}
          disabled={checking}
          aria-describedby="live-result"
        >
          {checking ? "Checking sessions" : "Check sessions"}
        </Button>
      </div>
      <div id="live-result" aria-live="polite" className="flex flex-col gap-2">
        {live.error && !checking ? <InlineError error={live.error} onRetry={live.refetch} title="Could not check OpenF1" /> : null}
        {data && !checking ? (
          !data.reachable ? (
            <InlineError error={new Error(data.error ?? "OpenF1 could not be reached.")} onRetry={live.refetch} title="OpenF1 is not reachable" />
          ) : data.sessions.length === 0 ? (
            <p className="m-0 text-[13px] leading-snug text-ink-muted">
              No sessions have finished yet. OpenF1 publishes each one about 30 minutes after it ends.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5" aria-label="Finished sessions">
                {data.sessions.map((s) => (
                  <Badge key={`${s.kind}-${s.ended_at}`} className="font-mono">
                    {s.name}
                  </Badge>
                ))}
              </div>
              {data.quali ? (
                <div className="flex flex-col items-start gap-1.5">
                  <Button size="sm" onClick={() => data.quali && onLoadQuali(data.quali)}>
                    Load qualifying into the grid
                  </Button>
                  {mode !== "pre_race" ? (
                    <p className="m-0 text-[13px] leading-snug text-ink-muted">Qualifying has finished. Loading it switches the moment to after qualifying.</p>
                  ) : null}
                </div>
              ) : null}
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

export function RunForm({
  raceId,
  upcoming,
  calendarLoading,
  onRaceChange,
  modes,
  forecastOrder,
  submission,
  onSubmit,
  onDismissError,
}: {
  raceId: number | null;
  upcoming: CalendarRace[];
  calendarLoading: boolean;
  onRaceChange: (raceId: number) => void;
  modes: ModeInfo[];
  /** Driver ids in the displayed forecast's order for this race, if there is one. */
  forecastOrder: string[];
  submission: Submission;
  onSubmit: (req: RunRequest) => void;
  onDismissError: () => void;
}) {
  const raceSelectId = useId();
  const labelId = useId();
  const momentId = useId();
  const [modeChoice, setMode] = useState<Mode>("pre_weekend");
  // Weekend sessions only exist for the next race; later races can only be forecast before the weekend.
  const isNextRace = raceId != null && upcoming[0]?.race_id === raceId;
  const mode: Mode = isNextRace ? modeChoice : "pre_weekend";
  const [liveChoice, setLive] = useState<boolean | null>(null);
  // After practice, OpenF1 is the only source of weekend data, so it starts on. After qualifying it
  // starts off: until qualifying has run, the hand-set grid is the scenario, and with OpenF1 on
  // that grid is not sent.
  const live = liveChoice ?? mode === "pre_quali";
  const [label, setLabel] = useState("");
  const [grid, setGrid] = useState<GridState | null>(null);
  const [seats, setSeats] = useState<Seats | null>(null);

  const lineupApi = useApi<Lineup>(raceId != null ? `/api/lineup?race_id=${raceId}` : null);
  const lineup = lineupApi.data && lineupApi.data.race.race_id === raceId ? lineupApi.data : undefined;
  const defaults = useMemo(() => (lineup ? defaultSeats(lineup) : null), [lineup]);
  const options = useMemo(() => (lineup ? driverOptions(lineup) : []), [lineup]);
  const currentSeats = seats ?? defaults;
  const field = useMemo(
    () => (lineup && currentSeats ? fieldFromSeats(currentSeats, lineup.teams, options) : []),
    [lineup, currentSeats, options],
  );

  // The grid starts from the displayed forecast's order (else line-up order) the first time it is needed.
  const gridState = grid ?? (mode === "pre_race" && field.length ? initGrid(field, forecastOrder) : null);

  const modeInfo = modes.find((m) => m.id === mode);
  const usesWeekend = mode !== "pre_weekend";
  const effLive = usesWeekend && live;
  const active = submission.kind === "active";

  const assign = (teamId: string, seat: number, driverId: string) => {
    if (!currentSeats || !defaults || !lineup) return;
    const next = assignSeat(currentSeats, defaults, teamId, seat, driverId);
    setSeats(next);
    if (grid) setGrid(gridForField(grid, fieldFromSeats(next, lineup.teams, options)));
  };

  const resetLineup = () => {
    if (!defaults || !lineup) return;
    setSeats(null);
    if (grid) setGrid(gridForField(grid, fieldFromSeats(defaults, lineup.teams, options)));
  };

  const buildRequest = (): RunRequest | null => {
    if (raceId == null) return null;
    const req: RunRequest = { race_id: raceId, mode, live: effLive };
    if (mode === "pre_race") {
      const g = gridToSend(gridState, effLive);
      if (g) req.grid = g;
    }
    if (lineup && currentSeats && defaults && isLineupChanged(currentSeats, defaults)) {
      req.lineup = toLineupEntries(currentSeats, lineup.teams);
    }
    const trimmed = label.trim();
    if (trimmed) req.label = trimmed.slice(0, LABEL_MAX);
    return req;
  };

  const submit = () => {
    const req = buildRequest();
    if (req) onSubmit(req);
  };

  return (
    <section aria-labelledby="runform-title" className="flex flex-col gap-5 rounded-panel border border-hair bg-surface p-5">
      <h2 id="runform-title" className="m-0 text-lg font-semibold text-ink-1">
        Run a forecast
      </h2>

      <Field label="Race" htmlFor={raceSelectId}>
        {calendarLoading ? (
          <Skeleton className="h-[34px] w-full" />
        ) : upcoming.length ? (
          <Select id={raceSelectId} value={raceId ?? ""} onChange={(e) => onRaceChange(Number(e.target.value))} className="w-full" disabled={active}>
            {upcoming.map((r) => (
              <option key={r.race_id} value={r.race_id}>
                {`${raceShort(r)}, ${formatDateShort(r.date)}`}
              </option>
            ))}
          </Select>
        ) : (
          <p className="m-0 text-[13px] text-ink-2">No upcoming races in the calendar.</p>
        )}
      </Field>

      <div className="flex flex-col gap-2">
        <span id={momentId} className="text-[13px] font-medium text-ink-1">
          Moment
        </span>
        <Segmented
          labelledBy={momentId}
          options={modes.map((m) => ({ value: m.id, label: m.label, disabled: !isNextRace && m.id !== "pre_weekend" }))}
          value={mode}
          onChange={setMode}
          size="sm"
          layout="column"
        />
        {modeInfo ? <p className="m-0 text-[13px] leading-snug text-ink-muted">{modeInfo.knows}</p> : null}
        {!isNextRace && raceId != null ? (
          <p className="m-0 text-[13px] leading-snug text-ink-muted">
            After practice and after qualifying need this weekend's sessions, so they are only available for the next race.
          </p>
        ) : null}
      </div>

      {usesWeekend ? (
        <div className="flex flex-col gap-3 border-t border-hair pt-4">
          <Switch checked={live} onChange={setLive} label="Use this weekend's sessions from OpenF1" />
          {raceId != null ? (
            <LiveSessions
              key={raceId}
              raceId={raceId}
              mode={mode}
              onLoadQuali={(q) => {
                setMode("pre_race");
                setLive(true);
                setGrid(gridFromQuali(field, q));
              }}
            />
          ) : null}
        </div>
      ) : null}

      {mode === "pre_race" ? (
        <div className="border-t border-hair pt-4">
          {lineupApi.error && !lineup ? (
            <InlineError error={lineupApi.error} onRetry={lineupApi.refetch} title="Could not load the entrants" />
          ) : gridState ? (
            <GridEditor
              grid={gridState}
              onChange={setGrid}
              live={effLive}
              onOrderByForecast={forecastOrder.length ? () => setGrid({ ...gridState, rows: orderRows(gridState.rows, forecastOrder) }) : null}
              onReset={() => setGrid(gridState.classification ? gridFromQuali(field, gridState.classification) : null)}
            />
          ) : (
            <div aria-hidden className="flex flex-col gap-1.5">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className={raceId == null ? "hidden" : "border-t border-hair pt-4"}>
        {raceId == null ? null : lineup && currentSeats && defaults ? (
          <LineupEditor lineup={lineup} seats={currentSeats} defaults={defaults} options={options} onAssign={assign} onReset={resetLineup} />
        ) : lineupApi.error ? (
          <InlineError error={lineupApi.error} onRetry={lineupApi.refetch} title="Could not load the line-up" />
        ) : (
          <Skeleton className="h-5 w-40" />
        )}
      </div>

      <Field label="Label" htmlFor={labelId} helper="Optional. Shown in the run log.">
        <input
          id={labelId}
          type="text"
          maxLength={LABEL_MAX}
          aria-describedby={`${labelId}-help`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="control-input w-full text-sm"
          autoComplete="off"
        />
      </Field>

      <div className="flex flex-col gap-3">
        <Button variant="primary" className="w-full" onClick={submit} disabled={active || raceId == null || !upcoming.some((r) => r.race_id === raceId)}>
          Run forecast
        </Button>
        {submission.kind === "active" ? <RunProgress stage={submission.stage} startedAt={submission.startedAt} /> : null}
        {submission.kind === "error" ? (
          <div role="alert" className="flex flex-col gap-2 rounded-control border border-hair bg-tint px-3 py-2.5 text-[13px]">
            <div className="font-medium text-ink-1">The run failed</div>
            <div className="break-words text-ink-2">{submission.message}</div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => onSubmit(submission.request)}>
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={onDismissError}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
