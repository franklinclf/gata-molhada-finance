import { api } from '../api.ts';
import { brl, monthName, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

/** A rise smaller than this (R$ 20) is noise, not news. */
const MIN_RISE = 2000;

/** The categories that rose most against the same days of last month, with the merchants behind each rise. */
export function TrendWidget({ now, hidden, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.spendingCompare(), [], 300_000);
  // A small widget shows the biggest rise; a larger one lists every rise and fits as many as the height allows, the rest open in place.
  const limit = size === 'sm' ? 1 : 40;
  const rises = (data?.categories ?? []).filter((l) => l.delta >= MIN_RISE).slice(0, limit);
  const drivers = new Map((data?.drivers ?? []).map((d) => [d.category, d.merchants]));
  const prevName = data ? monthName(data.previous.from.slice(0, 7)) : '';
  const day = data ? Number(data.to.slice(8, 10)) : 0;
  const link = (name: string) => ({ category: name, from: data?.from, to: data?.to, netSpending: 'true' });
  return (
    <Widget
      title="Maiores altas"
      to={{ page: 'spending', params: { by: 'trend' } }}
      now={now}
      loading={loading && !data}
      error={error}
      empty={data && rises.length === 0 ? `Sem altas contra ${prevName}` : undefined}
      head={data && <div class="muted">vs. mesmos dias de {prevName}</div>}
    >
      <FitList
        class="rows tall"
        rows={[
          ...rises.map((r) => {
            const top = size === 'sm' ? undefined : drivers.get(r.name)?.[0];
            return (
              <li key={r.name} class={size === 'sm' ? undefined : 'trend-widget-row'}>
                <span class="grow clip">
                  <Go page="transactions" params={link(r.name)}>
                    {r.name}
                  </Go>
                  {top && <span class="muted"> · por {top.name}</span>}
                </span>
                <strong>{brl(r.delta, hidden)}</strong>
                <span class="bad-text">{r.previous > 0 ? `▲ ${percent(r.current / r.previous - 1)}` : 'novo'}</span>
              </li>
            );
          }),
          ...(data && rises.length === 0 ? [<li key="none" class="empty">Nenhuma categoria gastou bem mais que no mesmo trecho de {prevName}.</li>] : []),
        ]}
      />
      {data && size === 'lg' && (
        <div class="muted trend-widget-total">
          Total até o dia {day}: {brl(data.total.current, hidden)}, {brl(Math.abs(data.total.delta), hidden)} {data.total.delta >= 0 ? 'a mais' : 'a menos'} que em {prevName}.
        </div>
      )}
    </Widget>
  );
}
