import { api } from '../api.ts';
import { PALETTE, StackBar } from '../charts.tsx';
import { ago, brl, dayMonth, isStale, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { navigate, type Route } from '../router.ts';
import { Go, Loading } from '../ui.tsx';
import { OutlookCommitted, OutlookFacts, OutlookTimeline } from '../widgets/outlook.tsx';
import { CashflowPage } from './cashflow.tsx';
import { NetWorthPage } from './networth.tsx';

const VIEWS = [['balances', 'Saldos'], ['cashflow', 'Fluxo de caixa'], ['networth', 'Patrimônio']] as const;

/** Money in the accounts: today's balances, what came in and went out, and the net worth they are part of. */
export function AccountsPage({ route, now, hidden, view }: { route: Route; now: Date; hidden: boolean; view?: string }) {
  const chosen = view ?? route.params.get('view') ?? 'balances';
  return (
    <div class="page-body">
      <h1 class="page-title">Contas</h1>
      <div class="tabs">
        {VIEWS.map(([id, label]) => (
          <button key={id} class={chosen === id ? 'tab on' : 'tab'} onClick={() => navigate('accounts', id === 'balances' ? {} : { view: id })}>
            {label}
          </button>
        ))}
      </div>
      {chosen === 'cashflow' ? <CashflowPage route={route} now={now} hidden={hidden} embedded /> : chosen === 'networth' ? <NetWorthPage now={now} hidden={hidden} embedded /> : <Balances now={now} hidden={hidden} />}
    </div>
  );
}

function Balances({ now, hidden }: { now: Date; hidden: boolean }) {
  const { data, error, loading } = useLoad(() => api.balances(), []);
  const outlook = useLoad(() => api.outlook(), [], 120_000);
  return (
    <>
      {error || (loading && !data) ? (
        <Loading error={error} />
      ) : data ? (
        <>
          <div class="panel">
            <div class="big">{brl(data.total, hidden)}</div>
            <StackBar parts={data.institutions.map((i, n) => ({ value: Math.max(i.balance, 0), color: PALETTE[n % PALETTE.length]!, label: i.institution }))} />
            {data.institutions.some((i) => i.balance < 0) && <div class="note">Saldo negativo fica fora da barra, mas entra no total: {data.institutions.filter((i) => i.balance < 0).map((i) => i.institution).join(', ')}.</div>}
          </div>
          {outlook.data && (
            <section class="panel">
              <h2>Próximos compromissos</h2>
              <div class="muted">
                {outlook.data.firstUncovered
                  ? `O saldo não cobre ${outlook.data.firstUncovered.name} em ${dayMonth(outlook.data.firstUncovered.day)}: faltam ${brl(outlook.data.firstUncovered.shortfall, hidden)}.`
                  : 'O saldo projetado cobre todos os vencimentos da lista.'}{' '}
                Entradas e contas fixas vêm do que se repete todo mês nas suas contas.
              </div>
              <OutlookFacts data={outlook.data} hidden={hidden} />
              <OutlookTimeline data={outlook.data} hidden={hidden} limit={12} detail />
              <OutlookCommitted data={outlook.data} hidden={hidden} />
            </section>
          )}
          {data.institutions.map((inst, n) => (
            <section class="panel" key={inst.institution}>
              <div class="row-head">
                <h2>
                  <span class="swatch" style={{ background: PALETTE[n % PALETTE.length] }} /> {inst.institution}
                </h2>
                <div>
                  <strong class={inst.balance < 0 ? 'bad-text' : undefined}>{brl(inst.balance, hidden)}</strong> <span class="muted">{percent(inst.share)}</span>
                </div>
              </div>
              <div class={isStale(inst.asOf, now) ? 'asof stale' : 'asof'}>Atualizado {ago(inst.asOf, now)}</div>
              <ul class="rows">
                {data.accounts
                  .filter((a) => a.institution === inst.institution)
                  .map((a) => (
                    <li key={a.id}>
                      <Go class="grow" page="transactions" params={{ accountId: a.id }}>
                        {a.name}
                        {a.last4 ? ` •••• ${a.last4}` : ''}
                      </Go>
                      <strong>{brl(a.balance, hidden)}</strong>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
          <div class="note">
            Contas e cartões que você não usa podem ser ocultados em <Go page="settings">Ajustes</Go>.
          </div>
        </>
      ) : null}
    </>
  );
}
