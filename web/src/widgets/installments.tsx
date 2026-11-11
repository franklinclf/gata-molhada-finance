import { api } from '../api.ts';
import { brl } from '../format.ts';
import { chartHeight } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { MonthBars, PurchaseRow } from '../installments.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function InstallmentsWidget({ now, hidden, size, pixels }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.installments(), [], 300_000);
  const active = data?.purchases.filter((p) => !p.finished) ?? [];
  // A wider widget shows more months; a taller one lets the chart grow while the list keeps most of the room.
  const months = Math.max(4, Math.min(12, Math.floor((pixels?.width ?? 380) / 56)));
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
              nesta fatura · {brl(data.nextCycle, hidden)} no próximo · {brl(data.remainingTotal, hidden)} a pagar no total
            </div>
            {size !== 'sm' && (pixels === undefined || pixels.height >= 400) && <MonthBars months={data.months.filter((m) => m.future + m.open + m.billed > 0).slice(0, months)} hidden={hidden} height={chartHeight(pixels, 430, 76, 140)} />}
          </>
        )
      }
    >
      {data && size !== 'sm' &&
        (active.length === 0 ? (
          <div class="empty">Nenhuma compra parcelada em andamento</div>
        ) : (
          <FitList class="rows tall purchases" rows={active.map((p) => <PurchaseRow key={p.id} p={p} hidden={hidden} />)} />
        ))}
    </Widget>
  );
}
