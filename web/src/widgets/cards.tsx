import { api } from '../api.ts';
import { Meter, Ring } from '../charts.tsx';
import { brl, dayMonth, monthName } from '../format.ts';
import { rowsFit } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { Go, StatusBadge } from '../ui.tsx';
import { PeriodSelect, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function CardsWidget({ item, now, hidden, size, config, setConfig }: WidgetProps) {
  const cycle = config.cycle ?? 'open';
  const { data, error, loading } = useLoad(() => api.cards(cycle), [cycle], 120_000);
  const options = [{ id: 'open', label: 'Em aberto' }, ...(data?.cycles ?? []).map((c) => ({ id: c, label: `Venc. ${monthName(c)}` }))];
  const limit = Math.max(rowsFit(item.h, 5), 1);
  const used = data && data.totals.creditLimit > 0 ? data.totals.used / data.totals.creditLimit : 0;
  return (
    <Widget
      title="Faturas"
      to={{ page: 'cards', params: { cycle } }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      actions={<PeriodSelect value={cycle} options={options} onChange={(id) => setConfig({ cycle: id })} />}
    >
      {data && (
        <>
          <div class="big">{brl(data.totals.cycleTotal, hidden)}</div>
          <div class="muted">
            {cycle === 'open' ? 'Ciclo em aberto' : `Faturas com vencimento em ${monthName(cycle)}`}
            {data.totals.nextDueDate ? ` · próximo vencimento ${dayMonth(data.totals.nextDueDate)}` : ''}
          </div>
          {data.totals.outstanding > 0 && <div class="badge warn">Fechadas e não pagas: {brl(data.totals.outstanding, hidden)}</div>}
          {size !== 'sm' && (
            <>
              {size === 'lg' && (
                <div class="split">
                  <Ring size={110} segments={[{ value: data.totals.used, color: 'var(--accent)' }, { value: data.totals.available, color: 'transparent' }]}>
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
              <ul class="rows tall">
                {data.cards.slice(0, limit).map((c) => (
                  <li key={c.id}>
                    <div class="grow">
                      <Go class="clip" page="transactions" params={{ accountId: c.id, cycle: c.cycle ? (cycle === 'open' ? 'open' : c.cycle.key) : undefined }}>
                        {c.institution} {c.name}
                        {c.last4 ? ` •••• ${c.last4}` : ''}
                      </Go>
                      <Meter fraction={c.creditLimit ? 1 - (c.availableLimit ?? c.creditLimit - c.balance) / c.creditLimit : 0} />
                      <div class="muted">
                        {c.cycle ? <StatusBadge status={c.cycle.status} /> : null} {c.nextDueDate ? `vence ${dayMonth(c.nextDueDate)}` : ''}
                      </div>
                    </div>
                    <strong>{brl(c.total, hidden)}</strong>
                  </li>
                ))}
              </ul>
              {data.cards.length > limit && <Go page="cards" params={{ cycle }}>e mais {data.cards.length - limit}</Go>}
            </>
          )}
        </>
      )}
    </Widget>
  );
}
