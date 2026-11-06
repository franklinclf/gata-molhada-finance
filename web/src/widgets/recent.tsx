import { api } from '../api.ts';
import { periodRange } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams } from '../router.ts';
import { Go, TxRow } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function RecentWidget({ now, hidden, size }: WidgetProps) {
  const range = periodRange('3m', now);
  const { data, error, loading } = useLoad(() => api.transactions(range.from, range.to, 60), [range.from, range.to], 120_000);
  return (
    <Widget
      title="Transações recentes"
      to={{ page: 'transactions' }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      head={data && size !== 'sm' && <div class="muted">{data.total} transações em 3 meses · mais recentes primeiro</div>}
    >
      {data && (
        <>
          <FitList class="rows tall tx-list" noun={['transação', 'transações']} rows={data.items.map((t) => <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} />)} />
          {size !== 'sm' && <Go page="transactions">Ver todas ({data.total})</Go>}
        </>
      )}
    </Widget>
  );
}
