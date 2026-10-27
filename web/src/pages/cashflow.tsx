import { api } from '../api.ts';
import { Bars, DayDots } from '../charts.tsx';
import { brl, dayMonth, localDay } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { PeriodPicker, PRESETS } from '../period.tsx';
import { patchParams, type Route } from '../router.ts';
import { Go, Loading, TxRow } from '../ui.tsx';

export function CashflowPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const today = localDay(now.toISOString());
  const month = PRESETS.find((p) => p.id === 'month')!.range(today);
  const from = route.params.get('from') ?? month.from;
  const to = route.params.get('to') ?? month.to;
  const tab = route.params.get('tab') ?? 'all';
  const flow = useLoad(() => api.cashflow(from, to), [from, to]);
  const banks = useLoad(() => api.balances(), []);
  const ids = banks.data?.accounts.map((a) => a.id) ?? [];

  const query = new URLSearchParams({ from, to, limit: '30', sort: 'amount_desc', hideOwnTransfers: 'true' });
  for (const id of ids) query.append('accountId', id);
  if (tab !== 'all') query.set('kind', tab === 'in' ? 'income' : 'expense');
  const list = useLoad(() => (ids.length > 0 ? api.explore(query) : Promise.resolve(null)), [query.toString()]);

  const weekly = new Map<string, { inflow: number; outflow: number }>();
  for (const d of flow.data?.days ?? []) {
    const week = d.day.slice(0, 7);
    const row = weekly.get(week) ?? { inflow: 0, outflow: 0 };
    row.inflow += d.inflow;
    row.outflow += d.outflow;
    weekly.set(week, row);
  }

  return (
    <div class="page-body">
      <h1 class="page-title">Fluxo de caixa</h1>
      <PeriodPicker from={from} to={to} now={now} onChange={(r) => patchParams({ from: r.from ?? month.from, to: r.to ?? month.to })} />
      {flow.error || (flow.loading && !flow.data) ? (
        <Loading error={flow.error} />
      ) : flow.data ? (
        <>
          <div class="summary">
            <div>
              <span class="muted">Saldo do período</span>
              <strong>{brl(flow.data.net, hidden)}</strong>
            </div>
            <div>
              <span class="muted">Entradas</span>
              <strong class="good-text">{brl(flow.data.inflow, hidden)}</strong>
            </div>
            <div>
              <span class="muted">Saídas</span>
              <strong class="bad-text">{brl(flow.data.outflow, hidden)}</strong>
            </div>
          </div>
          <div class="panel">
            <DayDots days={flow.data.days} from={flow.data.from} to={flow.data.to} />
            {weekly.size > 1 && (
              <>
                <h3>Por mês</h3>
                <Bars hidden={hidden} data={[...weekly].flatMap(([m, v]) => [{ label: `${m.slice(5)}↑`, value: v.inflow, color: 'var(--good)' }, { label: `${m.slice(5)}↓`, value: v.outflow, color: 'var(--bad)' }])} />
              </>
            )}
            <div class="note">Considera só o dinheiro que entra e sai das contas. Compras no cartão entram quando a fatura é paga. Transferências entre suas contas ficam de fora.</div>
          </div>
          <div class="tabs">
            {[['all', 'Tudo'], ['in', 'Entradas'], ['out', 'Saídas']].map(([id, label]) => (
              <button key={id} class={tab === id ? 'tab on' : 'tab'} onClick={() => patchParams({ tab: id === 'all' ? null : id })}>
                {label}
              </button>
            ))}
          </div>
          <div class="panel">
            {!list.data ? (
              ids.length === 0 && banks.data ? <div class="empty">Nenhuma conta bancária visível.</div> : <Loading error={list.error} />
            ) : (
              <>
                <ul class="rows tall tx-list">
                  {list.data.items.map((t) => (
                    <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} />
                  ))}
                </ul>
                <Go page="transactions" params={{ from, to, hideOwnTransfers: 'true', ...(tab !== 'all' ? { kind: tab === 'in' ? 'income' : 'expense' } : {}) }}>
                  Ver todas ({list.data.total}) em Transações
                </Go>
                <div class="muted">Primeiro dia do período: {dayMonth(from)}</div>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
