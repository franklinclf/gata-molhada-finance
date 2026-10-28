import { api } from '../api.ts';
import { periodRange } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams } from '../router.ts';
import { Go, TxRow } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function RecentWidget({ now, hidden, size }: WidgetProps) {
  const range = periodRange('3m', now);
  const { data, error, loading } = useLoad(() => api.transactions(range.from, range.to, 40), [range.from, range.to], 120_000);
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
          <ul class="rows tall tx-list">
            {data.items.slice(0, size === 'sm' ? 4 : 40).map((t) => (
              <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} />
            ))}
          </ul>
          {size !== 'sm' && <Go page="transactions">Ver todas ({data.total})</Go>}
        </>
      )}
    </Widget>
  );
}
