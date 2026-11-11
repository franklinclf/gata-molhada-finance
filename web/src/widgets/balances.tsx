import { api } from '../api.ts';
import { PALETTE, Ring, StackBar } from '../charts.tsx';
import { brl } from '../format.ts';
import { COLUMN_HEIGHT, shareLabel } from '../grid.ts';
import { accountName } from '../names.ts';
import { useLoad } from '../hooks.ts';
import { Go } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

/** Row height, px, used only to decide whether the accounts of each bank also fit. */
const ROW = 32;

export function BalancesWidget({ now, hidden, size, pixels }: WidgetProps) {
  const { data, error, loading } = useLoad(() => api.balances(), [], 120_000);
  const column = size === 'sm' && pixels !== undefined && pixels.height >= COLUMN_HEIGHT;
  // With room for every account, each bank is followed by its accounts; otherwise the banks alone are listed.
  const room = pixels ? Math.floor((pixels.height - 185 - (size === 'lg' ? 140 : 0)) / ROW) : 0;
  // Banks and accounts with no balance are one line at the end instead of rows of R$ 0,00.
  const used = (data?.accounts ?? []).filter((a) => a.balance !== 0);
  const live = (data?.institutions ?? []).filter((i) => used.some((a) => a.institution === i.institution));
  const idle = (data?.institutions ?? []).filter((i) => !live.includes(i));
  const wanted = live.length + live.reduce((sum, i) => sum + (i.accounts > 1 ? used.filter((a) => a.institution === i.institution).length : 0), 0) + (idle.length > 0 ? 1 : 0);
  const withAccounts = data !== null && wanted <= room;
  const rows = live.flatMap((i) => column ? [
    <li key={i.institution} class="stack">
      <div class="row-line">
        <Go class="grow clip" page="transactions" params={{ institution: i.institution }}>
          {i.institution}
        </Go>
        <span class="muted">{shareLabel(i.share)}</span>
      </div>
      <strong>{brl(i.balance, hidden)}</strong>
    </li>,
  ] : [
    <li key={i.institution}>
      <span class="swatch" style={{ background: PALETTE[data!.institutions.indexOf(i) % PALETTE.length] }} />
      <Go class="grow clip" page="transactions" params={{ institution: i.institution }}>
        {i.institution}
      </Go>
      <span class="muted">{shareLabel(i.share)}</span>
      <strong>{brl(i.balance, hidden)}</strong>
    </li>,
    ...(withAccounts && i.accounts > 1
      ? used
          .filter((a) => a.institution === i.institution)
          .map((a) => (
            <li key={a.id} class="sub">
              <Go class="grow clip" page="transactions" params={{ accountId: a.id }}>
                {accountName(a.institution, a.name, a.kind)}
                {a.last4 ? ` •••• ${a.last4}` : ''}
              </Go>
              <span class="muted">{brl(a.balance, hidden)}</span>
            </li>
          ))
      : []),
  ]);
  if (idle.length > 0) {
    const names = idle.map((i) => i.institution).join(', ');
    rows.push(
      <li key="idle" class="muted">
        <span class="grow clip" data-tip={names}>
          Sem saldo: {names}
        </span>
      </li>,
    );
  }
  return (
    <Widget
      title="Saldo em contas"
      column={column}
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
              {size === 'sm' && !column
                ? `${used.length} ${used.length === 1 ? 'conta' : 'contas'} com saldo`
                : `${used.length} ${used.length === 1 ? 'conta' : 'contas'} com saldo em ${live.length} ${live.length === 1 ? 'instituição' : 'instituições'}${data.accounts.length > used.length ? ` · ${data.accounts.length - used.length} sem saldo` : ''}`}
            </div>
            {(size !== 'sm' || column) && <StackBar parts={data.institutions.map((i, n) => ({ value: Math.max(i.balance, 0), color: PALETTE[n % PALETTE.length]!, label: i.institution, tip: `${i.institution}\n${hidden ? '••••' : brl(i.balance)} · ${shareLabel(i.share)}` }))} />}
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
      {data && (size !== 'sm' || column) && <FitList noun={['instituição', 'instituições']} rows={rows} />}
    </Widget>
  );
}
