import { api } from '../api.ts';
import { Meter, Ring } from '../charts.tsx';
import { brl, dayMonth } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function CardsWidget({ now, hidden }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.cards(), [], 120_000);
  return (
    <Widget title="Cartões e limite" asOf={data?.oldestDataAt} now={now} loading={loading && !data} error={error}>
      {data && (
        <>
          <div class="split">
            <Ring segments={[{ value: data.totals.used, color: 'var(--accent)' }, { value: data.totals.available, color: 'transparent' }]}>
              <span class="muted">usado</span>
              <strong>{data.totals.creditLimit > 0 ? `${Math.round((data.totals.used / data.totals.creditLimit) * 100)}%` : '–'}</strong>
            </Ring>
            <div>
              <div class="muted">Fatura em aberto</div>
              <div class="big">{brl(data.totals.cycleTotal, hidden)}</div>
              <div class="muted">Disponível {brl(data.totals.available, hidden)} de {brl(data.totals.creditLimit, hidden)}</div>
            </div>
          </div>
          <ul class="rows tall">
            {data.cards.map((c) => (
              <li key={c.id}>
                <div class="grow">
                  <div>
                    {c.institution} {c.name}
                    {c.last4 ? ` •••• ${c.last4}` : ''}
                  </div>
                  <Meter fraction={c.creditLimit ? (c.creditLimit - (c.availableLimit ?? c.creditLimit - c.balance)) / c.creditLimit : 0} />
                  <div class="muted">{c.nextDueDate ? `Vence em ${dayMonth(c.nextDueDate)}` : 'Sem vencimento informado'}</div>
                </div>
                <strong>{brl(c.total, hidden)}</strong>
              </li>
            ))}
          </ul>
          {data.limitGroups.length > 0 && <div class="note">{data.limitGroups.length} grupo(s) de limite compartilhado, contado(s) uma vez no total.</div>}
        </>
      )}
    </Widget>
  );
}
