import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { CalendarDay } from '../api.ts';
import { brl, dayMonth, localDay, monthName } from '../format.ts';
import { TxRow } from '../ui.tsx';
import { useLoad } from '../hooks.ts';
import { navigate, patchParams, type Route } from '../router.ts';
import { Loading } from '../ui.tsx';
import { cellMoney, recurringWhen } from './page-logic.ts';

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/** A day total. On a phone the cell is about 48 px wide, so thousands are written as "3,8 mil" there and in full on a wide screen. */
function Amount({ sign, cents, hidden, class: className }: { sign: string; cents: number; hidden: boolean; class: string }) {
  const text = cellMoney(cents, hidden);
  return (
    <span class={className}>
      {sign}
      <span class="cal-long">{text.full}</span>
      <span class="cal-short">{text.short}</span>
    </span>
  );
}

function Cell({ d, today, picked, onPick, hidden }: { d: CalendarDay; today: string; picked: boolean; onPick: () => void; hidden: boolean }) {
  const out = d.projected.filter((p) => p.direction === 'out').reduce((s, p) => s + p.amount, 0);
  const inn = d.projected.filter((p) => p.direction === 'in').reduce((s, p) => s + p.amount, 0);
  const bills = d.projected.filter((p) => p.kind === 'bill').length;
  const late = d.projected.some((p) => p.kind === 'bill' && p.late);
  const className = ['cal-cell', d.day === today ? 'today' : '', picked ? 'picked' : '', d.day < today ? 'past' : ''].filter(Boolean).join(' ');
  return (
    <button class={className} onClick={onPick} aria-label={`${dayMonth(d.day)}`} aria-pressed={picked}>
      <span class="cal-day">{Number(d.day.slice(8, 10))}</span>
      {d.inflow > 0 && <Amount sign="+" cents={d.inflow} hidden={hidden} class="cal-in" />}
      {d.outflow > 0 && <Amount sign="−" cents={d.outflow} hidden={hidden} class="cal-out" />}
      {inn > 0 && <Amount sign="+" cents={inn} hidden={hidden} class="cal-in soft" />}
      {out > 0 && <Amount sign="−" cents={out} hidden={hidden} class="cal-out soft" />}
      {bills > 0 && (
        <span class={late ? 'cal-tag bad-text' : 'cal-tag'}>
          {bills === 1 ? 'fatura' : (<><span class="cal-long">{bills} faturas</span><span class="cal-short">{bills} fat.</span></>)}
        </span>
      )}
    </button>
  );
}

