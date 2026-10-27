import { useState } from 'preact/hooks';
import { api, type CardsView } from '../api.ts';
import { Bars, Meter } from '../charts.tsx';
import { brl, dayMonth, monthName } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams, type Route } from '../router.ts';
import { Go, Loading, StatusBadge } from '../ui.tsx';

const fullDay = (day: string) => `${dayMonth(day)}/${day.slice(0, 4)}`;

function History({ accountId, hidden }: { accountId: string; hidden: boolean }) {
  const { data, error } = useLoad(() => api.cycles(accountId), [accountId]);
  if (!data) return <Loading error={error} />;
  return (
    <div class="scroll-x">
    <table class="table">
      <thead>
        <tr>
          <th>Vencimento</th>
          <th>Período</th>
          <th>Fatura</th>
          <th>Paga</th>
          <th>Situação</th>
        </tr>
      </thead>
      <tbody>
        {data.cycles.map((c) => (
          <tr key={c.key}>
            <td>
              <Go page="transactions" params={{ accountId, cycle: c.key }}>
                {fullDay(c.dueDate)}
              </Go>
            </td>
            <td>
              {dayMonth(c.from)} a {dayMonth(c.to)}
            </td>
            <td>{c.billTotal === null ? `${brl(c.charges - c.credits, hidden)} lançado` : brl(c.billTotal, hidden)}</td>
            <td>{c.billTotal === null ? '' : brl(c.paid, hidden)}</td>
            <td>
              <StatusBadge status={c.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function CardBlock({ card, cycle, hidden }: { card: CardsView['cards'][number]; cycle: string; hidden: boolean }) {
  const [history, setHistory] = useState(false);
  const used = card.creditLimit ? 1 - (card.availableLimit ?? card.creditLimit - card.balance) / card.creditLimit : 0;
  const c = card.cycle;
  return (
    <section class="panel">
      <div class="row-head">
        <h2>
          {card.institution} {card.name}
          {card.last4 ? ` •••• ${card.last4}` : ''}
        </h2>
        {c && <StatusBadge status={c.status} />}
      </div>
      {c ? (
        <>
          <div class="big">{brl(card.total, hidden)}</div>
          <div class="muted">
            Ciclo de {dayMonth(c.from)} a {dayMonth(c.to)} · vence {fullDay(c.dueDate)}
            {card.estimated ? ' · valor estimado pelo emissor, pode incluir parcelas futuras' : ''}
          </div>
          <dl class="facts inline">
            <dt>Lançado no ciclo</dt>
            <dd>{brl(card.posted, hidden)}</dd>
            {c.billTotal !== null && (
              <>
                <dt>Pago</dt>
                <dd>{brl(c.paid, hidden)}</dd>
                <dt>Falta pagar</dt>
                <dd class={c.outstanding > 0 ? 'bad-text' : ''}>{brl(c.outstanding, hidden)}</dd>
              </>
            )}
            {card.minimumPayment !== null && card.minimumPayment > 0 && c.billTotal !== null && (
              <>
                <dt>Pagamento mínimo</dt>
                <dd>{brl(card.minimumPayment, hidden)}</dd>
              </>
            )}
          </dl>
        </>
      ) : (
        <div class="muted">Este cartão não tem fatura com esse vencimento.</div>
      )}
      {card.outstanding > 0 && <div class="badge warn">Fatura fechada em aberto: {brl(card.outstanding, hidden)} · vence {card.nextDueDate ? fullDay(card.nextDueDate) : ''}</div>}
      {card.creditLimit !== null && (
        <>
          <Meter fraction={used} />
          <div class="muted">
            Limite {brl(card.creditLimit, hidden)} · disponível {brl(card.availableLimit ?? 0, hidden)}
            {card.limitGroupId ? ' · limite compartilhado' : ''}
          </div>
        </>
      )}
      <div class="links">
        <Go page="transactions" params={{ accountId: card.id, cycle: c ? (cycle === 'open' ? 'open' : c.key) : undefined }}>
          Ver transações do ciclo
        </Go>
        <button class="link" onClick={() => setHistory(!history)}>
          {history ? 'Ocultar histórico' : 'Histórico de faturas'}
        </button>
      </div>
      {history && <History accountId={card.id} hidden={hidden} />}
    </section>
  );
}

export function CardsPage({ route, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const cycle = route.params.get('cycle') ?? 'open';
  const tab = route.params.get('tab') ?? 'cards';
  const { data, error, loading } = useLoad(() => api.cards(cycle), [cycle]);
  const installments = useLoad(() => api.installments(), []);
  const bills = useLoad(() => api.bills(), []);

  return (
    <div class="page-body">
      <h1 class="page-title">Cartões</h1>
      <div class="tabs">
        {[['cards', 'Faturas'], ['installments', 'Parcelas'], ['limits', 'Limites']].map(([id, label]) => (
          <button key={id} class={tab === id ? 'tab on' : 'tab'} onClick={() => patchParams({ tab: id === 'cards' ? null : id })}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'cards' && bills.data && (
        <div class="panel">
          <h3>Faturas por mês de vencimento (clique em uma barra para ver o ciclo)</h3>
          <Bars
            hidden={hidden}
            height={150}
            selected={cycle}
            onSelect={(key) => patchParams({ cycle: key === 'open' ? null : key })}
            data={bills.data.bars.map((b) => ({
              key: b.key,
              label: b.open ? 'Aberta' : monthName(b.key).slice(0, 3),
              value: b.total,
              color: b.status === 'open' ? 'var(--accent)' : b.status === 'paid' ? 'var(--good)' : b.status === 'overdue' ? 'var(--bad)' : 'var(--warn)',
              tip: `${b.open ? 'Ciclo em aberto' : `Venc. ${monthName(b.key)}`}\n${hidden ? '••••' : brl(b.total)}${b.open ? '' : b.outstanding > 0 ? ` · falta ${hidden ? '••••' : brl(b.outstanding)}` : ' · paga'}`,
            }))}
          />
          <div class="legend">
            <span><i style={{ background: 'var(--accent)' }} /> em aberto</span>
            <span><i style={{ background: 'var(--good)' }} /> paga</span>
            <span><i style={{ background: 'var(--warn)' }} /> a pagar</span>
            <span><i style={{ background: 'var(--bad)' }} /> vencida</span>
          </div>
        </div>
      )}
      {tab === 'cards' && (
        <label class="inline-field">
          Ciclo
          <select class="select" value={cycle} onChange={(e) => patchParams({ cycle: (e.currentTarget as HTMLSelectElement).value === 'open' ? null : (e.currentTarget as HTMLSelectElement).value })}>
            <option value="open">Em aberto (atual)</option>
            {(data?.cycles ?? []).map((c) => (
              <option key={c} value={c}>
                Faturas com vencimento em {monthName(c)}
              </option>
            ))}
          </select>
        </label>
      )}
      {error || (loading && !data) ? (
        <Loading error={error} />
      ) : data ? (
        <>
          {tab === 'cards' && (
            <>
              <div class="summary">
                <div>
                  <span class="muted">{cycle === 'open' ? 'Ciclo em aberto' : `Venc. ${monthName(cycle)}`}</span>
                  <strong>{brl(data.totals.cycleTotal, hidden)}</strong>
                </div>
                <div>
                  <span class="muted">Fechadas e não pagas</span>
                  <strong class={data.totals.outstanding > 0 ? 'bad-text' : ''}>{brl(data.totals.outstanding, hidden)}</strong>
                </div>
                <div>
                  <span class="muted">Próximo vencimento</span>
                  <strong>{data.totals.nextDueDate ? fullDay(data.totals.nextDueDate) : '–'}</strong>
                </div>
                <div>
                  <span class="muted">Saldo que os emissores informam</span>
                  <strong>{brl(data.totals.reportedByIssuer, hidden)}</strong>
                </div>
              </div>
              <div class="cards-grid">
                {data.cards.map((card) => (
                  <CardBlock key={card.id} card={card} cycle={cycle} hidden={hidden} />
                ))}
              </div>
            </>
          )}
          {tab === 'installments' && (
            <div class="panel">
              {!installments.data ? (
                <Loading error={installments.error} />
              ) : (
                <>
                  <div class="summary">
                    <div>
                      <span class="muted">Comprometido por mês</span>
                      <strong>{brl(installments.data.monthlyCommitment, hidden)}</strong>
                    </div>
                    <div>
                      <span class="muted">Restante</span>
                      <strong>{brl(installments.data.remainingTotal, hidden)}</strong>
                    </div>
                  </div>
                  <ul class="rows tall">
                    {installments.data.items.map((i) => (
                      <li key={`${i.accountId}${i.description}${i.total}${i.installmentAmount}`}>
                        <div class="grow">
                          <Go page="transactions" params={{ q: i.description, accountId: i.accountId }}>
                            {i.description}
                          </Go>
                          <Meter fraction={i.number / i.total} />
                          <div class="muted">
                            {i.number} de {i.total} · pago {brl(i.number * i.installmentAmount, hidden)} · restam {brl(i.remainingAmount, hidden)} · última em {monthName(i.lastMonth)}
                          </div>
                        </div>
                        <strong>{brl(i.installmentAmount, hidden)}</strong>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {tab === 'limits' && (
            <div class="panel">
              <div class="summary">
                <div>
                  <span class="muted">Limite total</span>
                  <strong>{brl(data.totals.creditLimit, hidden)}</strong>
                </div>
                <div>
                  <span class="muted">Usado</span>
                  <strong>{brl(data.totals.used, hidden)}</strong>
                </div>
                <div>
                  <span class="muted">Disponível</span>
                  <strong>{brl(data.totals.available, hidden)}</strong>
                </div>
              </div>
              <ul class="rows tall">
                {data.cards.filter((c) => c.creditLimit !== null).map((c) => (
                  <li key={c.id}>
                    <div class="grow">
                      <div>
                        {c.institution} {c.name}
                        {c.last4 ? ` •••• ${c.last4}` : ''}
                        {c.limitGroupId ? ' · compartilhado' : ''}
                      </div>
                      <Meter fraction={c.creditLimit ? 1 - (c.availableLimit ?? 0) / c.creditLimit : 0} />
                    </div>
                    <span class="muted">
                      {brl(c.availableLimit ?? 0, hidden)} de {brl(c.creditLimit ?? 0, hidden)}
                    </span>
                  </li>
                ))}
              </ul>
              <div class="note">Cartões que dividem um limite aparecem juntos e o limite é contado uma vez no total. Cartões ocultos em Ajustes não entram.</div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
