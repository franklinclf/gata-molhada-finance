import { useState } from 'preact/hooks';
import { localDay } from './format.ts';
import { MonthGrid } from './MonthGrid.tsx';
import { activePreset, coverage, dayBounds, daysInMonth, FIRST_YEAR, isWholeYear, pickMonth, rangeLabel, RANGE_PRESETS, type Range, withDay, yearRange } from './month-range.ts';
import { shiftRange } from './range.ts';
import { Popover } from './Popover.tsx';

/**
 * The day inside the chosen months, one side at a time (De / Até) as a small 7 column grid of 1..31 limited to the real length of the
 * month. Off until a month is chosen; a click applies at once.
 */
function DayPicker({ range, today, onChange }: { range: Range; today: string; onChange: (range: Range) => void }) {
  const [side, setSide] = useState<'from' | 'to'>('from');
  const bounds = dayBounds(range, side, today);
  const sides = { from: dayBounds(range, 'from', today), to: dayBounds(range, 'to', today) };
  const current = bounds ? Number((side === 'from' ? range.from! : range.to!).slice(8, 10)) : null;
  const length = bounds ? daysInMonth((side === 'from' ? range.from! : range.to!).slice(0, 7)) : 31;
  const text = (r: 'from' | 'to') => (range[r] ? range[r]!.slice(8, 10) : '--');
  return (
    <div class={bounds ? 'day-picker' : 'day-picker off'}>
      <div class="seg" role="group" aria-label="Dia do período">
        {(['from', 'to'] as const).map((r) => (
          <button key={r} type="button" class={side === r ? 'tab on' : 'tab'} aria-pressed={side === r} disabled={!sides[r]} onClick={() => setSide(r)}>
            {r === 'from' ? 'De' : 'Até'} dia <strong>{text(r)}</strong>
          </button>
        ))}
      </div>
      <div class="day-grid" role="group" aria-label={side === 'from' ? 'Dia inicial' : 'Dia final'}>
        {Array.from({ length }, (_, i) => i + 1).map((d) => (
          <button key={d} type="button" class={d === current ? 'dcell on' : 'dcell'} aria-pressed={d === current} disabled={!bounds || d < bounds.min || d > bounds.max} onClick={() => onChange(withDay(range, side, d, today))}>
            {String(d).padStart(2, '0')}
          </button>
        ))}
      </div>
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
      <DayPicker range={range} today={today} onChange={onChange} />
    </div>
  );
}

/**
 * Period picker: a month grid (one click a month, two for a span), presets and the days inside the chosen months. Empty means all time.
 * With `arrows` it also gets previous and next buttons that move the period by its own length.
 */
export function DateRangePicker({ from, to, now, onChange, arrows = false }: { from: string | undefined; to: string | undefined; now: Date; onChange: (range: Range) => void; arrows?: boolean }) {
  const today = localDay(now.toISOString());
  const range = { from, to };
  const picker = (
    <Popover trigger={<>Período: <strong>{rangeLabel(range, today)}</strong></>} label="Período" class={from || to ? 'chip on pop-trigger' : 'chip pop-trigger'}>
      {(close) => <DatePanel range={range} today={today} maxYear={Number(today.slice(0, 4)) + 1} onChange={onChange} close={close} />}
    </Popover>
  );
  if (!arrows || from === undefined || to === undefined) return picker;
  const earlier = shiftRange(from, to, -1, today);
  const later = shiftRange(from, to, 1, today);
  return (
    <div class="period">
      <button type="button" class="chip" aria-label="Período anterior" disabled={earlier === null} onClick={() => earlier && onChange(earlier)}>
        ‹
      </button>
      {picker}
      <button type="button" class="chip" aria-label="Próximo período" disabled={later === null || to >= today} onClick={() => later && onChange(later)}>
        ›
      </button>
    </div>
  );
}
