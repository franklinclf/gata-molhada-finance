import { useState } from 'preact/hooks';
import { api, type CardsView } from '../api.ts';
import { Bars, Meter, StackedBars } from '../charts.tsx';
import { brl, dayMonth, localDay, monthName, parseBrl } from '../format.ts';
import { useLoad, useStoredFlag } from '../hooks.ts';
import { navigate, patchParams, type Route } from '../router.ts';
import { Button } from '../ds.tsx';
import { ManualForm } from '../ManualForm.tsx';
import { MonthBars, PurchaseRow } from '../installments.tsx';
import { Go, Loading, StatusBadge } from '../ui.tsx';
import { Select } from '../Select.tsx';
import { BillEditor } from '../BillEditor.tsx';
import { patchParams as openParams } from '../router.ts';

const brlText = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
const fullDay = (day: string) => `${dayMonth(day)}/${day.slice(0, 4)}`;

/** Moves the charges to their new bills, one call per destination bill so a bill never ends up half moved. */
async function moveAll(moves: Array<{ transactionId: string; toCycleKey: string }>) {
  const byBill = new Map<string, string[]>();
  for (const m of moves) byBill.set(m.toCycleKey, [...(byBill.get(m.toCycleKey) ?? []), m.transactionId]);
  for (const [cycleKey, ids] of byBill) await api.bulkEdit(ids, { cycleKey });
}

