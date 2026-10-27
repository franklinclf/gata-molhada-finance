import { api } from '../api.ts';
import { ago } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

const KIND_LABEL: Record<string, string> = {
  missing_in_source: 'Falta em uma fonte',
  not_yet_synced: 'Ainda não sincronizada',
  status_conflict: 'Status diferente',
  stale_pending: 'Pendente há muito tempo',
};

export function FindingsWidget({ now }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.findings(), [], 120_000);
  return (
    <Widget title="Divergências abertas" now={now} loading={loading && !data} error={error}>
      {data && (data.items.length === 0 ? <div class="empty">As fontes concordam entre si</div> : (
        <ul class="rows tall">
          {data.items.slice(0, 12).map((f) => (
            <li key={f.id}>
              <span class={f.severity === 'warning' ? 'swatch warn' : 'swatch'} />
              <div class="grow">
                <div class="clip">{f.summary}</div>
                <div class="muted">{KIND_LABEL[f.kind] ?? f.kind} · {ago(f.openedAt, now)}</div>
              </div>
            </li>
          ))}
          {data.items.length > 12 && <li class="muted">e mais {data.items.length - 12}</li>}
        </ul>
      ))}
    </Widget>
  );
}
