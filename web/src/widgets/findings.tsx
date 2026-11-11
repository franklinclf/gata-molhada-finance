import { api } from '../api.ts';
import { billsToCheck } from '../bill-check.ts';
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
  const bills = useLoad(() => api.billCheck(), [], 120_000);
  const billCount = bills.data ? billsToCheck(bills.data) : 0;
  const total = (data?.items.length ?? 0) + billCount;
  return (
    <Widget
      title="Para conferir"
      to={{ page: 'status' }}
      now={now}
      loading={loading && !data}
      error={error}
      empty={data && bills.data && total === 0 ? 'Nada para conferir' : undefined}
      head={
        data && (
          <>
            <div class="big count">{total} <small>{total === 1 ? 'item' : 'itens'}</small></div>
            <div class="muted">
              {total === 0
                ? 'Nada para conferir'
                : [data.items.length > 0 ? `${data.items.length} ${data.items.length === 1 ? 'registro que pode ser o mesmo' : 'registros que podem ser o mesmo'}, em fontes diferentes` : '', billCount > 0 ? `${billCount} ${billCount === 1 ? 'fatura que não fecha' : 'faturas que não fecham'}` : ''].filter(Boolean).join(' · ')}
            </div>
          </>
        )
      }
    >
      {billCount > 0 && size !== 'sm' && (
        <Go page="cards" params={{ tab: 'check' }}>
          Ver as {billCount} {billCount === 1 ? 'fatura' : 'faturas'} em Cartões, aba Conferir
        </Go>
      )}
      {data && size !== 'sm' && data.items.length > 0 && (
        <>
          <FitList
            class="rows tall"
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
