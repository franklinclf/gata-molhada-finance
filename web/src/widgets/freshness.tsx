import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { ago } from '../format.ts';
import { oldestFirst } from '../freshness-order.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function FreshnessWidget({ now, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.freshness(), [], 60_000);
  const stale = data?.sources.filter((s) => s.late).length ?? 0;
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
            <div class="big">{stale === 0 ? 'Em dia' : `${stale} ${stale === 1 ? 'atrasada' : 'atrasadas'}`}</div>
            <div class="muted">{data.sources.length} fontes e instituições acompanhadas</div>
          </>
        )
      }
    >
      {data && size !== 'sm' && (
        <>
          {/* The one place where the age of the data is listed: each source with its last reading, the oldest first. The list scrolls with the widget. */}
          <ul class="rows tall">
            {oldestFirst(data.sources).map((s) => (
              <li key={`${s.sourceId}${s.institution}`}>
                <span class="grow clip">
                  {s.institution} <span class="muted">({s.sourceId})</span>
                </span>
                {s.late && <span class="badge bad">atrasada</span>}
                <span class={s.late ? 'bad-text' : 'muted'} data-tip={s.lastUpdatedAt ?? undefined}>
                  {ago(s.lastUpdatedAt, now)}
                </span>
              </li>
            ))}
          </ul>
          {data.quota.length > 0 && (
            <ul class="rows tall">
              <li class="list-title">Leituras do mês por banco</li>
              {data.quota.map((q) => (
                <li key={q.institutionKey}>
                  <div class="grow">
                    <div class="clip">{q.institution}</div>
                    <Meter fraction={q.used / q.limit} tip={`${q.used} de ${q.limit} leituras`} />
                  </div>
                  <span class={q.level === 'ok' ? 'muted' : 'bad-text'} data-tip={`${q.used} de ${q.limit} leituras usadas neste mês`}>
                    {q.used} de {q.limit}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Widget>
  );
}
