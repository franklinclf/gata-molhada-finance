import { api } from '../api.ts';
import { PALETTE, StackBar } from '../charts.tsx';
import { brl, percent } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function BalancesWidget({ now, hidden }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.balances(), [], 120_000);
  return (
    <Widget title="Saldo em contas" asOf={data?.oldestDataAt} now={now} loading={loading && !data} error={error}>
      {data && (
        <>
          <div class="big">{brl(data.total, hidden)}</div>
          <div class="muted">{data.accounts.length} contas em {data.institutions.length} instituições</div>
          <StackBar parts={data.institutions.map((i, n) => ({ value: Math.max(i.balance, 0), color: PALETTE[n % PALETTE.length]!, label: i.institution }))} />
          <ul class="rows">
            {data.institutions.map((i, n) => (
              <li key={i.institution}>
                <span class="swatch" style={{ background: PALETTE[n % PALETTE.length] }} />
                <span class="grow">{i.institution}</span>
                <span class="muted">{percent(i.share)}</span>
                <strong>{brl(i.balance, hidden)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </Widget>
  );
}
