import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { CalendarDay } from '../api.ts';
import { brl, dayMonth, localDay, monthName } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { navigate, patchParams } from '../router.ts';
import { TxRow } from '../ui.tsx';
import { FitList, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

type Picked = { from: string; to: string } | null;

/** The transactions and what is expected in the chosen day or days, in a few lines. */
function Selection({ picked, days, hidden, month, rows }: { picked: { from: string; to: string }; days: CalendarDay[]; hidden: boolean; month: string; rows: number }) {
  const list = useLoad(() => api.explore(new URLSearchParams({ from: picked.from, to: picked.to, limit: String(rows), sort: 'date_desc', includeExcluded: 'false' })), [picked.from, picked.to, rows]);
  const expected = days.filter((d) => d.day >= picked.from && d.day <= picked.to).flatMap((d) => d.projected.map((p) => ({ ...p, day: d.day })));
  const title = picked.from === picked.to ? dayMonth(picked.from) : `${dayMonth(picked.from)} a ${dayMonth(picked.to)}`;
  return (
    <div class="mini-pick">
      <div class="mini-pick-head">
        <strong>{title}</strong>
        {list.data && (
          <span class="muted">
            {list.data.total} {list.data.total === 1 ? 'transação' : 'transações'} · saiu {brl(list.data.sums.expense, hidden)}
            {list.data.sums.income > 0 ? ` · entrou ${brl(list.data.sums.income, hidden)}` : ''}
          </span>
        )}
      </div>
      {!list.data ? (
        <div class="muted">Carregando...</div>
      ) : list.data.items.length === 0 && expected.length === 0 ? (
        <div class="muted">Nada neste {picked.from === picked.to ? 'dia' : 'período'}.</div>
      ) : (
        <ul class="rows tx-list">
          {list.data.items.map((t) => (
            <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} />
          ))}
        </ul>
      )}
      {expected.length > 0 && (
        <ul class="rows">
          {expected.map((p, i) => (
            <li key={i}>
              <span class="muted">{dayMonth(p.day)}</span>
              <span class="grow clip">{p.name}</span>
              <span class="muted">esperado{p.kind === 'bill' ? ' · fatura' : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {list.data && list.data.total > list.data.items.length && (
        <button class="link" data-no-nav onClick={() => navigate('transactions', { from: picked.from, to: picked.to })}>
          Ver as {list.data.total} em Transações
        </button>
      )}
      <button class="link" data-no-nav onClick={() => navigate('calendar', { month })}>
        Abrir o calendário
      </button>
    </div>
  );
}

/**
 * The month as a small grid: a dot on days with money moving, a ring on today. A tap selects a day and lists it below; a
 * tap on another day selects the days between, and a tap on the chosen day clears it.
 */
export function CalendarWidget({ now, size, hidden, pixels }: WidgetProps) {
  const [picked, setPicked] = useState<Picked>(null);
  const tap = (day: string) => {
    if (!picked || picked.from !== picked.to) setPicked({ from: day, to: day });
    else if (picked.from === day) setPicked(null);
    else setPicked(day < picked.from ? { from: day, to: picked.from } : { from: picked.from, to: day });
  };
  const month = localDay(now.toISOString()).slice(0, 7);
  const { data, error, loading } = useLoad(() => api.calendar(month), [month], 300_000);
  const first = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const next = data?.days.flatMap((d) => d.projected.map((p) => ({ ...p, day: d.day }))).filter((p) => p.day >= data.today).slice(0, 20) ?? [];
  return (
    <Widget title={`Calendário · ${monthName(month)}`} to={{ page: 'calendar' }} now={now} loading={loading && !data} error={error}>
      {data && (
        <>
          <div class="mini-cal" role="grid">
            {WEEKDAYS.map((w, i) => (
              <span key={i} class="mini-head">
                {w}
              </span>
            ))}
            {Array.from({ length: first }, (_, i) => (
              <span key={`b${i}`} />
            ))}
            {data.days.map((d) => (
              <button
                key={d.day}
                data-no-nav
                class={`mini-day${d.day === data.today ? ' today' : ''}${d.day < data.today ? ' past' : ''}${picked && d.day >= picked.from && d.day <= picked.to ? ' picked' : ''}`}
                onClick={() => tap(d.day)}
                aria-label={dayMonth(d.day)}
                aria-pressed={picked !== null && d.day >= picked.from && d.day <= picked.to}
              >
                {Number(d.day.slice(8))}
                {(d.inflow > 0 || d.outflow > 0 || d.projected.length > 0) && <i class={d.projected.length > 0 && d.inflow + d.outflow === 0 ? 'dot soft' : 'dot'} />}
              </button>
            ))}
          </div>
          {picked && <Selection picked={picked} days={data.days} hidden={hidden} month={month} rows={pixels ? Math.max(3, Math.min(20, Math.floor((pixels.height - 340) / 46))) : size === 'lg' ? 8 : 5} />}
          {!picked && size !== 'sm' && next.length > 0 && (
            <FitList
              noun={['item', 'itens']}
              rows={next.map((p, i) => (
                <li key={i}>
                  <span class="muted">{dayMonth(p.day)}</span>
                  <span class="grow clip">{p.name}</span>
                  <span class="muted">{p.kind === 'bill' ? 'fatura' : ''}</span>
                </li>
              ))}
            />
          )}
        </>
      )}
    </Widget>
  );
}