export function CalendarPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const current = localDay(now.toISOString()).slice(0, 7);
  const month = route.params.get('month') ?? current;
  const { data, error, loading, reload } = useLoad(() => api.calendar(month), [month]);
  // The item just removed from the list, so one tap can bring it back.
  const [removed, setRemoved] = useState<{ key: string; name: string; label: 'subscription' | 'recurring' | null } | null>(null);
  // An item the owner marked only leaves the list when the mark says so; ignoring it would be overridden by the mark.
  const remove = async (r: { key: string; name: string; manual: boolean; label: 'subscription' | 'recurring' | null }) => {
    if (r.manual) await api.markRecurring(r.key, 'none');
    else await api.ignoreRecurring(r.key, true);
    setRemoved({ key: r.key, name: r.name, label: r.manual ? (r.label === 'subscription' ? 'subscription' : 'recurring') : null });
    reload();
  };
  const restore = async () => {
    if (!removed) return;
    if (removed.label) await api.markRecurring(removed.key, removed.label);
    else await api.ignoreRecurring(removed.key, false);
    setRemoved(null);
    reload();
  };
  // One tap selects a day; a second tap on another day selects the days between; a tap on a selected single day clears it.
  const [picked, setPicked] = useState<{ from: string; to: string } | null>(null);
  const tap = (day: string) => {
    if (!picked || picked.from !== picked.to) setPicked(picked && picked.from === picked.to && picked.from === day ? null : { from: day, to: day });
    else if (picked.from === day) setPicked(null);
    else setPicked(day < picked.from ? { from: day, to: picked.from } : { from: picked.from, to: day });
  };
  const go = (m: string) => {
    setPicked(null);
    patchParams({ month: m === current ? null : m });
  };
  if (error || (loading && !data)) return <div class="page-body"><h1 class="page-title">Calendário</h1><Loading error={error} /></div>;
  if (!data) return null;
  const first = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const expected = data.days.filter((d) => d.day >= data.today).flatMap((d) => d.projected);
  const ahead = { out: expected.filter((p) => p.direction === 'out').reduce((s, p) => s + p.amount, 0), in: expected.filter((p) => p.direction === 'in').reduce((s, p) => s + p.amount, 0) };
  return (
    <div class="page-body">
      <h1 class="page-title">Calendário</h1>
      <div class="period">
        <button class="icon small" onClick={() => go(addMonths(month, -1))} aria-label="Mês anterior">
          ‹
        </button>
        <strong>{monthName(month)}</strong>
        <button class="icon small" onClick={() => go(addMonths(month, 1))} aria-label="Próximo mês">
          ›
        </button>
        {month !== current && (
          <button class="link" onClick={() => go(current)}>
            Mês atual
          </button>
        )}
      </div>
      <div class="panel">
        <div class="cal-grid" role="grid">
          {WEEKDAYS.map((w) => (
            <div class="cal-head" key={w}>
              {w}
            </div>
          ))}
          {Array.from({ length: first }, (_, i) => (
            <div key={`b${i}`} class="cal-blank" />
          ))}
          {data.days.map((d) => (
            <Cell key={d.day} d={d} today={data.today} picked={picked !== null && d.day >= picked.from && d.day <= picked.to} hidden={hidden} onPick={() => tap(d.day)} />
          ))}
        </div>
        {ahead.out + ahead.in > 0 && (
          <div class="cal-ahead">
            Previsto de hoje até o fim do mês: saem {brl(ahead.out, hidden)} e entram {brl(ahead.in, hidden)}.
          </div>
        )}
        <div class="note">Os números em cor forte são o que passou pela conta no dia. Em cinza claro e itálico, o que se espera a partir de hoje: contas que se repetem todo mês e as faturas de cartão no vencimento. Uma fatura vencida e ainda não paga aparece em hoje, marcada como atrasada, e pode somar vários cartões. Só entram cobranças que saem da conta; o que vai no cartão já está na fatura.</div>
      </div>
      {picked && <Selection from={picked.from} to={picked.to} days={data.days} hidden={hidden} onClear={() => setPicked(null)} />}
      <section class="panel">
        <h2>Contas e entradas que se repetem</h2>
        <div class="muted">Achadas nas suas transações: pelo menos três, em três meses diferentes, com cerca de um mês entre elas e valor parecido. As que você marcou como recorrentes ou assinatura aparecem desde a primeira cobrança, por isso algumas têm menos de três.</div>
        {removed && (
          <div class="note">
            “{removed.name}” saiu da lista. <button class="link" onClick={() => void restore()}>Desfazer</button>
          </div>
        )}
        {data.recurring.length === 0 ? (
          <div class="empty">Nenhuma ainda.</div>
        ) : (
          <ul class="rows tall">
            {data.recurring.map((r) => (
              <li key={`${r.key}|${r.dayOfMonth}`} class="recurring-row">
                <div class="grow">
                  <div class="clip">
                    {r.name} {r.label === 'subscription' && <span class="badge info">assinatura</span>} {r.manual && <span class="badge muted">marcada por você</span>} {r.kind === 'variable' && <span class="badge muted">valor varia</span>} {r.account === 'card' && <span class="badge muted">no cartão</span>} {r.late && <span class="badge bad">atrasado</span>} {r.stale && <span class="badge muted">parou de cobrar</span>} {!r.regular && !r.stale && <span class="badge muted">sem periodicidade clara</span>}
                  </div>
                  <div class="muted">
                    {r.regular && !r.stale ? recurringWhen(r, data.today) : `${r.occurrences} ${r.occurrences === 1 ? 'vez' : 'vezes'} · última ${dayMonth(r.lastDay)}`}
                  </div>
                </div>
                <strong class={r.direction === 'in' ? 'good-text' : ''}>
                  {r.direction === 'in' ? '+' : '−'}
                  {brl(r.amount, hidden)}
                </strong>
                <button class="small" title="Não é recorrente: sai desta lista e do calendário" onClick={() => void remove(r)}>
                  Remover da lista
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The transactions of the chosen day or days, what is expected in them, and the totals. */
function Selection({ from, to, days, hidden, onClear }: { from: string; to: string; days: CalendarDay[]; hidden: boolean; onClear: () => void }) {
  const list = useLoad(() => api.explore(new URLSearchParams({ from, to, limit: '200', sort: 'date_desc', includeExcluded: 'false' })), [from, to]);
  const inside = days.filter((d) => d.day >= from && d.day <= to);
  const expected = inside.flatMap((d) => d.projected.map((p) => ({ ...p, day: d.day })));
  const last = inside.at(-1);
  const title = from === to ? `${dayMonth(from)}/${from.slice(0, 4)}` : `${dayMonth(from)} a ${dayMonth(to)}/${to.slice(0, 4)}`;
  return (
    <section class="panel">
      <div class="panel-head">
        <h2>{title}</h2>
        <button class="link" onClick={onClear}>
          Limpar seleção
        </button>
      </div>
      {list.data && (
        <div class="muted">
          {list.data.total} {list.data.total === 1 ? 'transação' : 'transações'} · entrou {brl(list.data.sums.income, hidden)} · saiu {brl(list.data.sums.expense, hidden)}
          {' · '}
          <button class="link" onClick={() => navigate('transactions', { from, to })}>
            Abrir em Transações
          </button>
        </div>
      )}
      {!list.data ? (
        <Loading error={list.error} />
      ) : list.data.items.length === 0 ? (
        <div class="empty">Nenhuma transação {from === to ? 'neste dia' : 'neste período'}.</div>
      ) : (
        <ul class="rows tall tx-list">
          {list.data.items.map((t) => (
            <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} />
          ))}
        </ul>
      )}
      {list.data && list.data.total > list.data.items.length && <div class="note">Mostrando as {list.data.items.length} mais recentes.</div>}
      {expected.length > 0 && (
        <>
          <h3>Esperado</h3>
          <ul class="rows">
            {expected.map((p, i) => (
              <li key={i}>
                <span class="muted">{dayMonth(p.day)}</span>
                <span class="grow clip">
                  {p.name} {p.late && <span class="badge bad">atrasado</span>}
                  {p.note && <small class="muted"> · {p.note}</small>}
                </span>
                <span class="muted">{p.kind === 'bill' ? 'fatura' : 'esperado'}</span>
                <strong class={p.direction === 'in' ? 'good-text' : ''}>
                  {p.direction === 'in' ? '+' : '−'}
                  {brl(p.amount, hidden)}
                </strong>
              </li>
            ))}
          </ul>
        </>
      )}
      {last?.balance != null && <div class="muted">Saldo projetado nas contas ao fim de {dayMonth(last.day)}: {brl(last.balance, hidden)}</div>}
    </section>
  );
}
