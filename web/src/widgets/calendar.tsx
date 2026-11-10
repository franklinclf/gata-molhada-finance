import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { CalendarDay } from '../api.ts';
import { brl, dayMonth, localDay, monthName } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { navigate, patchParams } from '../router.ts';
import { Select } from '../Select.tsx';
import { TxRow } from '../ui.tsx';
import { MAX_WINDOW, monthsCovering, parseWindow, upcomingItems, upcomingTotals, WINDOW_PRESETS, windowLabel } from '../upcoming.ts';
import { Widget } from '../Widget.tsx';
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

/** The window of the summary: the usual choices, or any number of days from 1 to 90. */
function WindowPicker({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const preset = (WINDOW_PRESETS as readonly number[]).includes(days);
  const [custom, setCustom] = useState(!preset);
  const [text, setText] = useState(String(days));
  useEffect(() => setText(String(days)), [days]);
  const commit = (value: string) => {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_WINDOW) onChange(n);
    else setText(String(days));
  };
  return (
    <span class="window-pick" data-no-nav>
      <Select
        ariaLabel="Janela dos próximos vencimentos"
        value={custom || !preset ? 'custom' : String(days)}
        options={[...WINDOW_PRESETS.map((n) => ({ value: String(n), label: windowLabel(n) })), { value: 'custom', label: 'Outro número' }]}
        onChange={(value) => {
          if (value === 'custom') setCustom(true);
          else {
            setCustom(false);
            onChange(Number(value));
          }
        }}
      />
      {(custom || !preset) && (
        <input
          class="window-days"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_WINDOW}
          value={text}
          aria-label={`Dias, de 1 a ${MAX_WINDOW}`}
          onInput={(e) => setText(e.currentTarget.value)}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
        />
      )}
    </span>
  );
}

/**
 * The month as a small grid: a dot on days with money moving, a ring on today. A tap selects a day and lists it below; a
 * tap on another day selects the days between, and a tap on the chosen day clears it.
 */
export function CalendarWidget({ now, size, hidden, pixels, config, setConfig }: WidgetProps) {
  const [picked, setPicked] = useState<Picked>(null);
  const tap = (day: string) => {
    if (!picked || picked.from !== picked.to) setPicked({ from: day, to: day });
    else if (picked.from === day) setPicked(null);
    else setPicked(day < picked.from ? { from: day, to: picked.from } : { from: picked.from, to: day });
  };
  const month = localDay(now.toISOString()).slice(0, 7);
  const { data, error, loading } = useLoad(() => api.calendar(month), [month], 300_000);
  const first = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  // The summary under the grid: what is expected in the chosen window, which may reach into the next months.
  const windowDays = parseWindow(config.days);
  const later = data ? monthsCovering(data.today, windowDays).filter((m) => m !== month) : [];
  const extra = useLoad(() => Promise.all(later.map((m) => api.calendar(m))), [later.join(',')], 300_000);
  const next = data ? upcomingItems([...data.days, ...(extra.data ?? []).flatMap((c) => c.days)], data.today, windowDays) : [];
  const total = upcomingTotals(next);
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
          {!picked && size !== 'sm' && (
            <div class="upcoming">
              <div class="upcoming-head">
                <div class="grow">
                  <strong>{brl(total.out, hidden)}</strong> <span class="muted">a pagar em {windowLabel(windowDays)}</span>
                  <div class="muted">
                    {total.count} {total.count === 1 ? 'item' : 'itens'}
                    {total.in > 0 ? ` · ${brl(total.in, hidden)} a receber` : ''}
                    {extra.loading && !extra.data && later.length > 0 ? ' · carregando…' : ''}
                  </div>
                </div>
                <WindowPicker days={windowDays} onChange={(n) => setConfig({ days: String(n) })} />
              </div>
              {next.length === 0 ? (
                <div class="muted">Nada esperado em {windowLabel(windowDays)}.</div>
              ) : (
                <ul class="rows upcoming-list">
                  {next.map((p, i) => (
                    <li key={`${p.day}${p.name}${i}`}>
                      <span class="muted">{dayMonth(p.day)}</span>
                      <span class="grow clip">
                        {p.name} {p.late && <span class="badge bad">atrasado</span>}
                      </span>
                      <strong class={p.direction === 'in' ? 'good-text' : ''}>
                        {p.direction === 'in' ? '+' : '−'}
                        {brl(p.amount, hidden)}
                      </strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </Widget>
  );
}
