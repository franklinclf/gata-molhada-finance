import { api } from '../api.ts';
import { Bars, Meter, Ring } from '../charts.tsx';
import { brl, dayMonth, localDay, monthName } from '../format.ts';
import { chartHeight } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go, StatusBadge } from '../ui.tsx';
import { FitList, PeriodSelect, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

const BAR_COLOR: Record<string, string> = { open: 'var(--accent)', paid: 'var(--good)', overdue: 'var(--bad)', unknown: 'var(--muted)' };
const BAR_NAME: Record<string, string> = { open: 'em aberto', paid: 'paga', overdue: 'vencida', unknown: 'não conferida' };
const barColor = (status: string) => BAR_COLOR[status] ?? 'var(--warn)';

export function CardsWidget({ now, hidden, size, pixels, config, setConfig }: WidgetProps) {
  const cycle = config.cycle ?? 'open';
  const { data, error, loading } = useLoad(() => api.cards(cycle), [cycle], 120_000);
  const bills = useLoad(() => api.bills(), [], 300_000);
  const today = localDay(now.toISOString());
  const options = [{ id: 'open', label: 'Em aberto' }, ...(data?.cycles ?? []).map((c) => ({ id: c, label: `Venc. ${monthName(c)}` }))];
  const used = data && data.totals.creditLimit > 0 ? data.totals.used / data.totals.creditLimit : 0;
  // Only what is still unpaid is listed: a card with nothing to pay, or no bill in the chosen month, is left out. The biggest debt comes first.
  const shown = (data?.cards.filter((c) => c.toPay > 0) ?? []).sort((a, b) => b.toPay - a.toPay);
  const closedUnpaid = data?.cards.reduce((s, c) => s + c.outstanding, 0) ?? 0;
  // The part of the shared limit no listed purchase explains is in the header total, so it gets its own line to make the rows add up.
  const unexplained = cycle === 'open' ? (data?.totals.unexplained ?? 0) : 0;
  const due = data?.totals.nextDueDate ?? null;
  const late = (day: string | null) => day !== null && day < today;
  const months = Math.max(4, Math.min(12, Math.floor((pixels?.width ?? 380) / 52)));
  const barData = (bills.data?.bars ?? []).slice(-months);
  const roomy = pixels !== undefined && pixels.height >= 600;
  return (
    <Widget
      title="Faturas"
      to={{ page: 'cards', params: { cycle } }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      actions={<PeriodSelect value={cycle} options={options} onChange={(id) => setConfig({ cycle: id })} />}
      head={
        data && (
          <>
            <div class="big">{brl(data.totals.toPay, hidden)}</div>
            <div class="muted" data-tip={closedUnpaid > 0 || data.totals.futureInstallments > 0 ? `${brl(data.totals.toPay - closedUnpaid, hidden)} em fatura aberta + ${brl(closedUnpaid, hidden)} em faturas fechadas não pagas${cycle === 'open' && data.totals.futureInstallments > 0 ? `\nFora do total: ${brl(data.totals.futureInstallments, hidden)} de parcelas de faturas futuras` : ''}` : undefined}>{due ? `A pagar · ${late(due) ? 'venceu em' : cycle === 'open' ? 'vence' : 'vencimento'} ${dayMonth(due)}` : 'A pagar'}</div>
            {size !== 'sm' && bills.data && (pixels === undefined || pixels.height >= 430) && (
              <>
                <Bars
                  hidden={hidden}
                  height={chartHeight(pixels, 440, 80, 150)}
                  selected={cycle === 'open' ? (bills.data.bars.find((b) => b.current)?.key ?? 'open') : cycle}
                  onSelect={(key) => setConfig({ cycle: key === bills.data?.bars.find((b) => b.current)?.key ? 'open' : key })}
                  data={barData.map((b) => ({
                    key: b.key,
                    label: monthName(b.key).slice(0, 3),
                    value: b.total,
                    color: barColor(b.status),
                    tip: `Venc. ${monthName(b.key)}\n${hidden ? '••••' : brl(b.total)}${b.open ? ` · ${b.openCards} em aberto${b.closedCards > 0 ? `, ${b.closedCards} já fechada${b.closedCards === 1 ? '' : 's'}` : ''}` : ''}`,
                  }))}
                />
                <div class="legend">
                  {[...new Set(barData.map((b) => (BAR_NAME[b.status] ? b.status : 'warn')))].map((status) => (
                    <span key={status}>
                      <i style={{ background: barColor(status) }} />
                      {BAR_NAME[status] ?? 'a pagar'}
                    </span>
                  ))}
                </div>
              </>
            )}
          </>
        )
      }
    >
      {data && size !== 'sm' && (
        <>
          {size === 'lg' && cycle === 'open' && (
            <div class="split">
              <Ring size={100} segments={[{ value: data.totals.used, color: 'var(--accent)', tip: `Usado ${hidden ? '••••' : brl(data.totals.used)}` }, { value: data.totals.available, color: 'transparent' }]}>
                <span class="muted">limite usado</span>
                <strong>{Math.round(used * 100)}%</strong>
              </Ring>
              <div class="muted">
                Disponível {brl(data.totals.available, hidden)}
                <br />
                de {brl(data.totals.creditLimit, hidden)}
              </div>
            </div>
          )}
          <FitList
            class="rows tall"
            noun={['cartão', 'cartões']}
            rows={
              shown.length === 0
                ? [
                    <li key="none" class="muted">
                      Nada a pagar {cycle === 'open' ? 'agora' : 'neste mês'}.
                    </li>,
                  ]
                : shown.map((c) => {
                    const dueDay = c.nextDueDate ?? c.cycle?.dueDate ?? null;
                    const unpaid = cycle === 'open' && c.outstanding > 0;
                    const inOpen = c.toPay - c.outstanding;
                    return (
                      <li key={c.id}>
                        <div class="grow">
                          <Go class="clip" page="transactions" params={{ accountId: c.id, cycle: c.cycle ? (cycle === 'open' ? 'open' : c.cycle.key) : undefined }}>
                            {c.institution} {c.name}
                            {c.last4 ? ` •••• ${c.last4}` : ''}
                          </Go>
                          {cycle === 'open' && <Meter fraction={c.creditLimit ? 1 - (c.availableLimit ?? c.creditLimit - c.balance) / c.creditLimit : 0} tip="Limite usado" />}
                          <div class="muted">
                            {/* The badge and the date belong to the bill behind the amount: a closed unpaid one first, otherwise the open one. */}
                            {unpaid ? <StatusBadge status={late(dueDay) ? 'overdue' : 'unpaid'} /> : c.cycle ? <StatusBadge status={c.cycle.status} /> : null} {dueDay ? `${late(dueDay) ? 'venceu em' : 'vence'} ${dayMonth(dueDay)}` : ''}
                            {unpaid && inOpen > 0 ? ` · mais ${brl(inOpen, hidden)} na aberta` : ''}
                            {c.cycle?.adjusted ? (c.cycle.adjusted.by === 'auto' ? ' · sobra rolou' : ' · ajustada') : ''}
                          </div>
                        </div>
                        <strong>{brl(c.toPay, hidden)}</strong>
                      </li>
                    );
                  })
            }
          />
          {unexplained > 0 && (
            <ul class="rows tall">
              <li data-tip="Parte do limite usado, informada pelo banco para o limite compartilhado, que nenhuma compra ou parcela listada explica. Pode ser uma compra que o banco ainda não enviou.">
                <Go class="grow clip" page="cards" params={{ cycle }}>
                  Sem compra que explique
                </Go>
                <strong>{brl(unexplained, hidden)}</strong>
              </li>
            </ul>
          )}
          {roomy && (
            <dl class="facts inline">
              {closedUnpaid > 0 && (
                <>
                  <dt>Em faturas fechadas não pagas</dt>
                  <dd>{brl(closedUnpaid, hidden)}</dd>
                  <dt>Em fatura aberta</dt>
                  <dd>{brl(data.totals.toPay - closedUnpaid, hidden)}</dd>
                </>
              )}
              {cycle === 'open' && data.totals.futureInstallments > 0 && (
                <>
                  <dt>Parcelas de faturas futuras (fora do total)</dt>
                  <dd>{brl(data.totals.futureInstallments, hidden)}</dd>
                </>
              )}
            </dl>
          )}
        </>
      )}
    </Widget>
  );
}
