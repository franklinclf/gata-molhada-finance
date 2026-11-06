import { api } from '../api.ts';
import { LineChart, PALETTE, Ring } from '../charts.tsx';
import { brl, cumulative, PERIODS, periodRange, type PeriodId } from '../format.ts';
import { chartHeight, shareLabel } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { FitList, PeriodSelect, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

function daysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function SpendingWidget({ now, hidden, size, pixels, config, setConfig }: WidgetProps) {
  const period = (config.period ?? 'month') as PeriodId;
  const by = config.by === 'merchant' ? 'merchant' : 'category';
  const range = periodRange(period, now);
  const { data, error, loading } = useLoad(() => api.spending(range.from, range.to, by), [range.from, range.to, by], 120_000);
  const limit = 60;
  const groups = data?.groups.slice(0, limit) ?? [];
  const link = (name: string) => (by === 'category' ? { from: range.from, to: range.to, category: name, netSpending: 'true' } : { from: range.from, to: range.to, q: name, netSpending: 'true' });
  return (
    <Widget
      title="Gastos"
      to={{ page: 'spending', params: { from: range.from, to: range.to, by } }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      actions={<PeriodSelect value={period} options={PERIODS} onChange={(id) => setConfig({ period: id })} />}
      head={
        data && (
          <>
            <div class="big">{brl(data.total, hidden)}</div>
            {size !== 'sm' && (
              <>
                <LineChart points={cumulative(data.daily, data.from, data.to)} hidden={hidden} days={daysIn(data.from, data.to)} height={chartHeight(pixels, 360, 90, 170)} />
                <div class="tabs">
                  <button class={by === 'category' ? 'tab on' : 'tab'} onClick={() => setConfig({ by: 'category' })}>Categorias</button>
                  <button class={by === 'merchant' ? 'tab on' : 'tab'} onClick={() => setConfig({ by: 'merchant' })}>Estabelecimentos</button>
                </div>
              </>
            )}
          </>
        )
      }
    >
      {data && size !== 'sm' && (
        <div class="split top">
          {size === 'lg' && <Ring size={120} segments={groups.slice(0, 8).map((g, i) => ({ value: g.amount, color: PALETTE[i % PALETTE.length]!, tip: `${g.name}\n${hidden ? '••••' : brl(g.amount)} · ${shareLabel(g.share)}` }))} />}
          <div class="grow">
            <FitList
              noun={[by === 'category' ? 'categoria' : 'estabelecimento', by === 'category' ? 'categorias' : 'estabelecimentos']}
              rows={groups.map((g, i) => (
                <li key={g.name}>
                  <span class="swatch" style={{ background: PALETTE[i % PALETTE.length] }} />
                  <Go class="grow clip" page="transactions" params={link(g.name)}>
                    {g.name}
                  </Go>
                  <span class="muted">{shareLabel(g.share)}</span>
                  <strong>{brl(g.amount, hidden)}</strong>
                </li>
              ))}
            />
          </div>
        </div>
      )}
    </Widget>
  );
}
