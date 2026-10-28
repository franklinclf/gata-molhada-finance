import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Bars, LineChart, PALETTE, Ring } from '../charts.tsx';
import { brl, cumulative, lastMonths, monthBounds, monthName, percent, sumByMonth } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { PeriodPicker, PRESETS } from '../period.tsx';
import { patchParams, type Route } from '../router.ts';
import { localDay } from '../format.ts';
import { Go, Loading, TxRow } from '../ui.tsx';

/** What a category (or merchant) is made of: the individual transactions, loaded when the row is opened. */
function Members({ name, by, from, to, hidden }: { name: string; by: 'category' | 'merchant'; from: string; to: string; hidden: boolean }) {
  const query = new URLSearchParams({ from, to, kind: 'expense', spendingOnly: 'true', sort: 'amount_desc', limit: '15' });
  query.set(by === 'category' ? 'category' : 'merchant', name);
  const { data, error } = useLoad(() => api.explore(query), [name, by, from, to]);
  if (!data) return <Loading error={error} />;
  return (
    <div class="members">
      <ul class="rows tall tx-list">
        {data.items.map((t) => (
          <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} />
        ))}
      </ul>
      <Go page="transactions" params={Object.fromEntries(query)}>
        Ver {data.total > 15 ? `as ${data.total}` : 'todas'} em Transações
      </Go>
    </div>
  );
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function SpendingPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const today = localDay(now.toISOString());
  const month = PRESETS.find((p) => p.id === 'month')!.range(today);
  const from = route.params.get('from') ?? month.from;
  const to = route.params.get('to') ?? month.to;
  const by = route.params.get('by') === 'merchant' ? 'merchant' : 'category';
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading } = useLoad(() => api.spending(from, to, by), [from, to, by]);
  const months = lastMonths(today, 12);
  const year = useLoad(() => api.spending(`${months[0]}-01`, today, 'category'), [today]);
  const perMonth = new Map(months.map((m) => [m, 0]));
  for (const row of sumByMonth(year.data?.daily ?? [])) perMonth.set(row.month, row.amount);
  const selectedMonth = from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === monthBounds(from.slice(0, 7), today).to ? from.slice(0, 7) : null;

  return (
    <div class="page-body">
      <h1 class="page-title">Gastos</h1>
      <PeriodPicker from={from} to={to} now={now} onChange={(r) => patchParams({ from: r.from ?? month.from, to: r.to ?? month.to })} />
      <div class="tabs">
        <button class={by === 'category' ? 'tab on' : 'tab'} onClick={() => patchParams({ by: 'category' })}>Categorias</button>
        <button class={by === 'merchant' ? 'tab on' : 'tab'} onClick={() => patchParams({ by: 'merchant' })}>Estabelecimentos</button>
      </div>
      {error || (loading && !data) ? (
        <Loading error={error} />
      ) : data ? (
        <>
          <div class="panel">
            <div class="big">{brl(data.total, hidden)}</div>
            <div class="muted">
              {data.groups.length} {by === 'category' ? 'categorias' : 'estabelecimentos'} · compras no cartão entram na data da compra
              {data.creditsNotListed > 0 && ` · já descontados ${brl(data.creditsNotListed, hidden)} em estornos`}
            </div>
            <LineChart points={cumulative(data.daily, data.from, data.to)} hidden={hidden} days={daysBetween(data.from, data.to)} />
            <h3>Últimos 12 meses (clique em um mês)</h3>
            <Bars
              hidden={hidden}
              height={140}
              selected={selectedMonth}
              onSelect={(m) => patchParams(monthBounds(m, today))}
              data={months.map((m) => ({ key: m, label: monthName(m).slice(0, 3), value: perMonth.get(m) ?? 0, tip: `${monthName(m)}: ${hidden ? '••••' : brl(perMonth.get(m) ?? 0)}` }))}
            />
          </div>
          <div class="panel split top">
            <Ring size={170} selected={open} onSelect={(k) => setOpen(open === k ? null : k)} segments={data.groups.slice(0, 8).map((g, i) => ({ key: g.name, value: g.amount, color: PALETTE[i % PALETTE.length]!, tip: `${g.name}\n${hidden ? '••••' : brl(g.amount)} · ${percent(g.share)}` }))} />
            <ul class="rows grow big-rows">
              {data.groups.map((g, i) => (
                <li key={g.name} class="expandable">
                  <button class="row-btn" onClick={() => setOpen(open === g.name ? null : g.name)} aria-expanded={open === g.name}>
                    <span class="swatch" style={{ background: PALETTE[i % PALETTE.length] ?? 'var(--muted)' }} />
                    <span class="grow clip">{g.name}</span>
                    <span class="muted">{g.count}x · {percent(g.share)}</span>
                    <strong>{brl(g.amount, hidden)}</strong>
                    <span aria-hidden="true">{open === g.name ? '▾' : '▸'}</span>
                  </button>
                  {open === g.name && <Members name={g.name} by={by} from={from} to={to} hidden={hidden} />}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
