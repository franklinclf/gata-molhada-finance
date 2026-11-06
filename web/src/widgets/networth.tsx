import { api } from '../api.ts';
import { LineChart, StackBar } from '../charts.tsx';
import { brl } from '../format.ts';
import { chartHeight, shareLabel } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function NetWorthWidget({ now, hidden, size, pixels }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.netWorth(), [], 300_000);
  const total = data ? data.assets + data.liabilities : 0;
  return (
    <Widget
      title="Patrimônio"
      to={{ page: 'networth' }}
      now={now}
      loading={loading && !data}
      error={error}
      head={
        data && (
          <>
            <div class="big">{brl(data.net, hidden)}</div>
            <div class="muted">
              {brl(data.assets, hidden)} em bens e saldos · {brl(data.liabilities, hidden)} em dívidas
            </div>
            {size !== 'sm' && data.liabilities > 0 && (
              <StackBar
                parts={[
                  { value: data.assets, color: 'var(--good)', label: 'Bens e saldos', tip: `Bens e saldos\n${hidden ? '••••' : brl(data.assets)} · ${shareLabel(data.assets / total)}` },
                  { value: data.liabilities, color: 'var(--bad)', label: 'Dívidas', tip: `Dívidas\n${hidden ? '••••' : brl(data.liabilities)} · ${shareLabel(data.liabilities / total)}` },
                ]}
              />
            )}
            {size !== 'sm' && <LineChart points={data.history.map((p) => p.net)} days={data.history.map((p) => p.day)} hidden={hidden} label="Patrimônio" height={chartHeight(pixels, 330, 90, 180)} />}
          </>
        )
      }
    >
      {data && size !== 'sm' && data.items.length > 0 && (
        <FitList
          noun={['item', 'itens']}
          rows={[...data.items]
            .sort((a, b) => b.value - a.value)
            .map((i) => (
              <li key={`${i.kind}${i.name}${i.assetId ?? ''}`}>
                <Go class="grow clip" page="networth">
                  {i.name}
                </Go>
                <strong class={i.liability ? 'bad-text' : ''}>
                  {i.liability ? '−' : ''}
                  {brl(i.value, hidden)}
                </strong>
              </li>
            ))}
        />
      )}
    </Widget>
  );
}
