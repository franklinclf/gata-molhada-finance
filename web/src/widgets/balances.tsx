import { api } from '../api.ts';
import { PALETTE, Ring, StackBar } from '../charts.tsx';
import { brl } from '../format.ts';
import { shareLabel } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

/** Row height, px, used only to decide whether the accounts of each bank also fit. */
const ROW = 32;

export function BalancesWidget({ now, hidden, size, pixels }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.balances(), [], 120_000);
  // With room for every account, each bank is followed by its accounts; otherwise the banks alone are listed.
  const room = pixels ? Math.floor((pixels.height - 185 - (size === 'lg' ? 140 : 0)) / ROW) : 0;
  const wanted = data ? data.institutions.length + data.institutions.reduce((sum, i) => sum + (i.accounts > 1 ? i.accounts : 0), 0) : 0;
  const withAccounts = data !== null && wanted <= room;
  return (
    <Widget
      title="Saldo em contas"
      to={{ page: 'accounts' }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      head={
        data && (
          <>
            <div class="big">{brl(data.total, hidden)}</div>
            <div class="muted">
              {data.accounts.length} contas em {data.institutions.length} instituições
            </div>
            {size !== 'sm' && <StackBar parts={data.institutions.map((i, n) => ({ value: Math.max(i.balance, 0), color: PALETTE[n % PALETTE.length]!, label: i.institution, tip: `${i.institution}\n${hidden ? '••••' : brl(i.balance)} · ${shareLabel(i.share)}` }))} />}
          </>
        )
      }
    >
      {data && size === 'lg' && (
        <div class="split">
          <Ring size={120} segments={data.institutions.map((i, n) => ({ value: Math.max(i.balance, 0), color: PALETTE[n % PALETTE.length]!, tip: `${i.institution}\n${hidden ? '••••' : brl(i.balance)} · ${shareLabel(i.share)}` }))}>
            <span class="muted">{data.institutions.length} instituições</span>
          </Ring>
        </div>
      )}
      {data && size !== 'sm' && (
        <FitList
          noun={['instituição', 'instituições']}
          rows={data.institutions.flatMap((i, n) => [
            <li key={i.institution}>
              <span class="swatch" style={{ background: PALETTE[n % PALETTE.length] }} />
              <Go class="grow clip" page="transactions" params={{ institution: i.institution }}>
                {i.institution}
              </Go>
              <span class="muted">{shareLabel(i.share)}</span>
              <strong>{brl(i.balance, hidden)}</strong>
            </li>,
            ...(withAccounts && i.accounts > 1
              ? data.accounts
                  .filter((a) => a.institution === i.institution)
                  .map((a) => (
                    <li key={a.id} class="sub">
                      <Go class="grow clip" page="transactions" params={{ accountId: a.id }}>
                        {a.name}
                        {a.last4 ? ` •••• ${a.last4}` : ''}
                      </Go>
                      <span class="muted">{brl(a.balance, hidden)}</span>
                    </li>
                  ))
              : []),
          ])}
        />
      )}
    </Widget>
  );
}
