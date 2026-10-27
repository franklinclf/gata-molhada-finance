import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { LineChart, PALETTE, Ring } from '../charts.tsx';
import { brl, cumulative, percent, PERIODS, periodRange, type PeriodId } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { PeriodSelect, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function SpendingWidget({ now, hidden }: WidgetProps) {
  const [period, setPeriod] = useState<PeriodId>('month');
  const [by, setBy] = useState<'category' | 'merchant'>('category');
  const [expanded, setExpanded] = useState(false);
  const range = periodRange(period, now);
  const { data, error, loading } = useLoad(() => api.spending(range.from, range.to, by), [range.from, range.to, by], 120_000);
  const groups = data ? (expanded ? data.groups : data.groups.slice(0, 6)) : [];
  return (
    <Widget title="Gastos" asOf={data?.oldestDataAt} now={now} loading={loading && !data} error={error} actions={<PeriodSelect value={period} options={PERIODS} onChange={setPeriod} />}>
      {data && (
        <>
          <div class="big">{brl(data.total, hidden)}</div>
          <LineChart points={cumulative(data.daily, data.from, data.to)} hidden={hidden} />
          <div class="tabs">
            <button class={by === 'category' ? 'tab on' : 'tab'} onClick={() => setBy('category')}>Categorias</button>
            <button class={by === 'merchant' ? 'tab on' : 'tab'} onClick={() => setBy('merchant')}>Estabelecimentos</button>
          </div>
          <div class="split">
            <Ring size={120} segments={groups.map((g, i) => ({ value: g.amount, color: PALETTE[i % PALETTE.length]! }))} />
            <ul class="rows grow">
              {groups.map((g, i) => (
                <li key={g.name}>
                  <span class="swatch" style={{ background: PALETTE[i % PALETTE.length] }} />
                  <span class="grow clip">{g.name}</span>
                  <span class="muted">{percent(g.share)}</span>
                  <strong>{brl(g.amount, hidden)}</strong>
                </li>
              ))}
            </ul>
          </div>
          {data.groups.length > 6 && (
            <button class="link" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Ver menos' : `Ver mais ${data.groups.length - 6}`}
            </button>
          )}
        </>
      )}
    </Widget>
  );
}
