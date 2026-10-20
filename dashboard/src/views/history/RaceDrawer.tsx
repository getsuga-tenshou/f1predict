import { useRef, useState, type KeyboardEvent } from "react";
import type { HistoryModeDetail, HistoryRaceDetail, Metrics, Mode, ModeInfo, Split } from "../../api/types";
import { useApi } from "../../api/useApi";
import { Legend } from "../../components/charts/ChartFrame";
import { Drawer } from "../../components/Drawer";
import { Badge, InlineError, Skeleton } from "../../components/feedback";
import { finishLabel, formatLogloss, formatProb, ordinal } from "../../lib/format";

const SPLIT_TEXT: Record<Split, string> = { validation: "Validation season", test: "Test season", holdout: "Holdout season" };

function MomentCells({ detail, modes }: { detail: HistoryRaceDetail; modes: ModeInfo[] }) {
  return (
    <div className="grid grid-cols-3 divide-x divide-hair border-y border-hair">
      {modes.map((m) => {
        const d = detail.modes[m.id];
        const fav = d?.rows[0];
        const winnerWasFav = fav && fav.driver.driver_id === detail.winner.driver_id;
        return (
          <div key={m.id} className="flex min-w-0 flex-col gap-1 px-3 py-3 first:pl-0">
            <span className="text-xs text-ink-muted">{m.short}</span>
            {d ? (
              <>
                <span className="text-2xl leading-tight font-semibold text-ink-1">{formatProb(d.p_winner)}</span>
                <span className="text-[13px] text-ink-2">{`ranked ${ordinal(d.winner_rank)}`}</span>
                {fav ? (
                  <span className="text-xs text-ink-muted">
                    {winnerWasFav ? "Was the favourite" : `Favourite ${fav.driver.abbr} ${formatProb(fav.p)}`}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-[13px] text-ink-2">No forecast</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FieldTable({ detail, modeLabel, winnerId, baselineLabel }: { detail: HistoryModeDetail; modeLabel: string; winnerId: string; baselineLabel: string }) {
  const maxP = Math.max(...detail.rows.map((r) => r.p), 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-ink-2 tabular-nums">
        {`Log-loss ${formatLogloss(detail.logloss)} vs ${formatLogloss(detail.baseline_logloss)} for ${baselineLabel}`}
      </p>
      <Legend
        items={[
          { label: "Winner", color: "var(--accent)", shape: "rect" },
          { label: "Rest of the field", color: "var(--deemph)", shape: "rect" },
        ]}
      />
      <table className="w-full table-fixed border-collapse text-[13px]">
        <caption className="sr-only">{`Predicted win probability and actual finish, ${modeLabel.toLowerCase()}`}</caption>
        <thead>
          <tr className="border-b border-hair text-left text-xs text-ink-muted">
            <th scope="col" className="w-7 py-2 font-medium">
              <span className="sr-only">Rank</span>
              <span aria-hidden>#</span>
            </th>
            <th scope="col" className="w-[44%] py-2 font-medium sm:w-[32%]">Driver</th>
            <th scope="col" className="hidden w-[22%] py-2 font-medium sm:table-cell">Team</th>
            <th scope="col" className="py-2 font-medium">Predicted</th>
            <th scope="col" className="w-14 py-2 text-right font-medium">Finish</th>
          </tr>
        </thead>
        <tbody>
          {detail.rows.map((r) => {
            const isWinner = r.driver.driver_id === winnerId;
            const frac = maxP > 0 ? r.p / maxP : 0;
            return (
              <tr key={r.driver.driver_id} className={`h-[30px] border-b border-hair ${isWinner ? "bg-tint tint-lift" : ""}`}>
                <td className="text-ink-muted tabular-nums">{r.rank}</td>
                <td>
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="w-9 shrink-0 font-mono font-semibold text-ink-1">{r.driver.abbr}</span>
                    <span className="truncate text-ink-2">{r.driver.name}</span>
                  </div>
                </td>
                <td className="hidden truncate pr-2 text-ink-muted sm:table-cell">{r.driver.team}</td>
                <td>
                  <div className="relative mr-14 h-2.5">
                    <div
                      className={`absolute inset-y-0 left-0 rounded-r-[4px] ${isWinner ? "bg-accent" : "bg-deemph"}`}
                      style={{ width: `${Math.max(frac * 100, 0.5)}%` }}
                    >
                      <span className="absolute top-1/2 left-full ml-1.5 -translate-y-1/2 whitespace-nowrap text-ink-1 tabular-nums">{formatProb(r.p)}</span>
                    </div>
                  </div>
                </td>
                <td className={`text-right tabular-nums ${isWinner ? "font-semibold text-ink-1" : "text-ink-2"}`}>{finishLabel(r.finish_pos, r.status)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModeTabs({ modes, available, value, onChange }: { modes: ModeInfo[]; available: Set<Mode>; value: Mode; onChange: (m: Mode) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = modes.filter((m) => available.has(m.id));
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = enabled.findIndex((m) => m.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const m = enabled[next];
    onChange(m.id);
    refs.current[modes.indexOf(m)]?.focus();
  };
  return (
    <div role="tablist" aria-label="Moment" className="flex gap-5 border-b border-hair">
      {modes.map((m, i) => {
        const selected = m.id === value;
        const can = available.has(m.id);
        return (
          <button
            key={m.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`tab-${m.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="drawer-field"
            tabIndex={selected ? 0 : -1}
            disabled={!can}
            onClick={() => onChange(m.id)}
            onKeyDown={onKey}
            className={`relative -mb-px h-9 text-[13px] font-medium whitespace-nowrap transition-colors disabled:opacity-40 ${
              selected ? "text-ink-1" : "text-ink-2 hover:text-ink-1"
            }`}
          >
            {m.short}
            <span aria-hidden className={`absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-accent ${selected ? "opacity-100" : "opacity-0"}`} />
          </button>
        );
      })}
    </div>
  );
}

export function RaceDrawer({
  raceId,
  defaultMode,
  modes,
  metrics,
  onClose,
}: {
  raceId: number;
  defaultMode: Mode;
  modes: ModeInfo[];
  metrics: Metrics | undefined;
  onClose: () => void;
}) {
  const api = useApi<HistoryRaceDetail>(`/api/history/${raceId}`);
  const detail = api.data && api.data.race.race_id === raceId ? api.data : undefined;
  const [picked, setPicked] = useState<Mode | null>(null);
  const available = new Set((Object.keys(detail?.modes ?? {}) as Mode[]).filter((m) => detail?.modes[m]));
  const mode: Mode = picked && available.has(picked) ? picked : available.has(defaultMode) ? defaultMode : (modes.find((m) => available.has(m.id))?.id ?? defaultMode);
  const modeDetail = detail?.modes[mode];
  const baselineLabel = metrics?.modes[mode]?.baseline.label ?? "the baseline";

  const title = detail ? (
    <div className="flex flex-col gap-1">
      <h2 id="drawer-title" className="m-0 text-xl leading-snug font-semibold text-ink-1">{`${detail.race.year} ${detail.race.grand_prix} Grand Prix`}</h2>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
        <span>{`Won by ${detail.winner.name}, ${detail.winner.team}`}</span>
        <Badge>{SPLIT_TEXT[detail.split]}</Badge>
      </div>
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      <h2 id="drawer-title" className="m-0 text-xl font-semibold text-ink-1">
        Race details
      </h2>
      <Skeleton className="h-4 w-48" />
    </div>
  );

  return (
    <Drawer title={title} labelId="drawer-title" onClose={onClose}>
      {api.error && !detail ? <InlineError error={api.error} onRetry={api.refetch} title="Could not load this race" /> : null}
      {!detail && !api.error ? (
        <div aria-hidden className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : null}
      {detail ? (
        <div className="flex flex-col gap-7">
          <section aria-labelledby="weekend-title" className="flex flex-col gap-3">
            <h3 id="weekend-title" className="m-0 text-[15px] font-semibold text-ink-1">
              Through the weekend
            </h3>
            <p className="m-0 text-[13px] text-ink-muted">{`Probability given to ${detail.winner.name} at each moment.`}</p>
            <MomentCells detail={detail} modes={modes} />
          </section>
          <section aria-labelledby="field-title" className="flex flex-col gap-3">
            <h3 id="field-title" className="m-0 text-[15px] font-semibold text-ink-1">
              The field
            </h3>
            <ModeTabs modes={modes} available={available} value={mode} onChange={setPicked} />
            <div id="drawer-field" role="tabpanel" aria-labelledby={`tab-${mode}`}>
              {modeDetail ? (
                <FieldTable detail={modeDetail} modeLabel={modes.find((m) => m.id === mode)?.label ?? mode} winnerId={detail.winner.driver_id} baselineLabel={baselineLabel} />
              ) : (
                <p className="m-0 text-sm text-ink-2">No forecast at this moment.</p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
