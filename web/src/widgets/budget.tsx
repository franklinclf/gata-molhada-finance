import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { brl, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function BudgetWidget({ now, hidden, size }: WidgetProps) {
  const month = new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 7);
  const { data, error, loading } = useLoad(() => api.budgets(month), [month], 120_000);
  const budgeted = data?.lines.filter((l) => l.budget !== null) ?? [];
  return (
    <Widget
      title="Orçamento"
      to={{ page: 'budgets', params: { month } }}
      now={now}
      loading={loading && !data}
      error={error}
      head={
        data &&
        (budgeted.length === 0 ? (
          <div class="muted">Nenhum orçamento neste mês. Abra para criar.</div>
        ) : (
          <>
            <div class="big">{brl(Math.max(0, data.totals.budget - data.totals.actual), hidden)}</div>
            <div class="muted">
              sobram de {brl(data.totals.budget, hidden)} · {data.totals.over > 0 ? `${data.totals.over} acima do limite` : 'nenhum acima do limite'}
            </div>
            <Meter fraction={data.totals.budget > 0 ? data.totals.actual / data.totals.budget : 0} />
          </>
        ))
      }
    >
      {size !== 'sm' && budgeted.length > 0 && (
        <ul class="rows">
          {budgeted.slice(0, size === 'lg' ? 10 : 5).map((l) => (
            <li key={`${l.scope}${l.name}`}>
              <Go class="grow clip" page="budgets" params={{ month }}>
                {l.name}
              </Go>
              <span class={l.used !== null && l.used > 1 ? 'bad-text' : 'muted'}>{percent(l.used ?? 0)}</span>
              <strong>{brl(l.actual, hidden)}</strong>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
