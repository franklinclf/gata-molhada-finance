import { api } from '../api.ts';
import { Sparkline } from '../charts.tsx';
import { brl, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

/** The categories whose spending this month is furthest above their average of the closed months. */
export function TrendWidget({ now, hidden, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.spendingTrend(6), [], 300_000);
  const rows = (data?.rows ?? [])
    .filter((r) => r.average > 0 && r.current > r.average * 1.25 && r.current - r.average >= 2000)
    .sort((a, b) => b.current - b.average - (a.current - a.average))
    .slice(0, size === 'lg' ? 8 : 4);
  return (
    <Widget title="Maiores altas" to={{ page: 'spending', params: { by: 'trend' } }} now={now} loading={loading && !data} error={error} head={data && <div class="muted">categorias bem acima da média dos meses fechados</div>}>
      <ul class="rows tall">
        {rows.map((r) => (
          <li key={r.name}>
            <Go class="grow clip" page="spending" params={{ by: 'trend' }}>
              {r.name}
            </Go>
            {size !== 'sm' && <Sparkline points={r.points} />}
            <strong>{brl(r.current, hidden)}</strong>
            <span class="bad-text">▲ {percent(r.current / r.average - 1)}</span>
          </li>
        ))}
        {data && rows.length === 0 && <li class="empty">Nenhuma categoria muito acima da média.</li>}
      </ul>
    </Widget>
  );
}
