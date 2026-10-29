import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { CalendarDay } from '../api.ts';
import { brl, dayMonth, monthName } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { navigate, patchParams, type Route } from '../router.ts';
import { Loading } from '../ui.tsx';

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

function Cell({ d, today, picked, onPick, hidden }: { d: CalendarDay; today: string; picked: boolean; onPick: () => void; hidden: boolean }) {
  const out = d.projected.filter((p) => p.direction === 'out').reduce((s, p) => s + p.amount, 0);
  const inn = d.projected.filter((p) => p.direction === 'in').reduce((s, p) => s + p.amount, 0);
  const className = ['cal-cell', d.day === today ? 'today' : '', picked ? 'picked' : '', d.day < today ? 'past' : ''].filter(Boolean).join(' ');
  return (
    <button class={className} onClick={onPick} aria-label={`${dayMonth(d.day)}`} aria-pressed={picked}>
      <span class="cal-day">{Number(d.day.slice(8, 10))}</span>
      {d.inflow > 0 && <span class="cal-in">+{hidden ? '••' : brl(d.inflow).replace(/\s?R\$\s?/, '')}</span>}
      {d.outflow > 0 && <span class="cal-out">−{hidden ? '••' : brl(d.outflow).replace(/\s?R\$\s?/, '')}</span>}
      {inn > 0 && <span class="cal-in soft">+{hidden ? '••' : brl(inn).replace(/\s?R\$\s?/, '')}</span>}
      {out > 0 && <span class="cal-out soft">−{hidden ? '••' : brl(out).replace(/\s?R\$\s?/, '')}</span>}
    </button>
  );
}

export function CalendarPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const current = new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 7);
  const month = route.params.get('month') ?? current;
  const { data, error, loading, reload } = useLoad(() => api.calendar(month), [month]);
  const [picked, setPicked] = useState<string | null>(null);
  const go = (m: string) => {
    setPicked(null);
    patchParams({ month: m === current ? null : m });
  };
  if (error || (loading && !data)) return <div class="page-body"><h1 class="page-title">Calendário</h1><Loading error={error} /></div>;
  if (!data) return null;
  const first = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const day = picked ? data.days.find((d) => d.day === picked) : undefined;
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
            <Cell key={d.day} d={d} today={data.today} picked={picked === d.day} hidden={hidden} onPick={() => setPicked(picked === d.day ? null : d.day)} />
          ))}
        </div>
        <div class="note">Em cinza claro e itálico, o que se espera a partir de hoje: contas que se repetem todo mês e as faturas de cartão no vencimento. Só entram cobranças que saem da conta; o que vai no cartão já está na fatura.</div>
      </div>
      {day && (
        <section class="panel">
          <h2>{dayMonth(day.day)}/{day.day.slice(0, 4)}</h2>
          {day.inflow + day.outflow > 0 && (
            <div class="muted">
              Na conta: entrou {brl(day.inflow, hidden)}, saiu {brl(day.outflow, hidden)}.{' '}
              <button class="link" onClick={() => navigate('transactions', { from: day.day, to: day.day })}>
                Ver as transações
              </button>
            </div>
          )}
          {day.projected.length > 0 && (
            <ul class="rows">
              {day.projected.map((p, i) => (
                <li key={i}>
                  <span class="grow clip">
                    {p.name} {p.late && <span class="badge bad">atrasado</span>}
                  </span>
                  <span class="muted">{p.kind === 'bill' ? 'fatura' : 'esperado'}</span>
                  <strong class={p.direction === 'in' ? 'good-text' : ''}>
                    {p.direction === 'in' ? '+' : '−'}
                    {brl(p.amount, hidden)}
                  </strong>
                </li>
              ))}
            </ul>
          )}
          {day.balance !== null && <div class="muted">Saldo projetado nas contas ao fim do dia: {brl(day.balance, hidden)}</div>}
          {day.projected.length === 0 && day.inflow + day.outflow === 0 && <div class="empty">Nada neste dia.</div>}
        </section>
      )}
      <section class="panel">
        <h2>Contas e entradas que se repetem</h2>
        <div class="muted">Achadas nas suas transações: pelo menos três, em três meses diferentes, com cerca de um mês entre elas e valor parecido.</div>
        {data.recurring.length === 0 ? (
          <div class="empty">Nenhuma ainda.</div>
        ) : (
          <ul class="rows tall">
            {data.recurring.map((r) => (
              <li key={r.key}>
                <div class="grow">
                  <div class="clip">
                    {r.name} {r.kind === 'variable' && <span class="badge muted">valor varia</span>} {r.account === 'card' && <span class="badge muted">no cartão</span>} {r.late && <span class="badge bad">atrasado</span>}
                  </div>
                  <div class="muted">
                    todo dia {r.dayOfMonth} · {r.occurrences} vezes · próximo {dayMonth(r.nextDay)}
                  </div>
                </div>
                <strong class={r.direction === 'in' ? 'good-text' : ''}>
                  {r.direction === 'in' ? '+' : '−'}
                  {brl(r.amount, hidden)}
                </strong>
                <button class="link" onClick={() => void api.ignoreRecurring(r.key, true).then(reload)}>
                  Não é recorrente
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
