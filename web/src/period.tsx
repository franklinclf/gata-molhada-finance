import { daysBefore, localDay } from './format.ts';

interface Preset {
  id: string;
  label: string;
  range: (today: string) => { from: string; to: string };
}

const monthStart = (today: string, back: number) => {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) - back;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
};

const monthEnd = (day: string) => {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const PRESETS: Preset[] = [
  { id: '7d', label: '7 dias', range: (t) => ({ from: daysBefore(t, 6), to: t }) },
  { id: 'month', label: 'Este mês', range: (t) => ({ from: monthStart(t, 0), to: t }) },
  { id: 'last', label: 'Mês passado', range: (t) => ({ from: monthStart(t, 1), to: monthEnd(monthStart(t, 1)) }) },
  { id: '3m', label: '3 meses', range: (t) => ({ from: monthStart(t, 2), to: t }) },
  { id: '6m', label: '6 meses', range: (t) => ({ from: monthStart(t, 5), to: t }) },
  { id: '12m', label: '12 meses', range: (t) => ({ from: monthStart(t, 11), to: t }) },
];

/** Date range controls: quick presets plus two date fields. An empty range means all time. */
export function PeriodPicker({ from, to, now, onChange }: { from: string | undefined; to: string | undefined; now: Date; onChange: (range: { from?: string; to?: string }) => void }) {
  const today = localDay(now.toISOString());
  const active = PRESETS.find((p) => {
    const r = p.range(today);
    return r.from === from && r.to === to;
  });
  return (
    <div class="period">
      {PRESETS.map((p) => (
        <button key={p.id} class={active?.id === p.id ? 'chip on' : 'chip'} onClick={() => onChange(p.range(today))}>
          {p.label}
        </button>
      ))}
      <button class={from === undefined && to === undefined ? 'chip on' : 'chip'} onClick={() => onChange({})}>
        Tudo
      </button>
      <input type="date" aria-label="De" value={from ?? ''} max={to ?? today} onChange={(e) => onChange({ from: (e.currentTarget as HTMLInputElement).value || undefined, to })} />
      <span class="muted">até</span>
      <input type="date" aria-label="Até" value={to ?? ''} min={from} max={today} onChange={(e) => onChange({ from, to: (e.currentTarget as HTMLInputElement).value || undefined })} />
    </div>
  );
}
