import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { brl, dayMonth } from '../format.ts';
import { shareLabel } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function GoalsWidget({ now, hidden, size, pixels }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.goals(), [], 300_000);
  const active = data?.items.filter((g) => !g.archived) ?? [];
  const achieved = active.filter((g) => g.status === 'achieved').length;
  // With room, each goal also says how much is missing, by when, and how much to put aside per month.
  const detailed = size === 'lg' || (pixels !== undefined && pixels.height >= 400);
  return (
    <Widget
      title="Metas"
      to={{ page: 'goals' }}
      now={now}
      loading={loading && !data}
      error={error}
      empty={data && active.length === 0 ? 'Nenhuma meta. Clique para criar.' : undefined}
      head={
        data &&
        (active.length === 0 ? (
          <div class="muted">Nenhuma meta. Abra para criar.</div>
        ) : (
          <>
            <div class="big">
              {achieved} de {active.length}
            </div>
            <div class="muted">{active.length === 1 ? 'meta atingida' : 'metas atingidas'}</div>
          </>
        ))
      }
    >
      {(size !== 'sm' || (pixels !== undefined && pixels.height >= 170)) && active.length > 0 && (
        <FitList
          class="rows tall"
          rows={active.map((g) => (
            <li key={g.id} class="budget-line">
              <div class="budget-head">
                <Go class="grow clip" page="goals">
                  {g.name}
                </Go>
                <span class="muted">{shareLabel(g.progress)}</span>
                <strong>{brl(g.current, hidden)}</strong>
              </div>
              <Meter fraction={g.progress} color="var(--good)" />
              {detailed && g.status !== 'achieved' && (
                <div class="muted clip">
                  faltam {brl(g.remaining, hidden)}
                  {g.targetDay ? ` até ${dayMonth(g.targetDay)}/${g.targetDay.slice(0, 4)}` : ''}
                  {g.requiredMonthly !== null ? ` · ${brl(g.requiredMonthly, hidden)} por mês` : ''}
                </div>
              )}
            </li>
          ))}
        />
      )}
    </Widget>
  );
}
