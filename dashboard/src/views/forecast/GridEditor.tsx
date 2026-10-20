import { ArrowDownIcon, ArrowUpIcon, DotsSixVerticalIcon } from "@phosphor-icons/react";
import { Reorder, useDragControls } from "motion/react";
import { useState } from "react";
import { Button, IconButton } from "../../components/Button";
import { effectiveQuali, moveRow, updateRow, type GridRow, type GridState } from "../../lib/grid";

const COLS = "grid grid-cols-[22px_16px_minmax(0,1fr)_52px_40px_56px] items-center gap-x-2";

function GridItem({
  row,
  index,
  count,
  onMove,
  onQuali,
  onPitLane,
}: {
  row: GridRow;
  index: number;
  count: number;
  onMove: (index: number, delta: -1 | 1) => void;
  onQuali: (id: string, quali: number | null) => void;
  onPitLane: (id: string, v: boolean) => void;
}) {
  const controls = useDragControls();
  const shownQuali = effectiveQuali(row, index);
  // Text being typed; committed while valid, cleared back to the slot when left empty.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Reorder.Item
      value={row}
      dragListener={false}
      dragControls={controls}
      as="li"
      className={`${COLS} h-9 border-b border-hair bg-surface`}
    >
      <span className="text-right text-[13px] text-ink-muted tabular-nums">{index + 1}</span>
      <span
        aria-hidden
        className="flex h-7 cursor-grab touch-none items-center justify-center text-ink-3 hover:text-ink-1 active:cursor-grabbing"
        onPointerDown={(e) => controls.start(e)}
      >
        <DotsSixVerticalIcon size={16} />
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="font-mono text-[13px] font-semibold text-ink-1">{row.abbr}</span>
        <span className="truncate text-[13px] text-ink-2">{row.name}</span>
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={count}
        aria-label={`Qualified position, ${row.name}`}
        value={draft ?? String(shownQuali)}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          const n = Math.round(Number(v));
          if (v !== "" && Number.isFinite(n) && n >= 1 && n <= count) onQuali(row.driver_id, n);
        }}
        onBlur={() => {
          if (draft === "") onQuali(row.driver_id, null);
          setDraft(null);
        }}
        className={`control-input h-7 w-full px-1.5 text-right text-[13px] tabular-nums ${row.quali != null && row.quali !== index + 1 ? "font-semibold" : ""}`}
      />
      <span className="flex justify-center">
        <input
          type="checkbox"
          aria-label={`Pit lane start, ${row.name}`}
          checked={row.pitLane}
          onChange={(e) => onPitLane(row.driver_id, e.target.checked)}
          className="size-4 accent-[var(--ink-1)]"
        />
      </span>
      <span className="flex justify-end">
        <IconButton size="sm" label={`Move ${row.name} up`} icon={<ArrowUpIcon size={14} aria-hidden />} disabled={index === 0} onClick={() => onMove(index, -1)} />
        <IconButton
          size="sm"
          label={`Move ${row.name} down`}
          icon={<ArrowDownIcon size={14} aria-hidden />}
          disabled={index === count - 1}
          onClick={() => onMove(index, 1)}
        />
      </span>
    </Reorder.Item>
  );
}

export function GridEditor({
  grid,
  onChange,
  onOrderByForecast,
  onReset,
  live,
}: {
  grid: GridState;
  onChange: (g: GridState) => void;
  onOrderByForecast: (() => void) | null;
  onReset: () => void;
  live: boolean;
}) {
  const rows = grid.rows;
  const setRows = (next: GridRow[]) => onChange({ ...grid, rows: next });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id="grid-label" className="text-[13px] font-medium text-ink-1">
          Starting grid
        </span>
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={onOrderByForecast ?? undefined} disabled={!onOrderByForecast}>
            Order by forecast
          </Button>
          <Button size="sm" variant="ghost" onClick={onReset}>
            Reset
          </Button>
        </span>
      </div>
      {live && grid.origin === "manual" ? (
        <p className="m-0 text-[13px] leading-snug text-ink-muted">
          With OpenF1 on, the model uses this weekend's qualifying and this grid is not sent. Load qualifying into the grid to apply penalties.
        </p>
      ) : null}
      <div className={`${COLS} border-b border-hair pb-1 text-xs text-ink-muted`} aria-hidden>
        <span className="text-right">Slot</span>
        <span />
        <span>Driver</span>
        <span className="text-right">Qualified</span>
        <span className="text-center">Pit lane</span>
        <span />
      </div>
      <Reorder.Group axis="y" as="ol" values={rows} onReorder={setRows} aria-labelledby="grid-label" className="m-0 list-none p-0">
        {rows.map((r, i) => (
          <GridItem
            key={r.driver_id}
            row={r}
            index={i}
            count={rows.length}
            onMove={(idx, d) => setRows(moveRow(rows, idx, d))}
            onQuali={(id, q) => setRows(updateRow(rows, id, { quali: q }))}
            onPitLane={(id, v) => setRows(updateRow(rows, id, { pitLane: v }))}
          />
        ))}
      </Reorder.Group>
      <p className="m-0 text-[13px] leading-snug text-ink-muted">Drag to set the starting grid. Change Qualified when a penalty moved a driver back.</p>
      {!live ? (
        <p className="m-0 text-[13px] leading-snug text-ink-muted">
          Without lap times the model only sees positions, so probabilities come out flatter than with real qualifying.
        </p>
      ) : null}
    </div>
  );
}
