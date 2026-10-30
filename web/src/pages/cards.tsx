import { useState } from 'preact/hooks';
import { api, type CardsView } from '../api.ts';
import { Bars, Meter, StackedBars } from '../charts.tsx';
import { brl, dayMonth, monthName } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { patchParams, type Route } from '../router.ts';
import { MonthBars, PurchaseRow } from '../installments.tsx';
import { Go, Loading, StatusBadge } from '../ui.tsx';
import { Select } from '../Select.tsx';
import { patchParams as openParams } from '../router.ts';

const fullDay = (day: string) => `${dayMonth(day)}/${day.slice(0, 4)}`;

/** Closed bills whose published total differs from what the app adds up, each with the likeliest cause and a way to fix it. */
function CheckTab({ hidden }: { hidden: boolean }) {
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
  const { items, setAside } = check.data;
  return (
    <>
      <p class="muted">
        Compara o total de cada fatura fechada que o banco publicou com a soma das compras do ciclo. Quando uma compra perto do fechamento explica a diferença dos dois lados, a sugestão é movê-la para a fatura vizinha. O que nenhuma compra explica é algo que o banco não mandou (lance à mão em “+ Nova”) ou que ele não cobra (ignore a transação).
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
                    {s.kind === 'missing' && <div class="muted">O banco cobra {brl(s.amount, hidden)} que nenhuma compra perto do fechamento explica. Provavelmente uma compra, juros ou IOF que não chegaram: lance à mão em “+ Nova”.</div>}
                    {s.kind === 'extra' && <div class="muted">O app soma {brl(s.amount, hidden)} a mais do que o banco cobrou e nenhuma compra perto do fechamento explica. Pode ser uma pendente que o banco nunca lançou: abra a compra suspeita e ignore ou mude o status.</div>}
                  </div>
                  {s.kind === 'move' && (
                    <button class="primary small" disabled={busy === key} onClick={() => void apply(key, async () => { for (const m of s.moves) await api.setCycle(m.transactionId, m.toCycleKey); })}>
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
  const settle = async (key: string, settled: boolean | null) => {
    await api.setCycleSettled(accountId, key, settled);
    reload();
  };
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
              {c.adjusted && (
                <div class="muted">
                  {brl(c.adjusted.amount, hidden)} da fatura não foi cobrado
                  {c.adjusted.by === 'auto' ? ' (ajuste automático: as faturas seguintes foram pagas por inteiro)' : ' (você marcou como quitada)'}{' '}
                  <button class="link" onClick={() => void settle(c.key, c.adjusted?.by === 'auto' ? false : null)}>
                    {c.adjusted.by === 'auto' ? 'Não está certo' : 'Desfazer'}
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
            {card.estimated ? ' · estimado: saldo do emissor menos as parcelas de faturas futuras' : ''}
          </div>
          <dl class="facts inline">
            <dt>Lançado no ciclo</dt>
            <dd>{brl(card.posted, hidden)}</dd>
            {card.futureInstallments > 0 && (
              <>
                <dt>Parcelas de faturas futuras</dt>
                <dd>{brl(card.futureInstallments, hidden)}</dd>
              </>
            )}
            <dt>Saldo devedor no emissor</dt>
            <dd>{brl(card.balance, hidden)}</dd>
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
      {c?.adjusted && <div class="note">{brl(c.adjusted.amount, hidden)} desta fatura não foi cobrado, então ela conta como paga{c.adjusted.by === 'auto' ? ' (ajuste automático)' : ''}.</div>}
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

function ForecastTab({ hidden }: { hidden: boolean }) {
  const { data, error } = useLoad(() => api.forecast(), []);
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const chosen = data.months.find((m) => m.key === open) ?? null;
  return (
    <>
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
              { value: m.variable, color: 'var(--track)', label: 'gasto de costume (estimativa)' },
            ],
          }))}
        />
        <div class="legend">
          <span><i style={{ background: 'var(--good)' }} /> parcelas já compradas (certo)</span>
          <span><i style={{ background: 'var(--accent)' }} /> cobranças que se repetem (provável)</span>
          <span><i style={{ background: 'var(--track)' }} /> gasto de costume (chute pela média)</span>
        </div>
      </div>
      <div class="panel">
        <table class="table">
          <thead>
            <tr>
              <th>Vencimento</th>
              <th>Parcelas</th>
              <th>Repetem</th>
              <th>De costume</th>
              <th>Estimado</th>
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
                <td>{brl(m.variable, hidden)}</td>
                <td>
                  <strong>{brl(m.total, hidden)}</strong>
                  {m.open && m.known > 0 && <div class="muted">já tem {brl(m.known, hidden)}</div>}
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
                    parcelas {brl(c.installments, hidden)} · repetem {brl(c.recurring, hidden)} · de costume {brl(c.variable, hidden)}
                  </div>
                </div>
                <strong>{brl(c.total, hidden)}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="panel">
        <h3>Como foi calculado</h3>
        <div class="muted">
          Parcelas já compradas vêm do plano de parcelas e são certas. As cobranças que se repetem são as que apareceram em pelo menos 3 meses, com valor estável (até 10% de variação), e entram todo mês pelo último valor. O gasto de costume é uma média das últimas faturas fechadas depois de tirar parcelas e repetidas: é um chute e cai ou sobe conforme o seu mês. A fatura em aberto nunca é estimada abaixo do que já tem.
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
          <span class="muted">Neste ciclo</span>
          <strong>{brl(v.thisCycle, hidden)}</strong>
        </div>
        <div>
          <span class="muted">No próximo ciclo</span>
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
          <span><i style={{ background: 'var(--accent)' }} /> ciclo em aberto</span>
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
        {[['cards', 'Faturas'], ['check', 'Conferir'], ['forecast', 'Futuras'], ['installments', 'Parcelas'], ['limits', 'Limites']].map(([id, label]) => (
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
          <Select ariaLabel="Ciclo" value={cycle} onChange={(value) => patchParams({ cycle: value === 'open' ? null : value })} options={[{ value: 'open', label: 'Em aberto (atual)' }, ...(data?.cycles ?? []).map((c) => ({ value: c, label: `Faturas com vencimento em ${monthName(c)}` }))]} />
        </label>
      )}
      {tab === 'check' && <CheckTab hidden={hidden} />}
      {tab === 'check' ? null : error || (loading && !data) ? (
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
                  <span class="muted">Parcelas de faturas futuras</span>
                  <strong>{brl(data.totals.futureInstallments, hidden)}</strong>
                </div>
                <div>
                  <span class="muted">Saldo devedor nos emissores</span>
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
          {tab === 'forecast' && <ForecastTab hidden={hidden} />}
          {tab === 'installments' && <InstallmentsTab installments={installments} hidden={hidden} route={route} />}
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
