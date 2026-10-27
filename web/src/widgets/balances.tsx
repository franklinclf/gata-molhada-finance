import { api } from '../api.ts';
import { PALETTE, StackBar } from '../charts.tsx';
import { brl, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function BalancesWidget({ item, now, hidden, size }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.balances(), [], 120_000);
  const limit = 60;
  return (
    <Widget title="Saldo em contas" to={{ page: 'accounts' }} asOf={data?.oldestDataAt} now={now} loading={loading && !data} error={error}>
      {data && (
        <>
          <div class="big">{brl(data.total, hidden)}</div>
          <div class="muted">
            {data.accounts.length} contas em {data.institutions.length} instituições
          </div>
          {size !== 'sm' && (
            <>
              <StackBar parts={data.institutions.map((i, n) => ({ value: Math.max(i.balance, 0), color: PALETTE[n % PALETTE.length]!, label: i.institution }))} />
              <ul class="rows">
                {data.institutions.slice(0, limit).map((i, n) => (
                  <li key={i.institution}>
                    <span class="swatch" style={{ background: PALETTE[n % PALETTE.length] }} />
                    <Go class="grow clip" page="transactions" params={{ institution: i.institution }}>
                      {i.institution}
                    </Go>
                    <span class="muted">{percent(i.share)}</span>
                    <strong>{brl(i.balance, hidden)}</strong>
                  </li>
                ))}
              </ul>
              {data.institutions.length > limit && <Go page="accounts">e mais {data.institutions.length - limit}</Go>}
            </>
          )}
        </>
      )}
    </Widget>
  );
}
