import { api } from '../api.ts';
import { brl, dayMonth, localDay } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

/**
 * The month in a few numbers. The top figure is only what moved through the bank accounts (card purchases are not in it),
 * so the card side comes from the outlook: bills due by the end of the month and what is left after them.
 */
export function SummaryWidget({ now, hidden, size }: WidgetProps) {
  const today = localDay(now.toISOString());
  const from = `${today.slice(0, 7)}-01`;
  const flow = useLoad(() => api.cashflow(from, today), [from, today], 120_000);
  const spend = useLoad(() => api.spending(from, today, 'category'), [from, today], 120_000);
  const worth = useLoad(() => api.netWorth(), [], 300_000);
  const outlook = useLoad(() => api.outlook(), [], 120_000);
  return (
    <Widget
      title="Resumo do mês"
      to={{ page: 'cashflow' }}
      now={now}
      loading={!flow.data && flow.loading}
      error={flow.error ?? spend.error ?? worth.error ?? outlook.error}
      head={
        flow.data && (
          <>
            <div class="big">{brl(flow.data.net, hidden)}</div>
            {/* A small widget keeps the short reading; the numbers behind it are in the tooltip. */}
            <div class="muted" data-tip={`Entrou ${brl(flow.data.inflow, hidden)}, saiu ${brl(flow.data.outflow, hidden)}`}>
              {size === 'sm' ? 'saldo das contas, sem cartão' : `entrou menos saiu das contas, sem cartão (${brl(flow.data.inflow, hidden)} − ${brl(flow.data.outflow, hidden)})`}
            </div>
          </>
        )
      }
    >
      {size !== 'sm' && (
        <dl class="facts inline">
          <dt>Gastos do mês, contas e cartão (por data da compra)</dt>
          <dd>{spend.data ? brl(spend.data.total, hidden) : '…'}</dd>
          <dt>Faturas que vencem até {outlook.data ? dayMonth(outlook.data.monthEnd) : 'o fim do mês'}</dt>
          <dd>{outlook.data ? brl(outlook.data.dueOut.bills, hidden) : '…'}</dd>
          <dt>Livre para gastar até o fim do mês</dt>
          <dd>{outlook.data ? <Go page="accounts">{brl(outlook.data.free.value, hidden)}</Go> : '…'}</dd>
          <dt>Patrimônio</dt>
          <dd>{worth.data ? <Go page="networth">{brl(worth.data.net, hidden)}</Go> : '…'}</dd>
        </dl>
      )}
    </Widget>
  );
}
