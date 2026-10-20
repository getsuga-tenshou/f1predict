import { CaretRightIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import type { Lineup } from "../../api/types";
import { Button } from "../../components/Button";
import { Select } from "../../components/controls";
import { Badge } from "../../components/feedback";
import { changedSeats, type DriverOption, type Seats } from "../../lib/lineup";

/** Collapsed disclosure: one row per team, a select per seat. */
export function LineupEditor({
  lineup,
  seats,
  defaults,
  options,
  onAssign,
  onReset,
}: {
  lineup: Lineup;
  seats: Seats;
  defaults: Seats;
  options: DriverOption[];
  onAssign: (teamId: string, seat: number, driverId: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const changed = changedSeats(seats, defaults);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 self-start rounded-badge text-[13px] font-medium text-ink-1"
      >
        <CaretRightIcon size={14} aria-hidden className={`text-ink-2 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        Line-up changes
        {changed.size ? <Badge>{`${changed.size} changed`}</Badge> : null}
      </button>
      <div id={panelId} hidden={!open} className="flex flex-col gap-3">
        <p className="m-0 text-[13px] leading-snug text-ink-muted">
          A line-up change replays every race since 1950 for the new field. The first run with a new line-up takes about 30 seconds.
        </p>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {lineup.teams.map((t) => (
            <li key={t.team_id} className="flex flex-col gap-1.5">
              <span className="text-[13px] text-ink-2">{t.team}</span>
              <div className="grid grid-cols-2 gap-2">
                {(seats[t.team_id] ?? []).map((driverId, i) => {
                  const isChanged = changed.has(`${t.team_id}:${i}`);
                  return (
                    <div key={`${t.team_id}-${i}`} className="flex min-w-0 flex-col gap-1">
                      <Select
                        aria-label={`${t.team}, seat ${i + 1}`}
                        value={driverId}
                        onChange={(e) => onAssign(t.team_id, i, e.target.value)}
                        className="w-full"
                      >
                        {options.map((o) => (
                          <option key={o.driver_id} value={o.driver_id}>
                            {`${o.abbr} ${o.name}`}
                          </option>
                        ))}
                      </Select>
                      {isChanged ? <Badge className="self-start">changed</Badge> : null}
                    </div>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
        <Button size="sm" onClick={onReset} disabled={changed.size === 0} className="self-start">
          Reset line-up
        </Button>
      </div>
    </div>
  );
}
