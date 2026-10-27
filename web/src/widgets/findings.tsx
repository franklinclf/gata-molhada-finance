import { api } from '../api.ts';
import { ago } from '../format.ts';
import { rowsFit } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export const KIND_LABEL: Record<string, string> = {
  missing_in_source: 'Falta em uma fonte',
  not_yet_synced: 'Ainda não sincronizada',
  status_conflict: 'Status diferente',
  stale_pending: 'Pendente há muito tempo',
};

export function FindingsWidget({ item, now, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.findings(), [], 120_000);
  const limit = Math.max(rowsFit(item.h, 3), 2);
  const warnings = data?.items.filter((f) => f.severity === 'warning').length ?? 0;
  return (
    <Widget title="Divergências" to={{ page: 'status' }} now={now} loading={loading && !data} error={error}>
      {data && (
        <>
          <div class="big">{data.items.length}</div>
          <div class="muted">{data.items.length === 0 ? 'As fontes concordam entre si' : `${warnings} exigem atenção`}</div>
          {size !== 'sm' && (
            <ul class="rows tall">
              {data.items.slice(0, limit).map((f) => (
                <li key={f.id}>
                  <span class={f.severity === 'warning' ? 'swatch warn' : 'swatch'} />
                  <div class="grow">
                    <div class="clip">{f.summary}</div>
                    <div class="muted">
                      {KIND_LABEL[f.kind] ?? f.kind} · {ago(f.openedAt, now)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {size !== 'sm' && data.items.length > limit && <Go page="status">e mais {data.items.length - limit}</Go>}
        </>
      )}
    </Widget>
  );
}
