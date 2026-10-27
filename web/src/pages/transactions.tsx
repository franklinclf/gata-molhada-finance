import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { brl, monthName } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { PeriodPicker } from '../period.tsx';
import { patchParams, navigate, type Route } from '../router.ts';
import { Loading, MultiSelect, TxRow } from '../ui.tsx';

const STATES = [
  { value: 'confirmed', label: 'Confirmada pelas duas fontes' },
  { value: 'single_source', label: 'Vista em uma fonte só' },
  { value: 'conflict', label: 'Fontes discordam do status' },
  { value: 'stale_pending', label: 'Pendente há muito tempo' },
];

const SORTS = [
  { value: 'date_desc', label: 'Mais recentes' },
  { value: 'date_asc', label: 'Mais antigas' },
  { value: 'amount_desc', label: 'Maior valor' },
  { value: 'amount_asc', label: 'Menor valor' },
];

const PAGE = 50;

const reais = (cents: string | null) => (cents === null || cents === '' ? '' : String(Number(cents) / 100));
const toCents = (text: string) => (text.trim() === '' ? null : String(Math.round(Number(text.replace(',', '.')) * 100)));

/** Transaction explorer. Every filter lives in the URL, so a link from a widget opens it already scoped. */
export function TransactionsPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const p = route.params;
  const [limit, setLimit] = useState(PAGE);
  const [text, setText] = useState(p.get('q') ?? '');
  const key = [...p.entries()].filter(([k]) => k !== 'tx').map(([k, v]) => `${k}=${v}`).sort().join('&');

  // Changing a filter starts again from the first page.
  useEffect(() => setLimit(PAGE), [key]);
  useEffect(() => setText(p.get('q') ?? ''), [p.get('q')]);
  useEffect(() => {
    if (text === (p.get('q') ?? '')) return;
    const timer = setTimeout(() => patchParams({ q: text || null }), 350);
    return () => clearTimeout(timer);
  }, [text]);

  const query = new URLSearchParams();
  p.forEach((v, k) => k !== 'tx' && query.append(k, v));
  query.set('limit', String(limit));
  const { data, error, loading } = useLoad(() => api.explore(query), [query.toString()]);
  const cards = useLoad(() => api.cards(), []);

  const set = (updates: Record<string, string | string[] | null | undefined>) => patchParams(updates);
  const kind = p.get('kind') ?? 'all';
  const categories = p.getAll('category');
  const institutions = p.getAll('institution');
  const accountIds = p.getAll('accountId');
  const active = [
    ...categories.map((c) => ({ label: c || 'Sem categoria', remove: () => set({ category: categories.filter((x) => x !== c) }) })),
    ...institutions.map((c) => ({ label: c, remove: () => set({ institution: institutions.filter((x) => x !== c) }) })),
    ...accountIds.map((c) => ({ label: data?.facets.accounts.find((a) => a.id === c)?.name ?? 'Conta', remove: () => set({ accountId: accountIds.filter((x) => x !== c) }) })),
    ...(p.get('cycle') ? [{ label: p.get('cycle') === 'open' ? 'Ciclo em aberto' : `Fatura ${monthName(p.get('cycle')!)}`, remove: () => set({ cycle: null }) }] : []),
    ...(p.get('spendingOnly') === 'true' ? [{ label: 'Só gastos reais', remove: () => set({ spendingOnly: null }) }] : []),
  ];

  return (
    <div class="page-body">
      <h1 class="page-title">Transações</h1>
      <PeriodPicker from={p.get('from') ?? undefined} to={p.get('to') ?? undefined} now={now} onChange={(r) => set({ from: r.from ?? null, to: r.to ?? null })} />

      <div class="filters">
        <div class="seg" role="group" aria-label="Tipo">
          {[['all', 'Todas'], ['expense', 'Gastos'], ['income', 'Entradas']].map(([value, label]) => (
            <button key={value} class={kind === value ? 'tab on' : 'tab'} onClick={() => set({ kind: value === 'all' ? null : value })}>
              {label}
            </button>
          ))}
        </div>
        <input class="search" placeholder="Buscar descrição ou categoria" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
        <MultiSelect label="Categorias" options={(data?.facets.categories ?? []).map((f) => ({ value: f.name, label: f.name, count: f.count }))} selected={categories} onChange={(v) => set({ category: v })} />
        <MultiSelect label="Instituições" options={(data?.facets.institutions ?? []).map((f) => ({ value: f.name, label: f.name, count: f.count }))} selected={institutions} onChange={(v) => set({ institution: v })} />
        <MultiSelect label="Contas e cartões" options={(data?.facets.accounts ?? []).map((f) => ({ value: f.id, label: f.name, count: f.count }))} selected={accountIds} onChange={(v) => set({ accountId: v })} />
        <MultiSelect label="Situação" searchable={false} options={STATES} selected={p.getAll('state')} onChange={(v) => set({ state: v })} />
        <select class="select" value={p.get('status') ?? ''} onChange={(e) => set({ status: (e.currentTarget as HTMLSelectElement).value || null })} aria-label="Status">
          <option value="">Pendentes e lançadas</option>
          <option value="posted">Só lançadas</option>
          <option value="pending">Só pendentes</option>
        </select>
        <select class="select" value={p.get('cycle') ?? ''} onChange={(e) => set({ cycle: (e.currentTarget as HTMLSelectElement).value || null })} aria-label="Ciclo da fatura">
          <option value="">Qualquer ciclo</option>
          <option value="open">Ciclo em aberto</option>
          {(cards.data?.cycles ?? []).map((c) => (
            <option key={c} value={c}>
              Fatura com venc. {monthName(c)}
            </option>
          ))}
        </select>
        <label class="amount">
          R$ de
          <input inputMode="decimal" value={reais(p.get('min'))} onChange={(e) => set({ min: toCents((e.currentTarget as HTMLInputElement).value) })} />
          até
          <input inputMode="decimal" value={reais(p.get('max'))} onChange={(e) => set({ max: toCents((e.currentTarget as HTMLInputElement).value) })} />
        </label>
        <select class="select" value={p.get('sort') ?? 'date_desc'} onChange={(e) => set({ sort: (e.currentTarget as HTMLSelectElement).value === 'date_desc' ? null : (e.currentTarget as HTMLSelectElement).value })} aria-label="Ordem">
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <label class="check">
          <input type="checkbox" checked={p.get('spendingOnly') === 'true'} onChange={(e) => set({ spendingOnly: (e.currentTarget as HTMLInputElement).checked ? 'true' : null })} />
          Só gastos reais (sem pagar fatura, transferir entre contas, investir)
        </label>
      </div>

      {active.length > 0 && (
        <div class="active">
          {active.map((a) => (
            <button key={a.label} class="chip on" onClick={a.remove}>
              {a.label} ×
            </button>
          ))}
          <button class="link" onClick={() => navigate('transactions')}>Limpar tudo</button>
        </div>
      )}

      {error || (loading && !data) ? (
        <Loading error={error} />
      ) : data ? (
        <>
          <div class="summary">
            <div>
              <span class="muted">Transações</span>
              <strong>{data.sums.count}</strong>
            </div>
            <div>
              <span class="muted">Entradas</span>
              <strong class="good-text">{brl(data.sums.income, hidden)}</strong>
            </div>
            <div>
              <span class="muted">Saídas</span>
              <strong class="bad-text">{brl(data.sums.expense, hidden)}</strong>
            </div>
            <div>
              <span class="muted">Saldo</span>
              <strong>{brl(data.sums.net, hidden)}</strong>
            </div>
          </div>
          {data.items.length === 0 ? (
            <div class="empty">Nenhuma transação com esses filtros.</div>
          ) : (
            <ul class="rows tall tx-list panel">
              {data.items.map((t) => (
                <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} />
              ))}
            </ul>
          )}
          {data.total > data.items.length && limit < 500 && (
            <button class="icon" onClick={() => setLimit(limit + PAGE)}>
              Mostrar mais ({data.items.length} de {data.total})
            </button>
          )}
          {data.total > 500 && limit >= 500 && <div class="note">Mostrando as primeiras 500. Refine os filtros para ver as demais.</div>}
        </>
      ) : null}
    </div>
  );
}
