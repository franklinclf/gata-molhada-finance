import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { brl, localDay } from '../format.ts';
import { shareLabel } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function BudgetWidget({ now, hidden, size, pixels }: WidgetProps) {
  const month = localDay(now.toISOString()).slice(0, 7);
  const { data, error, loading } = useLoad(() => api.budgets(month), [month], 120_000);
  // Most used first, so the lines that went over lead the list.
  const budgeted = (data?.lines.filter((l) => l.budget !== null) ?? []).sort((a, b) => (b.used ?? 0) - (a.used ?? 0));
  // The total can hide a line that went over behind others that have room, so the figure is summed per line.
  const overAmount = budgeted.reduce((sum, l) => sum + Math.max(0, l.actual - (l.budget ?? 0)), 0);
  const remaining = budgeted.reduce((sum, l) => sum + Math.max(0, (l.budget ?? 0) - l.actual), 0);
  const over = budgeted.filter((l) => l.actual > (l.budget ?? 0)).length;
  const detailed = size === 'lg' || (pixels !== undefined && budgeted.length * 48 <= pixels.height - 215);
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
            {over > 0 ? <div class="big bad-text">{brl(overAmount, hidden)}</div> : <div class="big">{brl(remaining, hidden)}</div>}
            <div class="muted">
              {over > 0
                ? `acima do limite em ${over} ${over === 1 ? 'categoria' : 'categorias'} · restam ${brl(remaining, hidden)} nas outras`
                : `sobram de ${brl(data.totals.budget, hidden)} · nenhum acima do limite`}
            </div>
            <Meter fraction={data.totals.budget > 0 ? data.totals.actual / data.totals.budget : 0} />
          </>
        ))
      }
    >
      {(size !== 'sm' || (pixels !== undefined && pixels.height >= 170)) && budgeted.length > 0 && (
        <FitList
          rows={budgeted.map((l) => {
            const passed = l.budget !== null && l.actual > l.budget;
            const figure = passed ? <span class="bad-text">passou {brl(l.actual - l.budget!, hidden)}</span> : <span class="muted">{shareLabel(l.used ?? 0)}</span>;
            return detailed ? (
              <li key={`${l.scope}${l.name}`} class="budget-line">
                <div class="budget-head">
                  <Go class="grow clip" page="budgets" params={{ month }}>
                    {l.name}
                  </Go>
                  {figure}
                  <strong>{brl(l.actual, hidden)}</strong>
                </div>
                <Meter fraction={l.used ?? 0} />
              </li>
            ) : (
              <li key={`${l.scope}${l.name}`}>
                <Go class="grow clip" page="budgets" params={{ month }}>
                  {l.name}
                </Go>
                {figure}
                <strong>{brl(l.actual, hidden)}</strong>
              </li>
            );
          })}
        />
      )}
    </Widget>
  );
}
