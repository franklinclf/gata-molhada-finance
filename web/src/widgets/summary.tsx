import { api } from '../api.ts';
import { brl, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

/** The month in a few numbers: what came in, what went out, how much was kept, and the net worth. */
export function SummaryWidget({ now, hidden, size }: WidgetProps) {
  const today = new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
  const from = `${today.slice(0, 7)}-01`;
  const flow = useLoad(() => api.cashflow(from, today), [from, today], 120_000);
  const spend = useLoad(() => api.spending(from, today, 'category'), [from, today], 120_000);
  const worth = useLoad(() => api.netWorth(), [], 300_000);
  const kept = flow.data && flow.data.inflow > 0 ? flow.data.net / flow.data.inflow : null;
  return (
    <Widget
      title="Resumo do mês"
      to={{ page: 'cashflow' }}
      now={now}
      loading={!flow.data && flow.loading}
      error={flow.error}
      head={
        flow.data && (
          <>
            <div class="big">{brl(flow.data.net, hidden)}</div>
            <div class="muted">
              entrou {brl(flow.data.inflow, hidden)} · saiu {brl(flow.data.outflow, hidden)}
            </div>
          </>
        )
      }
    >
      {size !== 'sm' && (
        <dl class="facts inline">
          <dt>Gastos do mês (por data da compra)</dt>
          <dd>{spend.data ? brl(spend.data.total, hidden) : '…'}</dd>
          <dt>Parte da entrada que sobrou</dt>
          <dd>{kept === null ? '—' : percent(Math.max(kept, -9.99))}</dd>
          <dt>Patrimônio</dt>
          <dd>{worth.data ? <Go page="networth">{brl(worth.data.net, hidden)}</Go> : '…'}</dd>
        </dl>
      )}
    </Widget>
  );
}