/** Closed bills whose published total differs from what the app adds up, each with the likeliest cause and a way to fix it. */
function CheckTab({ hidden, now }: { hidden: boolean; now: Date }) {
  const [manual, setManual] = useState<string | null>(null);
  const check = useLoad(() => api.billCheck(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const apply = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setMessage(null);
    try {
      await work();
      check.reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível aplicar.');
    } finally {
      setBusy(null);
    }
  };
  if (!check.data) return <Loading error={check.error} />;
  const { items, setAside, duplicatePayments } = check.data;
  return (
    <>
      <p class="muted">
        Compara o total de cada fatura fechada que o banco publicou com a soma das compras da fatura. Quando uma compra perto do fechamento explica a diferença dos dois lados, a sugestão é movê-la para a fatura vizinha. O que nenhuma compra explica é algo que o banco não mandou (use “Lançar a diferença”) ou que ele não cobra (ignore a transação).
      </p>
      {message && <div class="error">{message}</div>}
      <section class="panel">
        <h2>Faturas que não fecham ({items.length})</h2>
        {items.length === 0 ? (
          <div class="empty">Todas as faturas fechadas batem com as compras.</div>
        ) : (
          <ul class="rows tall">
            {items.map((item) => {
              const key = `${item.accountId}|${item.cycleKey}`;
              const s = item.suggestion;
              return (
                <li key={key} class="suggestion">
                  <div class="grow">
                    <div>
                      {item.institution}
                      {item.last4 ? ` •••• ${item.last4}` : ''} · vence {fullDay(item.dueDate)} <span class="muted">({dayMonth(item.from)} a {dayMonth(item.to)})</span>
                    </div>
                    <div class="muted">
                      Banco {brl(item.billTotal, hidden)} · app {brl(item.ours, hidden)} · diferença <span class={item.gap > 0 ? 'bad-text' : ''}>{brl(item.gap, hidden)}</span>
                    </div>
                    {s.kind === 'move' && (
                      <ul class="rows">
                        {s.moves.map((m) => (
                          <li key={m.transactionId}>
                            <button class="link grow clip" onClick={() => patchParams({ tx: m.transactionId })}>
                              {fullDay(m.day)} · {m.description}
                            </button>
                            <span>{brl(m.amount, hidden)}</span>
                            <span class="muted">vai para a fatura de {monthName(m.toCycleKey)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.kind === 'missing' && s.unlisted && (
                      <div class="muted">
                        O banco cobra {brl(s.amount, hidden)} a mais, e o valor bate com {s.unlisted.length === 1 ? 'uma parcela que o banco não listou' : 'duas parcelas que o banco não listou'}:{' '}
                        {s.unlisted.map((u) => `${u.number}/${u.total} de ${u.description}, que o app contou na fatura de ${monthName(u.cycleKey)}`).join(' e ')}. Confira se {s.unlisted.length === 1 ? 'ela foi cobrada' : 'elas foram cobradas'} nesta fatura antes de lançar a diferença.
                      </div>
                    )}
                    {s.kind === 'missing' && !s.unlisted && <div class="muted">O banco cobra {brl(s.amount, hidden)} que nenhuma compra perto do fechamento explica. Provavelmente uma compra, juros ou IOF que não chegaram: use “Lançar a diferença”.</div>}
                    {s.kind === 'extra' && <div class="muted">O app soma {brl(s.amount, hidden)} a mais do que o banco cobrou e nenhuma compra perto do fechamento explica. Pode ser uma pendente que o banco nunca lançou: abra a compra suspeita e ignore ou mude o status.</div>}
                  </div>
                  <div class="actions">
                    <Button size="sm" onClick={() => navigate('chat', { q: `A fatura do ${item.institution}${item.last4 ? ` final ${item.last4}` : ''} com vencimento em ${item.dueDate} veio ${brlText(item.billTotal)} no banco e o app soma ${brlText(item.ours)} (período ${item.from} a ${item.to}). O que pode explicar a diferença de ${brlText(item.gap)}? Consulte as transações do período e as parcelas.` })}>
                      Perguntar à IA
                    </Button>
                    {/* Only a bill larger than the app's sum is fixed by adding a charge; with a smaller bill it would double the gap. */}
                    {s.kind === 'missing' && (
                      <Button size="sm" onClick={() => setManual(manual === key ? null : key)}>
                        Lançar a diferença
                      </Button>
                    )}
                    <Button size="sm" onClick={() => navigate('transactions', { accountId: item.accountId, cycle: item.cycleKey })}>
                      Ver compras
                    </Button>
                  </div>
                  {manual === key && (
                    <ManualForm
                      now={now}
                      initial={{ accountId: item.accountId, day: item.to, amount: -Math.abs(item.gap), description: 'Ajuste de fatura', category: '' }}
                      onCancel={() => setManual(null)}
                      onSaved={() => { setManual(null); check.reload(); }}
                    />
                  )}
                  {s.kind === 'move' && (
                    <button class="primary small" disabled={busy === key} onClick={() => void apply(key, () => moveAll(s.moves))}>
                      {busy === key ? 'Movendo...' : s.moves.length === 1 ? 'Mover a compra' : `Mover ${s.moves.length} compras`}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section class="panel">
        <h2>Pagamentos de fatura repetidos ({duplicatePayments.length})</h2>
        <div class="muted">O banco lista o mesmo pagamento mais de uma vez (a cópia pendente e a lançada, ou dois textos para um pagamento só). Os totais da fatura já contam uma vez; ignore as cópias para a lista também mostrar uma.</div>
        {duplicatePayments.length === 0 ? (
          <div class="empty">Nenhum.</div>
        ) : (
          <ul class="rows tall">
            {duplicatePayments.map((g) => (
              <li key={g.members.map((m) => m.id).join('|')} class="suggestion">
                <div class="grow">
                  <div>
                    {g.institution}
                    {g.last4 ? ` •••• ${g.last4}` : ''} · {brl(g.amount, hidden)}
                  </div>
                  <ul class="rows">
                    {g.members.map((m) => (
                      <li key={m.id}>
                        <button class="link grow clip" onClick={() => patchParams({ tx: m.id })}>
                          {fullDay(m.day)} · {m.description} <span class="muted">({m.status === 'pending' ? 'pendente' : 'lançada'})</span>
                        </button>
                        <button class="link" disabled={busy === m.id} onClick={() => void apply(m.id, () => api.setIgnored(m.id, true))}>
                          Ignorar esta
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section class="panel">
        <h2>Pendentes postas de lado ({setAside.length})</h2>
        <div class="muted">Pendentes antigas em conta que só uma fonte vê ficam fora dos totais. Se alguma for real, abra e mude o status para lançada.</div>
        {setAside.length === 0 ? (
          <div class="empty">Nenhuma.</div>
        ) : (
          <ul class="rows">
            {setAside.map((t) => (
              <li key={t.id}>
                <button class="link grow clip" onClick={() => patchParams({ tx: t.id })}>
                  {fullDay(t.day)} · {t.description} <span class="muted">({t.institution}{t.last4 ? ` ${t.last4}` : ''})</span>
                </button>
                <span>{brl(t.amount, hidden)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function History({ accountId, hidden }: { accountId: string; hidden: boolean }) {
  const { data, error, reload } = useLoad(() => api.cycles(accountId), [accountId]);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const settle = async (key: string, settled: boolean | null) => {
    setMessage(null);
    try {
      await api.setCycleSettled(accountId, key, settled);
      reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível salvar.');
    }
  };
  if (!data) return <Loading error={error} />;
  return (
    <div class="scroll-x">
    {message && <div class="error">{message}</div>}
    <table class="table">
      <thead>
        <tr>
          <th>Vencimento</th>
          <th>Período</th>
          <th>Fatura</th>
          <th>Paga</th>
          <th>Situação</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {data.cycles.flatMap((c) => [
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
            <td>
              {c.billTotal === null ? '' : brl(c.paid, hidden)}
              {c.overpaid > 0 && <div class="bad-text">pago a mais {brl(c.overpaid, hidden)}</div>}
              {c.latePaid && <div class="muted">{brl(c.latePaid.amount, hidden)} pagos com atraso em {dayMonth(c.latePaid.day)}</div>}
            </td>
            <td>
              <StatusBadge status={c.status} />
              {c.adjusted && (
                <div class="muted">
                  {c.adjusted.by === 'auto'
                    ? `${brl(c.adjusted.amount, hidden)} desta fatura não foi pago e provavelmente rolou para a fatura seguinte (o banco soma o que sobrou no próximo extrato, com juros), que foi paga por inteiro. Não conto de novo como devido.`
                    : `${brl(c.adjusted.amount, hidden)} da fatura não foi cobrado (você marcou como quitada)`}{' '}
                  {c.adjusted.by === 'auto' && (
                    <button class="link" onClick={() => void settle(c.key, true)}>
                      Marcar como quitada
                    </button>
                  )}{' '}
                  <button class="link" onClick={() => void settle(c.key, c.adjusted?.by === 'auto' ? false : null)}>
                    {c.adjusted.by === 'auto' ? 'Ainda devo' : 'Desfazer'}
                  </button>
                </div>
              )}
              {!c.adjusted && c.outstanding > 0 && (
                <div class="muted">
                  Falta {brl(c.outstanding, hidden)}.{' '}
                  <button class="link" onClick={() => void settle(c.key, true)}>
                    Marcar como quitada
                  </button>
                </div>
              )}
              {c.status === 'unknown' && c.billTotal !== null && <div class="muted">Este cartão não tem lançamentos suficientes antes desta fatura para saber se foi paga. Se foi, marque em Editar.</div>}
              {c.edited && <div class="muted">editada por você</div>}
            </td>
            <td>
              {c.status !== 'open' && (
                <button class="link" onClick={() => setEditing(editing === c.key ? null : c.key)}>
                  {editing === c.key ? 'Fechar' : 'Editar'}
                </button>
              )}
            </td>
          </tr>,
          ...(editing === c.key
            ? [
                <tr key={`${c.key}-edit`}>
                  <td colSpan={6}>
                    <BillEditor accountId={accountId} cycle={c} onDone={() => { setEditing(null); reload(); }} />
                  </td>
                </tr>,
              ]
            : []),
        ])}
      </tbody>
    </table>
    </div>
  );
}

/** Limit still free on a card: what the issuer reports, else the limit minus the balance owed. The same rule on every screen. */
const availableOf = (c: { creditLimit: number | null; availableLimit: number | null; balance: number }): number => c.availableLimit ?? (c.creditLimit ?? 0) - c.balance;

/** One row per limit: cards that share a limit count once, and the bar fills with what is used, as the numbers say. */
type OwedInput = { limitGroupId: string | null; balance: number; outstanding: number; futureInstallments: number; posted: number; plannedInstallments: number; cycle: { status: string } | null };
// Same rule as the data health panel (a few cents or 2% of rounding on the issuer's side do not count). A card on a shared
// limit is left out because the balance is reported for the whole group.
const OWED_TOLERANCE = { cents: 1000, share: 0.02 };
/** What the app adds up for a card, when it is more than the balance the issuer reports; null otherwise. */
function owedAboveIssuer(c: OwedInput): number | null {
  if (c.limitGroupId !== null || c.cycle === null) return null;
  const owed = c.outstanding + c.futureInstallments + (c.cycle.status === 'open' ? c.posted + c.plannedInstallments : 0);
  return owed > c.balance + Math.max(OWED_TOLERANCE.cents, c.balance * OWED_TOLERANCE.share) ? owed : null;
}

function limitRows(data: CardsView): Array<{ key: string; name: string; shared: boolean; limit: number; used: number }> {
  const label = (id: string) => { const c = data.cards.find((x) => x.id === id); return c ? `${c.institution} ${c.name}${c.last4 ? ` •••• ${c.last4}` : ''}` : id; };
  const groups = data.limitGroups.map((g) => ({ key: g.id, name: g.cardIds.map(label).join(' + '), shared: g.cardIds.length > 1, limit: g.creditLimit, used: g.used }));
  const singles = data.cards.filter((c) => c.creditLimit !== null && !data.limitGroups.some((g) => g.cardIds.includes(c.id))).map((c) => ({ key: c.id, name: label(c.id), shared: false, limit: c.creditLimit ?? 0, used: (c.creditLimit ?? 0) - availableOf(c) }));
  return [...groups, ...singles];
}

function CardBlock({ card, cycle, hidden, today }: { card: CardsView['cards'][number]; cycle: string; hidden: boolean; today: string }) {
  const [history, setHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const isOpen = cycle === 'open';
  const used = card.creditLimit ? 1 - availableOf(card) / card.creditLimit : 0;
  const c = card.cycle;
  const late = card.nextDueDate !== null && card.nextDueDate < today;
  const owed = isOpen ? owedAboveIssuer(card) : null;
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
          {c.status === 'open' && card.total === 0 ? <div class="big-empty">Sem compras neste ciclo ainda</div> : <div class="big">{brl(card.total, hidden)}</div>}
          <div class="muted">
            Fatura de {dayMonth(c.from)} a {dayMonth(c.to)} · vence {fullDay(c.dueDate)}
            {card.estimated ? ' · estimado: saldo do emissor menos as parcelas de faturas futuras' : ''}
          </div>
          <dl class="facts inline">
            <dt>Lançado na fatura</dt>
            <dd>{brl(card.posted, hidden)}</dd>
            {card.plannedInstallments > 0 && (
              <>
                <dt>Parcelas desta fatura ainda não listadas</dt>
                <dd>{brl(card.plannedInstallments, hidden)}</dd>
              </>
            )}
            {isOpen && card.futureInstallments > 0 && (
              <>
                <dt>Parcelas de faturas futuras</dt>
                <dd>{brl(card.futureInstallments, hidden)}</dd>
              </>
            )}
            {isOpen && (
              <>
                <dt>Saldo devedor no emissor</dt>
                <dd>{brl(card.balance, hidden)}</dd>
              </>
            )}
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
      {c?.adjusted && <div class="note">{c.adjusted.by === 'auto' ? `${brl(c.adjusted.amount, hidden)} desta fatura não foi pago e provavelmente rolou para a fatura seguinte; não conta de novo como devido.` : `${brl(c.adjusted.amount, hidden)} desta fatura não foi cobrado, então ela conta como paga.`}</div>}
      {c?.latePaid && <div class="note">Pago com atraso em {dayMonth(c.latePaid.day)}: {brl(c.latePaid.amount, hidden)} desta fatura foram pagos depois do fechamento da fatura seguinte.</div>}
      {c && c.overpaid > 0 && <div class="note">Pago a mais: {brl(c.overpaid, hidden)}. Os pagamentos desta janela passam do total da fatura. Pode ser pagamento em dobro, ou o pagamento atrasado de uma fatura anterior.</div>}
      {card.outstanding > 0 && (
        <div class={late ? 'badge bad' : 'badge warn'}>
          {/* A closed month already shows "Falta pagar" above, so the badge only adds the due date. */}
          {isOpen ? `Fatura fechada em aberto: ${brl(card.outstanding, hidden)} · ` : ''}
          {late ? 'venceu em' : 'vence'} {card.nextDueDate ? fullDay(card.nextDueDate) : ''}
        </div>
      )}
      {owed !== null && (
        <>
          <div class="badge warn">Saldo do emissor menor que a fatura: {brl(card.balance, hidden)} contra {brl(owed, hidden)}</div>
          <div class="note">O banco informa um saldo devedor menor que a soma de fatura aberta, faturas fechadas não pagas e parcelas futuras que o app calcula. Confira se há pagamento não reconhecido ou fatura publicada com valor errado.</div>
        </>
      )}
      {isOpen && card.creditLimit !== null && (
        <>
          <Meter fraction={used} />
          <div class="muted">
            Limite {brl(card.creditLimit, hidden)} · disponível {brl(availableOf(card), hidden)}
            {card.limitGroupId ? ' · limite compartilhado' : ''}
          </div>
        </>
      )}
      <div class="links">
        <Go page="transactions" params={{ accountId: card.id, cycle: c ? (cycle === 'open' ? 'open' : c.key) : undefined }}>
          Ver transações da fatura
        </Go>
        {c && c.status !== 'open' && (
          <button class="link" onClick={() => setEditing(!editing)}>
            {editing ? 'Fechar edição' : 'Editar esta fatura'}
          </button>
        )}
        <button class="link" onClick={() => setHistory(!history)}>
          {history ? 'Ocultar histórico' : 'Histórico de faturas'}
        </button>
      </div>
      {editing && c && <BillEditor accountId={card.id} cycle={c} onDone={() => setEditing(false)} />}
      {history && <History accountId={card.id} hidden={hidden} />}
    </section>
  );
}

/** The fixed income the owner registers, and what is left of it each month after the card bills already known. */
function IncomePanel({ months, hidden }: { months: Array<{ key: string; income: number; bills: number }>; hidden: boolean }) {
  const list = useLoad(() => api.income(), []);
  const [form, setForm] = useState<{ id: number | null; name: string; amount: string; day: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await work();
      setForm(null);
      list.reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível salvar.');
    }
  };
  const items = list.data?.items ?? [];
  return (
    <div class="panel">
      <div class="panel-head">
        <h3>Renda fixa e o que sobra</h3>
        <button class="chip" onClick={() => setForm({ id: null, name: '', amount: '', day: '5' })}>+ Nova renda</button>
      </div>
      <div class="muted">Cadastre o que entra todo mês (salário, aluguel recebido). A previsão desconta as faturas já conhecidas e mostra quanto sobra para gastar fora do cartão.</div>
      {items.length > 0 && (
        <ul class="rows">
          {items.map((i) => (
            <li key={i.id}>
              <span class="grow clip">{i.name} <span class="muted">dia {i.dayOfMonth}</span></span>
              <strong>{brl(i.amount, hidden)}</strong>
              <button class="link" onClick={() => setForm({ id: i.id, name: i.name, amount: String(i.amount / 100).replace('.', ','), day: String(i.dayOfMonth) })}>Editar</button>
              <button class="link" onClick={() => window.confirm(`Remover a renda “${i.name}”? A previsão deixa de contar esse valor.`) && void run(() => api.deleteIncome(i.id))}>Remover</button>
            </li>
          ))}
        </ul>
      )}
      {form && (
        <form
          class="recat"
          onSubmit={(e) => {
            e.preventDefault();
            const amount = parseBrl(form.amount);
            if (amount === null) return setMessage('Digite um valor maior que zero.');
            void run(() => api.saveIncome(form.id, { name: form.name.trim(), amount, dayOfMonth: Number(form.day), fromMonth: null, untilMonth: null }));
          }}
        >
          <input aria-label="Nome da renda" placeholder="Nome (ex.: Salário)" value={form.name} maxLength={60} onInput={(e) => setForm({ ...form, name: (e.currentTarget as HTMLInputElement).value })} />
          <input aria-label="Valor" inputMode="decimal" placeholder="Valor" value={form.amount} onInput={(e) => setForm({ ...form, amount: (e.currentTarget as HTMLInputElement).value })} />
          <input aria-label="Dia do mês" type="number" min="1" max="31" value={form.day} onInput={(e) => setForm({ ...form, day: (e.currentTarget as HTMLInputElement).value })} />
          <button class="primary" disabled={form.name.trim() === ''}>Salvar</button>
          <button type="button" class="link" onClick={() => setForm(null)}>Cancelar</button>
        </form>
      )}
      {message && <div class="error">{message}</div>}
      {items.length > 0 && (
        <table class="table">
          <thead>
            <tr><th>Mês</th><th>Renda</th><th>Faturas previstas</th><th>Sobra</th></tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.key}>
                <td>{monthName(m.key)}</td>
                <td>{brl(m.income, hidden)}</td>
                <td>{brl(m.bills, hidden)}</td>
                <td><strong class={m.income - m.bills < 0 ? 'bad-text' : 'good-text'}>{brl(m.income - m.bills, hidden)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ForecastTab({ hidden, installments, route }: { hidden: boolean; installments: ReturnType<typeof useLoad<import('../api.ts').InstallmentsView>>; route: Route }) {
  const { data, error } = useLoad(() => api.forecast(), []);
  const [open, setOpen] = useState<string | null>(null);
  // The guess by average is off until asked for: only what is known (installments) and what repeats is counted.
  const [guess, setGuess] = useStoredFlag('gmf-forecast-average', false);
  if (!data) return <Loading error={error} />;
  const chosen = data.months.find((m) => m.key === open) ?? null;
  // The server works the totals out: `certain` is what is sure, `estimated` adds the average. The screen only picks one.
  const totalOf = (m: { certain: number; estimated: number }) => (guess ? m.estimated : m.certain);
  return (
    <>
      <label class="check">
        <input type="checkbox" checked={guess} onChange={(e) => setGuess((e.currentTarget as HTMLInputElement).checked)} />
        Incluir estimativa pela média do gasto de costume (um chute, fora do que já é certo ou se repete)
      </label>
      <div class="panel">
        <h3>Faturas estimadas, por mês de vencimento (clique em um mês para ver por cartão)</h3>
        <StackedBars
          hidden={hidden}
          height={170}
          selected={open}
          onSelect={(k) => setOpen(open === k ? null : k)}
          data={data.months.map((m) => ({
            key: m.key,
            label: m.open ? 'Aberta' : monthName(m.key).slice(0, 3),
            parts: [
              { value: m.installments, color: 'var(--good)', label: 'parcelas já compradas' },
              { value: m.recurring, color: 'var(--accent)', label: 'cobranças que se repetem' },
              { value: m.certain - m.installments - m.recurring, color: 'var(--muted)', label: 'já na fatura (compras lançadas ou fatura publicada)' },
              ...(guess ? [{ value: m.variable, color: 'var(--track)', label: 'gasto de costume (estimativa)' }] : []),
            ],
          }))}
        />
        <div class="legend">
          <span><i style={{ background: 'var(--good)' }} /> parcelas já compradas (certo)</span>
          <span><i style={{ background: 'var(--accent)' }} /> cobranças que se repetem (provável)</span>
          <span><i style={{ background: 'var(--muted)' }} /> já na fatura (compras lançadas ou fatura publicada)</span>
          {guess && <span><i style={{ background: 'var(--track)' }} /> gasto de costume (chute pela média)</span>}
        </div>
      </div>
      <div class="panel">
        <table class="table">
          <thead>
            <tr>
              <th>Vencimento</th>
              <th>Parcelas</th>
              <th>Repetem</th>
              {guess && <th>De costume</th>}
              <th>{guess ? 'Estimado' : 'Previsto'}</th>
            </tr>
          </thead>
          <tbody>
            {data.months.map((m) => (
              <tr key={m.key} onClick={() => setOpen(open === m.key ? null : m.key)} class="clickable-row">
                <td>
                  {monthName(m.key)}
                  {m.open ? ' (em aberto)' : ''}
                </td>
                <td>{brl(m.installments, hidden)}</td>
                <td>{brl(m.recurring, hidden)}</td>
                {guess && <td>{brl(m.variable, hidden)}</td>}
                <td>
                  <strong>{brl(totalOf(m), hidden)}</strong>
                  {m.known > 0 && <div class="muted">já tem {brl(m.known, hidden)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {chosen && (
          <ul class="rows tall">
            {chosen.cards.map((c) => (
              <li key={c.id}>
                <div class="grow">
                  <div>{c.label}</div>
                  <div class="muted">
                    {c.state === 'closed'
                      ? `fatura fechada, o banco já informou o valor (parcelas ${brl(c.installments, hidden)})`
                      : `${c.state === 'open' ? 'fatura em aberto · ' : ''}parcelas ${brl(c.installments, hidden)} · repetem ${brl(c.recurring, hidden)}${guess ? ` · de costume ${brl(c.variable, hidden)}` : ''}`}
                  </div>
                </div>
                <strong>{brl(totalOf(c), hidden)}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
      <IncomePanel months={data.months.map((m) => ({ key: m.key, income: m.income, bills: totalOf(m) }))} hidden={hidden} />
      <h2 class="section-title">Parcelas em andamento</h2>
      <InstallmentsTab installments={installments} hidden={hidden} route={route} />
      <div class="panel">
        <h3>Como foi calculado</h3>
        <div class="muted">
          Parcelas já compradas vêm do plano de parcelas e são certas. As cobranças que se repetem são as que apareceram em pelo menos 3 meses, com valor estável (até 10% de variação), e entram todo mês pelo último valor. O gasto de costume é uma média das últimas faturas fechadas depois de tirar parcelas e repetidas: é um chute e cai ou sobe conforme o seu mês. A fatura em aberto nunca é estimada abaixo do que já tem. Quando o banco já publicou a fatura de um cartão naquele mês, vale o valor publicado, sem somar nada por cima. “Previsto” é o que é certo (parcelas, cobranças que se repetem e faturas publicadas); “Estimado” soma a média do gasto de costume.
        </div>
        <ul class="rows">
          {data.basis.map((b) => (
            <li key={b.card}>
              <span class="grow">{b.card}</span>
              <span class="muted">média de {b.bills} fatura(s): {brl(b.average, hidden)}</span>
            </li>
          ))}
        </ul>
        {data.recurring.length > 0 && (
          <>
            <h3>Cobranças que se repetem</h3>
            <ul class="rows">
              {data.recurring.map((r) => (
                <li key={`${r.card}${r.description}`}>
                  <span class="grow clip">{r.description}</span>
                  <span class="muted">{r.card} · {r.months} meses</span>
                  <strong>{brl(r.amount, hidden)}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

function InstallmentsTab({ installments, hidden, route }: { installments: ReturnType<typeof useLoad<import('../api.ts').InstallmentsView>>; hidden: boolean; route: Route }) {
  const month = route.params.get('month');
  const card = route.params.get('card') ?? '';
  const finished = route.params.get('finished') === 'true';
  const v = installments.data;
  if (!v) return <Loading error={installments.error} />;
  const cards = [...new Map(v.purchases.map((p) => [p.accountId, p.card])).entries()];
  const shown = v.purchases.filter((p) => (finished || !p.finished) && (card === '' || p.accountId === card) && (!month || p.slots.some((s) => s.cycle === month)));
  const months = v.months.filter((m) => card === '' || v.purchases.some((p) => p.accountId === card && p.slots.some((s) => s.cycle === m.cycle)));
  return (
    <>
      <div class="summary">
        <div>
          <span class="muted">Nesta fatura</span>
          <strong>{brl(v.thisCycle, hidden)}</strong>
        </div>
        <div>
          <span class="muted">Na próxima fatura</span>
          <strong>{brl(v.nextCycle, hidden)}</strong>
        </div>
        <div>
          <span class="muted">A pagar no total</span>
          <strong>{brl(v.remainingTotal, hidden)}</strong>
        </div>
        <div>
          <span class="muted">Compras em andamento</span>
          <strong>{v.purchases.filter((p) => !p.finished).length}</strong>
        </div>
      </div>
      <div class="panel">
        <h3>Parcelas por fatura (clique em um mês para ver só as compras dele)</h3>
        <MonthBars months={months} hidden={hidden} height={150} selected={month} onSelect={(m) => patchParams({ month: month === m ? null : m })} />
        <div class="legend">
          <span><i style={{ background: 'var(--good)' }} /> paga</span>
          <span><i style={{ background: 'var(--warn)' }} /> fatura fechada, a pagar</span>
          <span><i style={{ background: 'var(--accent)' }} /> fatura em aberto</span>
          <span><i style={{ background: 'var(--muted)' }} /> ainda não cobrada</span>
        </div>
      </div>
      <div class="filters">
        <Select ariaLabel="Cartão" value={card} onChange={(value) => patchParams({ card: value || null })} options={[{ value: '', label: 'Todos os cartões' }, ...cards.map(([id, label]) => ({ value: id, label }))]} />
        <label class="check">
          <input type="checkbox" checked={finished} onChange={(e) => patchParams({ finished: (e.currentTarget as HTMLInputElement).checked ? 'true' : null })} />
          Mostrar compras já quitadas
        </label>
        {month && (
          <button class="chip on" onClick={() => patchParams({ month: null })}>
            Fatura {monthName(month)} ×
          </button>
        )}
      </div>
      <div class="panel">
        {shown.length === 0 ? (
          <div class="empty">Nenhuma compra parcelada com esses filtros.</div>
        ) : (
          <ul class="rows tall purchases">
            {shown.map((p) => (
              <PurchaseRow key={p.id} p={p} hidden={hidden} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function LimitsPanel({ data, hidden }: { data: CardsView; hidden: boolean }) {
  return (
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
        {limitRows(data).map((r) => (
          <li key={r.key} class="limit-line">
            <div class="grow">
              <div>{r.name}{r.shared ? ' · limite compartilhado' : ''}</div>
              <Meter fraction={r.limit > 0 ? r.used / r.limit : 0} tip={`Usado ${hidden ? '••••' : brl(r.used)} de ${hidden ? '••••' : brl(r.limit)}`} />
            </div>
            <span class="muted limit-use">
              usado {brl(r.used, hidden)} de {brl(r.limit, hidden)} · disponível {brl(r.limit - r.used, hidden)}
            </span>
          </li>
        ))}
      </ul>
      <div class="note">Cartões que dividem um limite aparecem juntos e o limite é contado uma vez no total. Cartões ocultos em Ajustes não entram.</div>
    </div>
  );
}

export function CardsPage({ route, hidden, now }: { route: Route; now: Date; hidden: boolean }) {
  const cycle = route.params.get('cycle') ?? 'open';
  // Old links: installments now live under Futuras and limits under Faturas.
  const rawTab = route.params.get('tab') ?? 'cards';
  const tab = rawTab === 'installments' ? 'forecast' : rawTab === 'limits' ? 'cards' : rawTab;
  const { data, error, loading } = useLoad(() => api.cards(cycle), [cycle]);
  const installments = useLoad(() => api.installments(), []);
  const bills = useLoad(() => api.bills(), []);
  const currentBill = bills.data?.bars.find((b) => b.current)?.key;
  const today = localDay(now.toISOString());
  // The date shown is the oldest bill still owing; once it has passed, "next" would be a lie.
  const overdue = !!data?.totals.nextDueDate && data.totals.nextDueDate < today && data.totals.outstanding > 0;

  return (
    <div class="page-body">
      <h1 class="page-title">Cartões</h1>
      <div class="tabs">
        {[['cards', 'Faturas'], ['check', 'Conferir'], ['forecast', 'Futuras e parcelas']].map(([id, label]) => (
          <button key={id} class={tab === id ? 'tab on' : 'tab'} onClick={() => patchParams({ tab: id === 'cards' ? null : id })}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'cards' && bills.data && (
        <div class="panel">
          <h3>Faturas por mês de vencimento (clique em uma barra para ver a fatura)</h3>
          <Bars
            hidden={hidden}
            height={150}
            selected={cycle === 'open' ? (currentBill ?? 'open') : cycle}
            onSelect={(key) => patchParams({ cycle: key === cycle ? null : key })}
            data={bills.data.bars.map((b) => ({
              key: b.key,
              label: monthName(b.key).slice(0, 3),
              value: b.total,
              color: b.status === 'open' ? 'var(--accent)' : b.status === 'paid' ? 'var(--good)' : b.status === 'overdue' ? 'var(--bad)' : b.status === 'unknown' ? 'var(--muted)' : 'var(--warn)',
              tip: `Venc. ${monthName(b.key)}\n${hidden ? '••••' : brl(b.total)}${b.open ? ` · ${b.openCards} em aberto${b.closedCards > 0 ? `, ${b.closedCards} já fechada${b.closedCards === 1 ? '' : 's'}` : ''}` : b.outstanding > 0 ? ` · falta ${hidden ? '••••' : brl(b.outstanding)}` : ' · paga'}`,
            }))}
          />
          <div class="legend">
            <span><i style={{ background: 'var(--accent)' }} /> ainda abre cartão (os cartões fecham em dias diferentes)</span>
            <span><i style={{ background: 'var(--good)' }} /> paga</span>
            <span><i style={{ background: 'var(--warn)' }} /> a pagar</span>
            <span><i style={{ background: 'var(--muted)' }} /> pagamento não conferido</span>
            <span><i style={{ background: 'var(--bad)' }} /> vencida</span>
          </div>
        </div>
      )}
      {tab === 'cards' && (
        <label class="inline-field">
          Ciclo
          <Select ariaLabel="Fatura" value={cycle} onChange={(value) => patchParams({ cycle: value === 'open' ? null : value })} options={[{ value: 'open', label: 'Em aberto (atual)' }, ...[...new Set([...(data?.cycles ?? []), ...(cycle === 'open' ? [] : [cycle])])].sort().reverse().map((c) => ({ value: c, label: `Faturas com vencimento em ${monthName(c)}` }))]} />
        </label>
      )}
      {tab === 'check' && <CheckTab hidden={hidden} now={now} />}
      {tab === 'check' ? null : error || (loading && !data) ? (
        <Loading error={error} />
      ) : data ? (
        <>
          {tab === 'cards' && (
            <>
              <div class="summary">
                <div>
                  <span class="muted">{cycle === 'open' ? 'A pagar' : `A pagar com venc. ${monthName(cycle)}`}</span>
                  <strong>{brl(data.totals.toPay, hidden)}</strong>
                </div>
                {cycle === 'open' && (
                  <>
                    <div>
                      <span class="muted">Fatura aberta</span>
                      <strong>{brl(data.totals.toPay - data.totals.outstanding, hidden)}</strong>
                    </div>
                    <div>
                      <span class="muted">Fechadas não pagas</span>
                      <strong>{brl(data.totals.outstanding, hidden)}</strong>
                    </div>
                  </>
                )}
                <div>
                  <span class="muted">{overdue ? 'Vencimento mais antigo em atraso' : cycle === 'open' ? 'Próximo vencimento' : 'Vencimento'}</span>
                  <strong class={overdue ? 'bad-text' : ''}>{data.totals.nextDueDate ? fullDay(data.totals.nextDueDate) : '–'}</strong>
                </div>
                {cycle === 'open' && (
                  <>
                    <div>
                      <span class="muted">Parcelas de faturas futuras</span>
                      <strong>{brl(data.totals.futureInstallments, hidden)}</strong>
                    </div>
                    <div>
                      <span class="muted">Saldo devedor nos emissores</span>
                      <strong>{brl(data.totals.reportedByIssuer, hidden)}</strong>
                    </div>
                  </>
                )}
              </div>
              {data.totals.unexplained > 0 && cycle === 'open' && (
                <div class="note">
                  Na fatura em aberto, {brl(data.totals.unexplained, hidden)} vêm do limite usado que o banco informa para o limite compartilhado e que nenhuma compra ou parcela listada explica. Por isso a soma dos cartões mostrados é menor que o total. Pode ser uma compra que o banco ainda não enviou; o que aparecer depois reduz esse valor.
                </div>
              )}
              {cycle === 'open' ? (
                <div class="note">
                  O saldo devedor é o limite usado que cada banco informa: a fatura aberta, as faturas fechadas não pagas e todas as parcelas que ainda vão vencer. Por isso é maior que a fatura aberta. Cartões que dividem o mesmo limite entram uma vez. A fatura aberta de cada cartão é a soma das compras do ciclo; quando o banco ainda não publicou a fatura, o app estima o valor pelo saldo menos as parcelas futuras e marca como estimado. Cada cartão fecha num dia, então cada um aparece no seu ciclo atual.
                </div>
              ) : (
                <div class="note">Esta tela mostra só as faturas com vencimento em {monthName(cycle)}: o total, o que falta pagar e o vencimento são destas faturas. Limite, saldo do emissor e outras faturas ficam de fora.</div>
              )}
              <div class="cards-grid">
                {data.cards.filter((card) => cycle === 'open' || card.cycle !== null).map((card) => (
                  <CardBlock key={card.id} card={card} cycle={cycle} hidden={hidden} today={today} />
                ))}
              </div>
              {cycle !== 'open' && !data.cards.some((card) => card.cycle !== null) && <div class="empty">Nenhum cartão tem fatura com vencimento em {monthName(cycle)}.</div>}
              <h2 class="section-title">Limites</h2>
              <LimitsPanel data={data} hidden={hidden} />
            </>
          )}
          {tab === 'forecast' && <ForecastTab hidden={hidden} installments={installments} route={route} />}
        </>
      ) : null}
    </div>
  );
}
