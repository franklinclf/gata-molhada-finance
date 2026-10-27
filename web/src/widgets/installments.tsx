import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { brl } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function InstallmentsWidget({ now, hidden }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.installments(), [], 300_000);
  return (
    <Widget title="Parcelas" asOf={data?.oldestDataAt} now={now} loading={loading && !data} error={error}>
      {data && (
        <>
          <div class="pair">
            <div>
              <span class="muted">Comprometido por mês</span>
              <strong>{brl(data.monthlyCommitment, hidden)}</strong>
            </div>
            <div>
              <span class="muted">Restante</span>
              <strong>{brl(data.remainingTotal, hidden)}</strong>
            </div>
          </div>
          {data.items.length === 0 ? (
            <div class="empty">Nenhuma compra parcelada em andamento</div>
          ) : (
            <ul class="rows tall">
              {data.items.slice(0, 8).map((i) => (
                <li key={`${i.accountId}${i.description}${i.total}${i.installmentAmount}`}>
                  <div class="grow">
                    <div class="clip">{i.description}</div>
                    <Meter fraction={i.number / i.total} />
                    <div class="muted">
                      {i.number} de {i.total}, última em {i.lastMonth.slice(5)}/{i.lastMonth.slice(0, 4)}
                    </div>
                  </div>
                  <strong>{brl(i.installmentAmount, hidden)}</strong>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Widget>
  );
}
