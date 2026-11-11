import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { ExplorerResult } from '../api.ts';
import { periodRange } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams } from '../router.ts';
import { TxRow } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

/** Rows asked for when the widget opens, and in each batch after the "+N transações" button is used (the API allows 500 at most). */
const FIRST = 60;
const BATCH = 200;

export function RecentWidget({ now, hidden, size }: WidgetProps) {
  const range = periodRange('3m', now);
  const period = `${range.from}${range.to}`;
  const { data, error, loading } = useLoad(() => api.transactions(range.from, range.to, FIRST), [range.from, range.to], 120_000);
  // Batches loaded after the first page, in order, kept while the period stays the same (a refresh of the first page does not drop them).
  const [more, setMore] = useState<{ stamp: string; items: ExplorerResult['items'] }>({ stamp: '', items: [] });
  const [busy, setBusy] = useState(false);
  const extra = data && more.stamp === period ? more.items : [];
  const first = new Set(data?.items.map((t) => t.id));
  const items = data ? [...data.items, ...extra.filter((t) => !first.has(t.id))] : [];
  const loadMore = () => {
    if (!data || busy) return;
    setBusy(true);
    api
      .transactions(range.from, range.to, BATCH, items.length)
      .then((next) => setMore({ stamp: period, items: [...extra, ...next.items] }))
      .catch(() => {})
      .finally(() => setBusy(false));
  };
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
        <FitList
          class="rows tall tx-list"
          unloaded={Math.max(0, data.total - items.length)}
          loadMore={loadMore}
          loadingMore={busy}
          rows={items.map((t) => <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} />)}
        />
      )}
    </Widget>
  );
}
