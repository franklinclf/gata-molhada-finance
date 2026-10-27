import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { brl, monthName } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function InstallmentsWidget({ item, now, hidden, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.installments(), [], 300_000);
  const limit = 60;
  return (
    <Widget title="Parcelas" to={{ page: 'cards', params: { tab: 'installments' } }} asOf={data?.oldestDataAt} now={now} loading={loading && !data} error={error}>
      {data && (
        <>
          <div class="big">{brl(data.monthlyCommitment, hidden)}</div>
          <div class="muted">por mês · {brl(data.remainingTotal, hidden)} restante · {data.items.length} compras</div>
          {size !== 'sm' &&
            (data.items.length === 0 ? (
              <div class="empty">Nenhuma compra parcelada em andamento</div>
            ) : (
              <ul class="rows tall">
                {data.items.slice(0, limit).map((i) => (
                  <li key={`${i.accountId}${i.description}${i.total}${i.installmentAmount}`}>
                    <div class="grow">
                      <Go class="clip" page="transactions" params={{ q: i.description, accountId: i.accountId }}>
                        {i.description}
                      </Go>
                      <Meter fraction={i.number / i.total} />
                      <div class="muted">
                        {i.number} de {i.total} · última em {monthName(i.lastMonth)}
                      </div>
                    </div>
                    <strong>{brl(i.installmentAmount, hidden)}</strong>
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}
    </Widget>
  );
}
