import { api } from '../api.ts';
import { brl, dayMonth } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

const DAYS_AHEAD = 14;

/** What is expected to leave or arrive in the next two weeks: card bills on their due day and recurring items. */
export function UpcomingWidget({ now, hidden, size }: WidgetProps) {
  const month = new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)).toISOString().slice(0, 7);
  const a = useLoad(() => api.calendar(month), [month], 300_000);
  const b = useLoad(() => api.calendar(next), [next], 300_000);
  const today = a.data?.today ?? '';
  const limit = today ? new Date(Date.parse(`${today}T00:00:00Z`) + DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10) : '';
  const items = [...(a.data?.days ?? []), ...(b.data?.days ?? [])].flatMap((d) => d.projected.map((p) => ({ ...p, day: d.day }))).filter((p) => p.day >= today && p.day <= limit);
  const out = items.filter((p) => p.direction === 'out').reduce((s, p) => s + p.amount, 0);
  const inn = items.filter((p) => p.direction === 'in').reduce((s, p) => s + p.amount, 0);
  return (
    <Widget
      title="Próximos 14 dias"
      to={{ page: 'calendar' }}
      now={now}
      loading={!a.data && a.loading}
      error={a.error}
      head={
        a.data && (
          <>
            <div class="big">{brl(out, hidden)}</div>
            <div class="muted">
              a pagar{inn > 0 ? ` · ${brl(inn, hidden)} a receber` : ''} · {items.length} {items.length === 1 ? 'item' : 'itens'}
            </div>
          </>
        )
      }
    >
      {size !== 'sm' && (
        <ul class="rows tall">
          {items.slice(0, size === 'lg' ? 12 : 6).map((p, i) => (
            <li key={i}>
              <span class="muted">{dayMonth(p.day)}</span>
              <span class="grow clip">
                {p.name} {p.late && <span class="badge bad">atrasado</span>}
              </span>
              <strong class={p.direction === 'in' ? 'good-text' : ''}>
                {p.direction === 'in' ? '+' : '−'}
                {brl(p.amount, hidden)}
              </strong>
            </li>
          ))}
          {items.length === 0 && a.data && <li class="empty">Nada esperado nos próximos dias.</li>}
        </ul>
      )}
    </Widget>
  );
}
