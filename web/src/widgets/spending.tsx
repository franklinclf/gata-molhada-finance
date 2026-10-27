import { api } from '../api.ts';
import { LineChart, PALETTE, Ring } from '../charts.tsx';
import { brl, cumulative, percent, PERIODS, periodRange, type PeriodId } from '../format.ts';
import { rowsFit } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { PeriodSelect, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function SpendingWidget({ item, now, hidden, size, config, setConfig }: WidgetProps) {
  const period = (config.period ?? 'month') as PeriodId;
  const by = config.by === 'merchant' ? 'merchant' : 'category';
  const range = periodRange(period, now);
  const { data, error, loading } = useLoad(() => api.spending(range.from, range.to, by), [range.from, range.to, by], 120_000);
  const limit = Math.max(rowsFit(item.h, size === 'lg' ? 7 : 5), 2);
  const groups = data?.groups.slice(0, limit) ?? [];
  const link = (name: string) => (by === 'category' ? { from: range.from, to: range.to, category: name, kind: 'expense', spendingOnly: 'true' } : { from: range.from, to: range.to, q: name, kind: 'expense', spendingOnly: 'true' });
  return (
    <Widget
      title="Gastos"
      to={{ page: 'spending', params: { from: range.from, to: range.to, by } }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      actions={<PeriodSelect value={period} options={PERIODS} onChange={(id) => setConfig({ period: id })} />}
    >
      {data && (
        <>
          <div class="big">{brl(data.total, hidden)}</div>
          {size !== 'sm' && (
            <>
              <LineChart points={cumulative(data.daily, data.from, data.to)} hidden={hidden} />
              <div class="tabs">
                <button class={by === 'category' ? 'tab on' : 'tab'} onClick={() => setConfig({ by: 'category' })}>Categorias</button>
                <button class={by === 'merchant' ? 'tab on' : 'tab'} onClick={() => setConfig({ by: 'merchant' })}>Estabelecimentos</button>
              </div>
              <div class="split">
                {size === 'lg' && <Ring size={120} segments={groups.map((g, i) => ({ value: g.amount, color: PALETTE[i % PALETTE.length]! }))} />}
                <ul class="rows grow">
                  {groups.map((g, i) => (
                    <li key={g.name}>
                      <span class="swatch" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <Go class="grow clip" page="transactions" params={link(g.name)}>
                        {g.name}
                      </Go>
                      <span class="muted">{percent(g.share)}</span>
                      <strong>{brl(g.amount, hidden)}</strong>
                    </li>
                  ))}
                </ul>
              </div>
              {data.groups.length > limit && <Go page="spending" params={{ from: range.from, to: range.to, by }}>Ver mais {data.groups.length - limit}</Go>}
            </>
          )}
        </>
      )}
    </Widget>
  );
}
