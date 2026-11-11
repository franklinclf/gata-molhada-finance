import { api } from '../api.ts';
import { Bars } from '../charts.tsx';
import { flowColumns } from '../flow.ts';
import { brl, monthName, PERIODS, periodRange, type PeriodId } from '../format.ts';
import { chartHeight } from '../grid.ts';
import { useLoad } from '../hooks.ts';
import { PeriodSelect, Widget } from '../Widget.tsx';
import type { WidgetProps } from './index.ts';

/** The same span one period earlier: a month before for "Este mês", three months for "3 meses" and so on. */
function previousRange(from: string, period: PeriodId): { from: string; to: string } {
  const months = { month: 1, '3m': 3, '6m': 6, '1y': 12 }[period];
  const [year, month] = from.split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) - months;
  const start = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
  const end = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return { from: start, to: end };
}

export function CashflowWidget({ now, hidden, size, pixels, config, setConfig }: WidgetProps) {
  const period = (config.period ?? 'month') as PeriodId;
  const range = periodRange(period, now);
  const before = previousRange(range.from, period);
  const { data, error, loading } = useLoad(() => api.cashflow(range.from, range.to), [range.from, range.to], 120_000);
  const prev = useLoad(() => api.cashflow(before.from, before.to), [before.from, before.to], 300_000);
  const columns = data ? flowColumns(data.days, data.from, data.to, period === 'month') : [];
  // The chart takes the height left under the figures; the comparison below it shows only when there is room for it.
  const roomy = pixels !== undefined && pixels.height >= 470;
  const height = chartHeight(pixels, roomy ? 330 : 270, 90, 260);
  return (
    <Widget
      title="Fluxo de caixa"
      to={{ page: 'cashflow', params: { from: range.from, to: range.to } }}
      asOf={data?.oldestDataAt}
      now={now}
      loading={loading && !data}
      error={error}
      actions={<PeriodSelect value={period} options={PERIODS} onChange={(id) => setConfig({ period: id })} />}
      head={
        data && (
          <>
            <div class="big" data-tip="Só o dinheiro que entra e sai das contas. Compras no cartão entram quando a fatura é paga.">{brl(data.net, hidden)}</div>
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
                <Bars
                  hidden={hidden}
                  height={height}
                  data={columns.flatMap((c) => [
                    { key: `${c.key}-in`, group: c.key, label: c.label, value: c.inflow, color: 'var(--good)', tip: `${c.tip}\nEntrou ${hidden ? '••••' : brl(c.inflow)}\nSaiu ${hidden ? '••••' : brl(c.outflow)}` },
                    { key: `${c.key}-out`, group: c.key, label: '', value: c.outflow, color: 'var(--bad)', tip: `${c.tip}\nEntrou ${hidden ? '••••' : brl(c.inflow)}\nSaiu ${hidden ? '••••' : brl(c.outflow)}` },
                  ])}
                />
              </>
            )}
          </>
        )
      }
    >
      {data && size !== 'sm' && (pixels === undefined || pixels.height >= 400) && (
        <dl class="facts inline">
          {prev.data && (
            <>
              <dt>{period === 'month' ? `Saldo de ${monthName(before.from.slice(0, 7))} (mês inteiro)` : 'Saldo do período anterior'}</dt>
              <dd>
                <span class={prev.data.net < 0 ? 'bad-text' : ''}>{brl(prev.data.net, hidden)}</span>
              </dd>
              {roomy && (
                <>
                  <dt>{period === 'month' ? `Entrou em ${monthName(before.from.slice(0, 7))}` : 'Entrou no período anterior'}</dt>
                  <dd>{brl(prev.data.inflow, hidden)}</dd>
                  <dt>{period === 'month' ? `Saiu em ${monthName(before.from.slice(0, 7))}` : 'Saiu no período anterior'}</dt>
                  <dd>{brl(prev.data.outflow, hidden)}</dd>
                </>
              )}
            </>
          )}
        </dl>
      )}
    </Widget>
  );
}
