import { api } from '../api.ts';
import { PALETTE, StackBar } from '../charts.tsx';
import { ago, brl, isStale, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go, Loading } from '../ui.tsx';

export function AccountsPage({ now, hidden }: { now: Date; hidden: boolean }) {
  const { data, error, loading } = useLoad(() => api.balances(), []);
  return (
    <div class="page-body">
      <h1 class="page-title">Saldo em contas</h1>
      {error || (loading && !data) ? (
        <Loading error={error} />
      ) : data ? (
        <>
          <div class="panel">
            <div class="big">{brl(data.total, hidden)}</div>
            <StackBar parts={data.institutions.map((i, n) => ({ value: Math.max(i.balance, 0), color: PALETTE[n % PALETTE.length]!, label: i.institution }))} />
          </div>
          {data.institutions.map((inst, n) => (
            <section class="panel" key={inst.institution}>
              <div class="row-head">
                <h2>
                  <span class="swatch" style={{ background: PALETTE[n % PALETTE.length] }} /> {inst.institution}
                </h2>
                <div>
                  <strong>{brl(inst.balance, hidden)}</strong> <span class="muted">{percent(inst.share)}</span>
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
    </div>
  );
}
