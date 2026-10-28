import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { ago, isStale } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function FreshnessWidget({ now, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.freshness(), [], 60_000);
  const stale = data?.sources.filter((s) => isStale(s.lastUpdatedAt, now)).length ?? 0;
  return (
    <Widget
      title="Atualização das fontes"
      to={{ page: 'status' }}
      now={now}
      loading={loading && !data}
      error={error}
      head={
        data && (
          <>
            <div class="big">{stale === 0 ? 'Em dia' : `${stale} atrasada(s)`}</div>
            <div class="muted">{data.sources.length} fontes e instituições acompanhadas</div>
          </>
        )
      }
    >
      {data && size !== 'sm' && (
        <>
          <ul class="rows">
            {data.sources.map((s) => (
              <li key={`${s.sourceId}${s.institution}`}>
                <span class="grow clip">
                  {s.institution} <span class="muted">({s.sourceId})</span>
                </span>
                <span class={isStale(s.lastUpdatedAt, now) ? 'bad-text' : 'muted'}>{ago(s.lastUpdatedAt, now)}</span>
              </li>
            ))}
          </ul>
          <h3>Leituras do mês por banco</h3>
          <ul class="rows">
            {data.quota.map((q) => (
              <li key={q.institutionKey}>
                <div class="grow">
                  <div class="clip">{q.institution}</div>
                  <Meter fraction={q.used / q.limit} tip={`${q.used} de ${q.limit} leituras`} />
                </div>
                <span class={q.level === 'ok' ? 'muted' : 'bad-text'}>
                  {q.used}/{q.limit}
                </span>
              </li>
            ))}
          </ul>
          <Go page="status">Ver detalhes</Go>
        </>
      )}
    </Widget>
  );
}
