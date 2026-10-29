import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { brl, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function GoalsWidget({ now, hidden, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.goals(), [], 300_000);
  const active = data?.items.filter((g) => !g.archived) ?? [];
  return (
    <Widget
      title="Metas"
      to={{ page: 'goals' }}
      now={now}
      loading={loading && !data}
      error={error}
      head={data && (active.length === 0 ? <div class="muted">Nenhuma meta. Abra para criar.</div> : <div class="muted">{active.filter((g) => g.status === 'achieved').length} de {active.length} atingidas</div>)}
    >
      {size !== 'sm' && (
        <ul class="rows tall">
          {active.slice(0, size === 'lg' ? 6 : 3).map((g) => (
            <li key={g.id} class="budget-line">
              <div class="budget-head">
                <Go class="grow clip" page="goals">
                  {g.name}
                </Go>
                <span class="muted">{percent(g.progress)}</span>
                <strong>{brl(g.current, hidden)}</strong>
              </div>
              <Meter fraction={g.progress} color="var(--good)" />
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
