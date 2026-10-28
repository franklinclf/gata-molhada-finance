import { api } from '../api.ts';
import { brl } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { MonthBars, PurchaseRow } from '../installments.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function InstallmentsWidget({ now, hidden, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.installments(), [], 300_000);
  const active = data?.purchases.filter((p) => !p.finished) ?? [];
  return (
    <Widget
      title="Parcelas"
      to={{ page: 'cards', params: { tab: 'installments' } }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      head={
        data && (
          <>
            <div class="big">{brl(data.thisCycle, hidden)}</div>
            <div class="muted">
              neste ciclo · {brl(data.nextCycle, hidden)} no próximo · {brl(data.remainingTotal, hidden)} a pagar no total
            </div>
            {size !== 'sm' && <MonthBars months={data.months.filter((m) => m.future + m.open + m.billed > 0).slice(0, size === 'lg' ? 12 : 6)} hidden={hidden} height={size === 'lg' ? 100 : 76} />}
          </>
        )
      }
    >
      {data && size !== 'sm' &&
        (active.length === 0 ? (
          <div class="empty">Nenhuma compra parcelada em andamento</div>
        ) : (
          <ul class="rows tall purchases">
            {active.map((p) => (
              <PurchaseRow key={p.id} p={p} hidden={hidden} />
            ))}
          </ul>
        ))}
    </Widget>
  );
}
