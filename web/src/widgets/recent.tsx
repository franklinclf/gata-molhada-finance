import { api } from '../api.ts';
import { brl, dayMonth, localDay, periodRange } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

const STATE_LABEL: Record<string, string> = { single_source: 'uma fonte', conflict: 'conflito', stale_pending: 'pendente antiga' };

export function RecentWidget({ now, hidden }: WidgetProps) {
  const range = periodRange('3m', now);
  const { data, error, loading } = useLoad(() => api.transactions(range.from, range.to, 10), [range.from, range.to], 120_000);
  return (
    <Widget title="Transações recentes" asOf={data?.oldestDataAt} now={now} loading={loading && !data} error={error}>
      {data && (
        <ul class="rows tall">
          {data.items.map((t) => {
            const account = t.account;
            return (
              <li key={t.id}>
                <div class="grow">
                  <div class="clip">{t.description}</div>
                  <div class="muted clip">
                    {dayMonth(localDay(t.occurredAt))} · {account ? `${account.institution}${account.last4 ? ` •••• ${account.last4}` : ''}` : ''}
                    {t.status === 'pending' ? ' · pendente' : ''}
                    {STATE_LABEL[t.state] ? ` · ${STATE_LABEL[t.state]}` : ''}
                  </div>
                </div>
                <strong class={t.amount >= 0 ? 'good-text' : ''}>{brl(t.amount, hidden)}</strong>
              </li>
            );
          })}
        </ul>
      )}
    </Widget>
  );
}
