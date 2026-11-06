import { useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { CompareView, SpendingView } from '../api.ts';
import { Bars, LineChart, PALETTE, Ring, Sparkline } from '../charts.tsx';
import { brl, cumulative, dayMonth, lastMonths, monthBounds, monthName, percent, sumByMonth } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { PeriodPicker, PRESETS } from '../period.tsx';
import { patchParams, type Route } from '../router.ts';
import { localDay } from '../format.ts';
import { Go, Loading, TxRow } from '../ui.tsx';

/** What a category (or merchant) is made of: the individual transactions, loaded when the row is opened. */
function Members({ name, by, from, to, hidden }: { name: string; by: 'category' | 'merchant'; from: string; to: string; hidden: boolean }) {
  const query = new URLSearchParams({ from, to, netSpending: 'true', sort: 'amount_desc', limit: '15' });
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

/** "1 compra", "2 compras". */
const purchases = (n: number): string => `${n} ${n === 1 ? 'compra' : 'compras'}`;

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** "R$ 1,20 a mais" / "R$ 1,20 a menos". */
const moreOrLess = (delta: number, hidden: boolean): string => `${brl(Math.abs(delta), hidden)} ${delta >= 0 ? 'a mais' : 'a menos'}`;

/** The month so far against the same days of the month before and against the closed months, in short sentences with links to the purchases. */
function Changes({ month, today, hidden }: { month: string; today: string; hidden: boolean }) {
  const { data, error } = useLoad(() => api.spendingCompare(month), [month], 300_000);
  if (!data) return <Loading error={error} />;
  const c: CompareView = data;
  const prevName = monthName(c.previous.from.slice(0, 7));
  const thisMonth = c.month === today.slice(0, 7);
  const days = thisMonth ? `Até o dia ${Number(c.to.slice(8, 10))}` : `Em ${monthName(c.month)}`;
  const link = (extra: Record<string, string>) => ({ from: c.from, to: c.to, netSpending: 'true', ...extra });
  const nothing = c.total.current === 0 && c.total.previous === 0;
  return (
    <section class="panel changes">
      <h2>{thisMonth ? 'O que mudou neste mês' : `O que mudou em ${monthName(c.month)}`}</h2>
      <div class="muted">Compara os mesmos dias de cada mês, pela data da compra.</div>
      {nothing ? (
        <p>Ainda não há gastos para comparar neste trecho.</p>
      ) : (
        <ul class="rows tall changes-list">
          <li>
            <span>
              {days} você gastou <strong>{brl(c.total.current, hidden)}</strong>.{' '}
              {c.total.previous > 0 ? (
                <>
                  É {moreOrLess(c.total.delta, hidden)} ({percent(Math.abs(c.total.delta) / c.total.previous)}) que no mesmo trecho de {prevName} ({brl(c.total.previous, hidden)}).
                </>
              ) : (
                <>Em {prevName} não houve gastos nesse trecho.</>
              )}
            </span>
          </li>
          {c.total.average !== null && c.total.deltaAverage !== null && (
            <li>
              <span>
                A média dos {c.baselineMonths.length === 1 ? 'último mês fechado' : `últimos ${c.baselineMonths.length} meses fechados`} nesse trecho é {brl(c.total.average, hidden)}, então {thisMonth ? 'este mês está' : 'o mês ficou'} {moreOrLess(c.total.deltaAverage, hidden)}.
              </span>
            </li>
          )}
          {c.drivers.slice(0, 3).map((d) => (
            <li key={d.category}>
              <span>
                <Go page="transactions" params={link({ category: d.category })}>
                  {d.category}
                </Go>{' '}
                subiu {brl(d.delta, hidden)}
                {d.merchants.length > 0 && (
                  <>
                    , principalmente por{' '}
                    {d.merchants.map((m, i) => (
                      <span key={m.name}>
                        {i > 0 && ' e '}
                        <Go page="transactions" params={link({ merchant: m.name })}>
                          {m.name}
                        </Go>{' '}
                        (+{brl(m.delta, hidden)})
                      </span>
                    ))}
                  </>
                )}
                .
              </span>
            </li>
          ))}
          {c.drivers.length === 0 && (
            <li>
              <span>Nenhuma categoria gastou mais que no mesmo trecho de {prevName}.</span>
            </li>
          )}
          {c.newMerchants.length > 0 && (
            <li>
              <span>
                Estabelecimentos novos:{' '}
                {c.newMerchants.map((m, i) => (
                  <span key={m.name}>
                    {i > 0 && ', '}
                    <Go page="transactions" params={link({ merchant: m.name })}>
                      {m.name}
                    </Go>{' '}
                    ({brl(m.amount, hidden)})
                  </span>
                ))}
                .
              </span>
            </li>
          )}
          {c.bigPurchases.map((b) => (
            <li key={b.id}>
              <span>
                Compra grande:{' '}
                <Go page="transactions" params={link({ merchant: b.merchant })}>
                  {b.merchant}
                </Go>
                , {brl(b.amount, hidden)} em {dayMonth(b.day)}, {String(b.times).replace('.', ',')} vezes o valor usual de {brl(b.usual, hidden)}.
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SpendingPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const today = localDay(now.toISOString());
  const month = PRESETS.find((p) => p.id === 'month')!.range(today);
  const from = route.params.get('from') ?? month.from;
  const to = route.params.get('to') ?? month.to;
  const view = route.params.get('by') === 'merchant' ? 'merchant' : route.params.get('by') === 'category' ? 'category' : route.params.get('by') === 'trend' ? 'trend' : 'group';
  const by = view === 'merchant' ? 'merchant' : 'category';
  const trend = useLoad(() => (view === 'trend' ? api.spendingTrend(6) : Promise.resolve(null)), [view]);
  const [open, setOpen] = useState<string | null>(null);
  const [openChild, setOpenChild] = useState<string | null>(null);
  const { data, error, loading } = useLoad(() => api.spending(from, to, by), [from, to, by]);
  const months = lastMonths(today, 12);
  const year = useLoad(() => api.spending(`${months[0]}-01`, today, 'category'), [today]);
  const perMonth = new Map(months.map((m) => [m, 0]));
  for (const row of sumByMonth(year.data?.daily ?? [])) perMonth.set(row.month, row.amount);
  const selectedMonth = from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === monthBounds(from.slice(0, 7), today).to ? from.slice(0, 7) : null;

  const rows: Row[] = data ? (view === 'group' ? groupRows(data.groups) : data.groups.map((g) => ({ ...g, children: [] }))) : [];
  const picked = rows.find((r) => r.name === open) ?? null;
  return (
    <div class="page-body">
      <h1 class="page-title">Gastos</h1>
      {view !== 'trend' && <PeriodPicker from={from} to={to} now={now} onChange={(r) => patchParams({ from: r.from ?? month.from, to: r.to ?? month.to })} />}
      <div class="tabs">
        <button class={view === 'group' ? 'tab on' : 'tab'} onClick={() => patchParams({ by: null })}>Grupos</button>
        <button class={view === 'category' ? 'tab on' : 'tab'} onClick={() => patchParams({ by: 'category' })}>Categorias</button>
        <button class={view === 'merchant' ? 'tab on' : 'tab'} onClick={() => patchParams({ by: 'merchant' })}>Estabelecimentos</button>
        <button class={view === 'trend' ? 'tab on' : 'tab'} onClick={() => patchParams({ by: 'trend' })}>Tendência</button>
      </div>
      {view === 'trend' ? (
        !trend.data ? (
          <Loading error={trend.error} />
        ) : (
          <section class="panel">
            <h2>Gasto por categoria nos últimos {trend.data.months.length} meses</h2>
            <div class="muted">A linha vai de {monthName(trend.data.months[0]!)} a {monthName(trend.data.months.at(-1)!)}; o último ponto é o mês em andamento. A seta só aparece quando o mês em andamento já passou da média dos meses fechados, e novo é uma categoria sem gasto nos meses fechados. Clique no nome para ver as compras do mês.</div>
            <ul class="rows tall">
              {trend.data.rows.map((r) => {
                // The current month is partial, so being under the average of whole months says nothing yet; only a rise is a signal.
                const diff = r.average > 0 ? r.current / r.average - 1 : null;
                const note = diff === null ? (r.current > 0 ? 'novo' : '') : diff > 0 ? `▲ ${percent(diff)}` : 'mês em andamento';
                return (
                  <li key={r.name} class="trend-row">
                    <Go class="clip" page="transactions" params={{ category: r.name, from: `${today.slice(0, 7)}-01`, to: today, netSpending: 'true' }}>
                      {r.name}
                      {r.parent && <span class="muted"> · {r.parent}</span>}
                    </Go>
                    <Sparkline points={r.points} tip={r.points.map((p, i) => `${monthName(trend.data!.months[i]!)}: ${hidden ? '••••' : brl(p)}`).join('\n')} />
                    <span class="muted">média {brl(r.average, hidden)}</span>
                    <strong>{brl(r.current, hidden)}</strong>
                    <span class={diff !== null && diff > 0.25 ? 'bad-text trend-note' : 'muted trend-note'}>{note}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )
      ) : error || (loading && !data) ? (
        <Loading error={error} />
      ) : data ? (
        <>
          <Changes month={selectedMonth ?? today.slice(0, 7)} today={today} hidden={hidden} />
          <div class="panel">
            <div class="big">{brl(data.total, hidden)}</div>
            <div class="muted">
              {rows.length} {view === 'group' ? 'grupos' : view === 'category' ? 'categorias' : 'estabelecimentos'} · compras no cartão entram na data da compra
              {data.creditsNotListed > 0 && ` · já descontados ${brl(data.creditsNotListed, hidden)} em estornos`}
            </div>
            <LineChart points={cumulative(data.daily, data.from, data.to)} hidden={hidden} days={daysBetween(data.from, data.to)} />
            <div class="muted chart-caption">Gasto acumulado de {dayMonth(data.from)} a {dayMonth(data.to)}: de {brl(0, hidden)} até {brl(data.total, hidden)}.</div>
            <h3>Últimos 12 meses (clique em um mês)</h3>
            <Bars
              hidden={hidden}
              height={140}
              valueOnSelected
              selected={selectedMonth}
              onSelect={(m) => patchParams(monthBounds(m, today))}
              data={months.map((m) => ({ key: m, label: monthName(m).slice(0, 3), value: perMonth.get(m) ?? 0, tip: `${monthName(m)}: ${hidden ? '••••' : brl(perMonth.get(m) ?? 0)}` }))}
            />
          </div>
          <div class="panel split top">
            <Ring size={170} selected={open} onSelect={(k) => setOpen(open === k ? null : k)} segments={rows.slice(0, 8).map((g, i) => ({ key: g.name, value: g.amount, color: PALETTE[i % PALETTE.length]!, tip: `${g.name}\n${hidden ? '••••' : brl(g.amount)} · ${percent(g.share)}` }))}>
              <span class="ring-label">{picked ? picked.name : 'Total'}</span>
              <strong class="ring-total">{brl(picked ? picked.amount : data.total, hidden)}</strong>
            </Ring>
            <ul class="rows grow big-rows">
              {rows.map((g, i) => (
                <li key={g.name} class="expandable">
                  <button class="row-btn" onClick={() => setOpen(open === g.name ? null : g.name)} aria-expanded={open === g.name}>
                    <span class="swatch" style={{ background: PALETTE[i % PALETTE.length] ?? 'var(--muted)' }} />
                    <span class="grow clip">{g.name}</span>
                    <span class="muted">{purchases(g.count)} · {percent(g.share)}</span>
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
                            <span class="muted">{purchases(c.count)} · {percent(c.amount / g.amount)}</span>
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
