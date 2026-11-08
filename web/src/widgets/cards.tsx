import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Bars, Meter, Ring } from '../charts.tsx';
import { brl, dayMonth, localDay, monthName } from '../format.ts';
import { cardName } from '../names.ts';
import { choiceOf, CURRENT_CYCLE, currentLabel, cycleCaption, otherCycles, resolveCycle } from '../pages/page-logic.ts';
import { Select } from '../Select.tsx';
import { chartHeight } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go, StatusBadge } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

const BAR_COLOR: Record<string, string> = { open: 'var(--accent)', paid: 'var(--good)', overdue: 'var(--bad)', unknown: 'var(--muted)' };
const BAR_NAME: Record<string, string> = { open: 'em aberto', paid: 'paga', overdue: 'vencida', unknown: 'não conferida' };
const barColor = (status: string) => BAR_COLOR[status] ?? 'var(--warn)';

export function CardsWidget({ now, hidden, size, pixels }: WidgetProps) {
  // What is on show lasts for this visit only: it is not saved with the layout, so the widget always opens on the current cycle.
  const [choice, setChoice] = useState(CURRENT_CYCLE);
  const bills = useLoad(() => api.bills(), [], 300_000);
  const currentKey = bills.data ? (bills.data.bars.find((b) => b.current)?.key ?? 'open') : undefined;
  // Nothing is asked for before the bars say which bill is the current one.
  const cycle = resolveCycle(choice, bills.data?.bars);
  const { data, error, loading } = useLoad(() => (cycle === undefined ? Promise.resolve(null) : api.cards(cycle)), [cycle], 120_000);
  // With a month on show, the widget also says what is owed overall and offers the way back.
  const all = useLoad(() => (cycle === undefined || cycle === 'open' ? Promise.resolve(null) : api.cards('open')), [cycle], 120_000);
  const today = localDay(now.toISOString());
  // The dropdown lists the other cycles (the current one and "Em aberto" have their buttons); a month picked on the chart is listed too.
  const options = otherCycles(data?.cycles ?? [], currentKey, choice).map((c) => ({ value: c, label: `Venc. ${monthName(c)}` }));
  const byMonth = cycle !== 'open';
  const caption = cycle === undefined ? '' : cycleCaption(cycle, today);
  const used = data && data.totals.creditLimit > 0 ? data.totals.used / data.totals.creditLimit : 0;
  // "Em aberto" lists only what is still unpaid, the biggest debt first. A chosen month lists every bill due in it, paid or not.
  const amountOf = (c: { toPay: number; total: number }) => (byMonth ? c.total : c.toPay);
  const shown = (data?.cards.filter((c) => (byMonth ? c.cycle !== null && c.total > 0 : c.toPay > 0)) ?? []).sort((a, b) => amountOf(b) - amountOf(a));
  const closedUnpaid = data?.cards.reduce((s, c) => s + c.outstanding, 0) ?? 0;
  // The part of the shared limit no listed purchase explains is in the header total, so it gets its own line to make the rows add up.
  const unexplained = data?.totals.unexplained ?? 0;
  const due = data?.totals.nextDueDate ?? null;
  // What falls due by the next due date, apart from the later bills the headline also adds up.
  const dueByNext = due ? (bills.data?.bars ?? []).filter((b) => b.key <= due.slice(0, 7)).reduce((sum, b) => sum + Math.max(0, b.total - b.paid), 0) : 0;
  const late = (day: string | null) => day !== null && day < today;
  const barCount = Math.max(4, Math.min(12, Math.floor((pixels?.width ?? 380) / 52)));
  const barData = (bills.data?.bars ?? []).slice(-barCount);
  const roomy = pixels !== undefined && pixels.height >= 600;
  return (
    <Widget
      title="Faturas"
      to={{ page: 'cards', params: choice === CURRENT_CYCLE ? {} : { cycle: choice } }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={(loading || cycle === undefined) && !data}
      error={error}
      actions={<Select ariaLabel="Outros ciclos" value={/^\d{4}-\d{2}$/.test(choice) ? choice : ''} placeholder="Outros ciclos" options={options} onChange={(value) => value !== '' && setChoice(choiceOf(value, currentKey))} />}
      head={
        data && (
          <>
            <div class="seg" role="group" aria-label="Faturas em exibição">
              <button class={choice === CURRENT_CYCLE ? 'tab on' : 'tab'} aria-pressed={choice === CURRENT_CYCLE} onClick={() => setChoice(CURRENT_CYCLE)} data-tip="Faturas que vencem no mês atual">
                {currentLabel(currentKey)}
              </button>
              <button class={choice === 'open' ? 'tab on' : 'tab'} aria-pressed={choice === 'open'} onClick={() => setChoice('open')} data-tip="Tudo que falta pagar: faturas fechadas não pagas e a fatura aberta de cada cartão">
                Em aberto
              </button>
            </div>
            <div class="big">{brl(byMonth ? data.totals.cycleTotal : data.totals.toPay, hidden)}</div>
            <div class="muted" data-tip={closedUnpaid > 0 || data.totals.futureInstallments > 0 ? `${brl(data.totals.toPay - closedUnpaid, hidden)} em fatura aberta + ${brl(closedUnpaid, hidden)} em faturas fechadas não pagas${cycle === 'open' && data.totals.futureInstallments > 0 ? `\nFora do total: ${brl(data.totals.futureInstallments, hidden)} de parcelas de faturas futuras` : ''}` : undefined}>{byMonth ? `${caption} · ${data.totals.toPay > 0 ? `a pagar ${brl(data.totals.toPay, hidden)}` : 'tudo pago'}` : due ? `${caption} · ${late(due) ? 'venceu em' : 'próximo vencimento'} ${dayMonth(due)}` : caption}</div>
            {!byMonth && due && dueByNext > 0 && dueByNext < data.totals.toPay && <div class="muted">{brl(dueByNext, hidden)} vencem até {dayMonth(due)}</div>}
            {byMonth && all.data && (
              <div class="muted">
                Tudo que falta pagar: {brl(all.data.totals.toPay, hidden)}
                {all.data.totals.nextDueDate ? ` · próximo vencimento ${dayMonth(all.data.totals.nextDueDate)}` : ''}
              </div>
            )}
            {size !== 'sm' && bills.data && (pixels === undefined || pixels.height >= 430) && (
              <>
                <Bars
                  hidden={hidden}
                  height={chartHeight(pixels, 440, 80, 150)}
                  selected={cycle ?? 'open'}
                  onSelect={(key) => setChoice(key === cycle ? CURRENT_CYCLE : choiceOf(key, currentKey))}
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
                      {BAR_NAME[status] ?? 'fechada, não paga'}
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
                      {byMonth ? 'Nenhuma fatura com vencimento neste mês.' : 'Nada a pagar agora.'}
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
                            {cardName(c.institution, c.name)}
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
                        <strong>{brl(amountOf(c), hidden)}</strong>
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
