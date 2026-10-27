import { api } from '../api.ts';
import { Meter } from '../charts.tsx';
import { ago, isStale } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function FreshnessWidget({ now }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.freshness(), [], 60_000);
  return (
    <Widget title="Atualização das fontes" now={now} loading={loading && !data} error={error}>
      {data && (
        <>
          <ul class="rows">
            {data.sources.length === 0 && <li class="muted">Nenhuma sincronização registrada</li>}
            {data.sources.map((s) => (
              <li key={`${s.sourceId}${s.institution}`}>
                <span class="grow">
                  {s.institution} <span class="muted">({s.sourceId})</span>
                </span>
                <span class={isStale(s.lastUpdatedAt, now) ? 'bad-text' : 'muted'}>{ago(s.lastUpdatedAt, now)}</span>
              </li>
            ))}
          </ul>
          <h3>Limite mensal de leituras no banco</h3>
          <ul class="rows">
            {data.quota.map((q) => (
              <li key={q.institutionKey}>
                <div class="grow">
                  <div>{q.institution}</div>
                  <Meter fraction={q.used / q.limit} />
                </div>
                <span class={q.level === 'ok' ? 'muted' : 'bad-text'}>{q.used}/{q.limit}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Widget>
  );
}
