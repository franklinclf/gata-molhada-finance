import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { SpendingView } from '../api.ts';
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

interface Row {
  name: string;
  amount: number;
  count: number;
  share: number;
  /** The categories inside a group, when the row is a group of two or more. */
  children: Row[];
}

/** Puts the categories of one group together. A category with no group stands alone. */
function groupRows(groups: SpendingView['groups']): Row[] {
  const byName = new Map<string, Row>();
  for (const g of groups) {
    const key = g.parent ?? g.name;
    const row = byName.get(key) ?? { name: key, amount: 0, count: 0, share: 0, children: [] };
    row.amount += g.amount;
    row.count += g.count;
    row.share += g.share;
    if (g.parent !== null) row.children.push({ name: g.name, amount: g.amount, count: g.count, share: g.share, children: [] });
    byName.set(key, row);
  }
  return [...byName.values()].sort((a, b) => b.amount - a.amount);
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
  const view = route.params.get('by') === 'merchant' ? 'merchant' : route.params.get('by') === 'category' ? 'category' : 'group';
  const by = view === 'merchant' ? 'merchant' : 'category';
  const [open, setOpen] = useState<string | null>(null);
  const [openChild, setOpenChild] = useState<string | null>(null);
  const { data, error, loading } = useLoad(() => api.spending(from, to, by), [from, to, by]);
  const months = lastMonths(today, 12);
  const year = useLoad(() => api.spending(`${months[0]}-01`, today, 'category'), [today]);
  const perMonth = new Map(months.map((m) => [m, 0]));
  for (const row of sumByMonth(year.data?.daily ?? [])) perMonth.set(row.month, row.amount);
  const selectedMonth = from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === monthBounds(from.slice(0, 7), today).to ? from.slice(0, 7) : null;

  const rows: Row[] = data ? (view === 'group' ? groupRows(data.groups) : data.groups.map((g) => ({ ...g, children: [] }))) : [];
  return (
    <div class="page-body">
      <h1 class="page-title">Gastos</h1>
      <PeriodPicker from={from} to={to} now={now} onChange={(r) => patchParams({ from: r.from ?? month.from, to: r.to ?? month.to })} />
      <div class="tabs">
        <button class={view === 'group' ? 'tab on' : 'tab'} onClick={() => patchParams({ by: null })}>Grupos</button>
        <button class={view === 'category' ? 'tab on' : 'tab'} onClick={() => patchParams({ by: 'category' })}>Categorias</button>
        <button class={view === 'merchant' ? 'tab on' : 'tab'} onClick={() => patchParams({ by: 'merchant' })}>Estabelecimentos</button>
      </div>
      {error || (loading && !data) ? (
        <Loading error={error} />
      ) : data ? (
        <>
          <div class="panel">
            <div class="big">{brl(data.total, hidden)}</div>
            <div class="muted">
              {rows.length} {view === 'group' ? 'grupos' : view === 'category' ? 'categorias' : 'estabelecimentos'} · compras no cartão entram na data da compra
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
            <Ring size={170} selected={open} onSelect={(k) => setOpen(open === k ? null : k)} segments={rows.slice(0, 8).map((g, i) => ({ key: g.name, value: g.amount, color: PALETTE[i % PALETTE.length]!, tip: `${g.name}\n${hidden ? '••••' : brl(g.amount)} · ${percent(g.share)}` }))} />
            <ul class="rows grow big-rows">
              {rows.map((g, i) => (
                <li key={g.name} class="expandable">
                  <button class="row-btn" onClick={() => setOpen(open === g.name ? null : g.name)} aria-expanded={open === g.name}>
                    <span class="swatch" style={{ background: PALETTE[i % PALETTE.length] ?? 'var(--muted)' }} />
                    <span class="grow clip">{g.name}</span>
                    <span class="muted">{g.count}x · {percent(g.share)}</span>
                    <strong>{brl(g.amount, hidden)}</strong>
                    <span aria-hidden="true">{open === g.name ? '▾' : '▸'}</span>
                  </button>
                  {open === g.name && g.children.length === 0 && <Members name={g.name} by={by} from={from} to={to} hidden={hidden} />}
                  {open === g.name && g.children.length > 0 && (
                    <ul class="rows sub-rows">
                      {g.children.map((c) => (
                        <li key={c.name} class="expandable">
                          <button class="row-btn" onClick={() => setOpenChild(openChild === c.name ? null : c.name)} aria-expanded={openChild === c.name}>
                            <span class="grow clip">{c.name}</span>
                            <span class="muted">{c.count}x · {percent(c.amount / g.amount)}</span>
                            <strong>{brl(c.amount, hidden)}</strong>
                            <span aria-hidden="true">{openChild === c.name ? '▾' : '▸'}</span>
                          </button>
                          {openChild === c.name && <Members name={c.name} by="category" from={from} to={to} hidden={hidden} />}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
