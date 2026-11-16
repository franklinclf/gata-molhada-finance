import { useState } from 'preact/hooks';
import { localDay } from './format.ts';
import { MonthGrid } from './MonthGrid.tsx';
import { activePreset, coverage, FIRST_YEAR, formatDay, isWholeYear, parseDay, pickMonth, rangeLabel, RANGE_PRESETS, type Range, yearRange } from './month-range.ts';
import { Popover } from './Popover.tsx';

/** The two typed fields: they apply on Enter or on the button, and say so when a date is not valid. */
function DayFields({ range, onApply }: { range: Range; onApply: (range: Range) => void }) {
  const [from, setFrom] = useState(formatDay(range.from));
  const [to, setTo] = useState(formatDay(range.to));
  const a = from.trim() === '' ? undefined : parseDay(from);
  const b = to.trim() === '' ? undefined : parseDay(to);
  const invalid = a === null || b === null || (a !== undefined && b !== undefined && a > b);
  const apply = () => !invalid && onApply({ from: a ?? undefined, to: b ?? undefined });
  const field = (label: string, value: string, set: (v: string) => void, bad: boolean) => (
    <label class="day-field">
      <span class="muted">{label}</span>
      <input
        inputMode="numeric"
        placeholder="dd/mm/aaaa"
        maxLength={10}
        aria-label={label}
        aria-invalid={bad}
        value={value}
        onInput={(e) => set((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
      />
    </label>
  );
  return (
    <div class="day-fields">
      {field('De', from, setFrom, a === null)}
      {field('Até', to, setTo, b === null || (a !== undefined && a !== null && b !== undefined && a > b))}
      <button type="button" class="chip" disabled={invalid} onClick={apply}>
        Aplicar
      </button>
    </div>
  );
}

function DatePanel({ range, today, maxYear, onChange, close }: { range: Range; today: string; maxYear: number; onChange: (range: Range) => void; close: () => void }) {
  const [year, setYear] = useState(Math.min(Math.max(Number((range.to ?? today).slice(0, 4)), FIRST_YEAR), maxYear));
  // The first month click waits for a second one that extends the range; the panel stays open until then.
  const [anchor, setAnchor] = useState<string | null>(null);
  const preset = activePreset(range, today);
  return (
    <div class="date-panel">
      <div class="presets">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            class={preset?.id === p.id ? 'chip on' : 'chip'}
            onClick={() => {
              onChange(p.range(today));
              close();
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <MonthGrid
        year={year}
        onNavigate={setYear}
        maxYear={maxYear}
        yearOn={isWholeYear(year, range, today)}
        onYear={() => {
          setAnchor(null);
          onChange(yearRange(year, today));
          close();
        }}
        cell={(key) => ({ state: range.from === undefined && range.to === undefined ? 'none' : coverage(key, range, today), anchor: anchor === key, disabled: key > `${maxYear}-12` })}
        onPick={(key) => {
          const next = pickMonth(anchor, key, today);
          setAnchor(next.anchor);
          onChange(next.range);
          if (next.anchor === null) close();
        }}
      />
      <div class="muted pick-hint">{anchor ? 'Clique em outro mês para incluir os meses até ele.' : 'Clique em um mês; um segundo clique amplia o período.'}</div>
      <DayFields
        range={range}
        onApply={(r) => {
          onChange(r);
          close();
        }}
      />
    </div>
  );
}

/** Period of the transactions: a month grid (one click a month, two for a span), presets, and typed days. Empty means all time. */
export function DateRangePicker({ from, to, now, onChange }: { from: string | undefined; to: string | undefined; now: Date; onChange: (range: Range) => void }) {
  const today = localDay(now.toISOString());
  const range = { from, to };
  return (
    <Popover trigger={<>Período: <strong>{rangeLabel(range, today)}</strong></>} label="Período" class={from || to ? 'chip on pop-trigger' : 'chip pop-trigger'}>
      {(close) => <DatePanel range={range} today={today} maxYear={Number(today.slice(0, 4)) + 1} onChange={onChange} close={close} />}
    </Popover>
  );
}
