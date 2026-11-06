import { api } from '../api.ts';
import { ago, maskMoney } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams } from '../router.ts';
import { Go } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export const KIND_LABEL: Record<string, string> = {
  possible_match: 'Possível duplicata entre fontes',
};

export function FindingsWidget({ now, size, hidden }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.findings(), [], 120_000);
  return (
    <Widget
      title="Para conferir"
      to={{ page: 'status' }}
      now={now}
      loading={loading && !data}
      error={error}
      head={
        data && (
          <>
            <div class="big">{data.items.length}</div>
            <div class="muted">{data.items.length === 0 ? 'Nada para conferir' : 'registros que podem ser o mesmo, em fontes diferentes'}</div>
          </>
        )
      }
    >
      {data && size !== 'sm' && data.items.length > 0 && (
        <>
          <FitList
            class="rows tall"
            noun={['registro', 'registros']}
            rows={data.items.map((f) => (
              <li key={f.id} class="tx" data-no-nav onClick={() => patchParams({ tx: f.transactionId })} tabIndex={0}>
                <span class={f.severity === 'warning' ? 'swatch warn' : 'swatch'} />
                <div class="grow">
                  <div class="clip">{maskMoney(f.summary, hidden)}</div>
                  <div class="muted">
                    {KIND_LABEL[f.kind] ?? f.kind} · {ago(f.openedAt, now)}
                  </div>
                </div>
              </li>
            ))}
          />
          <Go page="status">Resolver na tela de conferência</Go>
        </>
      )}
    </Widget>
  );
}
