import { useState } from 'preact/hooks';
import { localDay, monthName } from './format.ts';
import { MonthGrid } from './MonthGrid.tsx';
import { FIRST_YEAR } from './month-range.ts';
import { Popover } from './Popover.tsx';

/** Card bill (`cycle` param: `open` or the due month YYYY-MM) as a month grid; months with no bill known are dimmed, not blocked. */
export function CycleSelect({ value, cycles, now, onChange }: { value: string | null; cycles: readonly string[]; now: Date; onChange: (value: string | null) => void }) {
  const today = localDay(now.toISOString());
  const maxYear = Math.max(Number(today.slice(0, 4)) + 1, ...cycles.map((c) => Number(c.slice(0, 4))));
  const label = value === null ? 'Qualquer' : value === 'open' ? 'Em aberto' : monthName(value);
  return (
    <Popover trigger={<>Fatura: <strong>{label}</strong></>} label="Fatura do cartão" class={value ? 'chip on pop-trigger' : 'chip pop-trigger'}>
      {(close) => <CyclePanel value={value} cycles={cycles} today={today} maxYear={maxYear} onChange={(v) => { onChange(v); close(); }} />}
    </Popover>
  );
}

function CyclePanel({ value, cycles, today, maxYear, onChange }: { value: string | null; cycles: readonly string[]; today: string; maxYear: number; onChange: (value: string | null) => void }) {
  const [year, setYear] = useState(Math.min(Math.max(Number((value && value !== 'open' ? value : today).slice(0, 4)), FIRST_YEAR), maxYear));
  return (
    <div class="date-panel">
      <div class="presets">
        <button type="button" class={value === 'open' ? 'chip on' : 'chip'} onClick={() => onChange('open')}>
          Em aberto
        </button>
        <button type="button" class={value === null ? 'chip on' : 'chip'} onClick={() => onChange(null)}>
          Qualquer
        </button>
      </div>
      <div class="muted pick-hint">Mês do vencimento da fatura.</div>
      <MonthGrid year={year} onNavigate={setYear} maxYear={maxYear} cell={(key) => ({ state: value === key ? 'full' : 'none', dim: !cycles.includes(key) && value !== key })} onPick={onChange} />
    </div>
  );
}
