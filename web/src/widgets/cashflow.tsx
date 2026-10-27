import { api } from '../api.ts';
import { DayDots } from '../charts.tsx';
import { brl, PERIODS, periodRange, type PeriodId } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { PeriodSelect, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

export function CashflowWidget({ now, hidden, size, config, setConfig }: WidgetProps) {
  const period = (config.period ?? 'month') as PeriodId;
  const range = periodRange(period, now);
  const { data, error, loading } = useLoad(() => api.cashflow(range.from, range.to), [range.from, range.to], 120_000);
  return (
    <Widget
      title="Fluxo de caixa"
      to={{ page: 'cashflow', params: { from: range.from, to: range.to } }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      actions={<PeriodSelect value={period} options={PERIODS} onChange={(id) => setConfig({ period: id })} />}
    >
      {data && (
        <>
          <div class="big">{brl(data.net, hidden)}</div>
          {size !== 'sm' && (
            <>
              <div class="pair">
                <div>
                  <span class="muted">Entradas</span>
                  <strong class="good-text">{brl(data.inflow, hidden)}</strong>
                </div>
                <div>
                  <span class="muted">Saídas</span>
                  <strong class="bad-text">{brl(data.outflow, hidden)}</strong>
                </div>
              </div>
              <DayDots days={data.days} from={data.from} to={data.to} />
            </>
          )}
          {size === 'lg' && <div class="note">Considera só o dinheiro que entra e sai das contas. Compras no cartão entram quando a fatura é paga.</div>}
        </>
      )}
    </Widget>
  );
}
