import { api } from '../api.ts';
import { LineChart } from '../charts.tsx';
import { brl } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function NetWorthWidget({ now, hidden, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.netWorth(), [], 300_000);
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
            {size !== 'sm' && <LineChart points={data.history.map((p) => p.net)} days={data.history.map((p) => p.day)} hidden={hidden} label="Patrimônio" />}
          </>
        )
      }
    />
  );
}
