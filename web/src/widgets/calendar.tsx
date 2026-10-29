import { api } from '../api.ts';
import { dayMonth, monthName } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { navigate } from '../router.ts';
import { Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

/** The month as a small grid: a dot on days with money moving, a ring on today. A tap opens that day in the calendar. */
export function CalendarWidget({ now, size }: WidgetProps) {
  const month = new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 7);
  const { data, error, loading } = useLoad(() => api.calendar(month), [month], 300_000);
  const first = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const next = data?.days.flatMap((d) => d.projected.map((p) => ({ ...p, day: d.day }))).filter((p) => p.day >= data.today).slice(0, size === 'lg' ? 6 : 3) ?? [];
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
              <button key={d.day} data-no-nav class={`mini-day${d.day === data.today ? ' today' : ''}${d.day < data.today ? ' past' : ''}`} onClick={() => navigate('calendar', { month })} aria-label={dayMonth(d.day)}>
                {Number(d.day.slice(8))}
                {(d.inflow > 0 || d.outflow > 0 || d.projected.length > 0) && <i class={d.projected.length > 0 && d.inflow + d.outflow === 0 ? 'dot soft' : 'dot'} />}
              </button>
            ))}
          </div>
          {size !== 'sm' && next.length > 0 && (
            <ul class="rows">
              {next.map((p, i) => (
                <li key={i}>
                  <span class="muted">{dayMonth(p.day)}</span>
                  <span class="grow clip">{p.name}</span>
                  <span class="muted">{p.kind === 'bill' ? 'fatura' : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Widget>
  );
}
