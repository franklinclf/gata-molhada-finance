import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { brl, monthName } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { PeriodPicker } from '../period.tsx';
import { navigate, patchParams, type Route } from '../router.ts';
import { CheckList, Loading, Section, STATE_LABEL, TxRow } from '../ui.tsx';

const STATES = ['confirmed', 'single_source', 'stale_pending', 'ignored'].map((value) => ({ value, label: STATE_LABEL[value] ?? value }));

const SORTS = [
  { value: 'date_desc', label: 'Mais recentes' },
  { value: 'date_asc', label: 'Mais antigas' },
  { value: 'amount_desc', label: 'Maior valor' },
  { value: 'amount_asc', label: 'Menor valor' },
];

const PAGE = 50;

const reais = (cents: string | null) => (cents === null || cents === '' ? '' : String(Number(cents) / 100));
const toCents = (text: string) => {
  const n = Number(text.replace(/\./g, '').replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(n) || n < 0 ? null : String(Math.round(n * 100));
};

/** Transaction explorer. Every filter lives in the URL, so a link from a widget opens it already scoped. */
export function TransactionsPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const p = route.params;
  const [limit, setLimit] = useState(PAGE);
  const [text, setText] = useState(p.get('q') ?? '');
  const [sheet, setSheet] = useState(false);
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
  if (p.getAll('state').some((s) => s === 'stale_pending' || s === 'ignored')) query.set('includeExcluded', 'true');
  const { data, error, loading } = useLoad(() => api.explore(query), [query.toString()]);
  const cards = useLoad(() => api.cards(), []);

  const set = (updates: Record<string, string | string[] | null | undefined>) => patchParams(updates);
  const kind = p.get('kind') ?? 'all';
  const categories = p.getAll('category');
  const institutions = p.getAll('institution');
  const accountIds = p.getAll('accountId');
  const states = p.getAll('state');
  const active = [
    ...categories.map((c) => ({ label: c || 'Sem categoria', remove: () => set({ category: categories.filter((x) => x !== c) }) })),
    ...institutions.map((c) => ({ label: c, remove: () => set({ institution: institutions.filter((x) => x !== c) }) })),
    ...accountIds.map((c) => ({ label: data?.facets.accounts.find((a) => a.id === c)?.name ?? 'Conta', remove: () => set({ accountId: accountIds.filter((x) => x !== c) }) })),
    ...states.map((c) => ({ label: STATE_LABEL[c] ?? c, remove: () => set({ state: states.filter((x) => x !== c) }) })),
    ...(p.get('cycle') ? [{ label: p.get('cycle') === 'open' ? 'Ciclo em aberto' : `Fatura ${monthName(p.get('cycle')!)}`, remove: () => set({ cycle: null }) }] : []),
    ...(p.get('status') ? [{ label: p.get('status') === 'pending' ? 'Só pendentes' : 'Só lançadas', remove: () => set({ status: null }) }] : []),
    ...(p.get('min') || p.get('max') ? [{ label: `Valor ${p.get('min') ? `de ${brl(Number(p.get('min')))}` : ''} ${p.get('max') ? `até ${brl(Number(p.get('max')))}` : ''}`.trim(), remove: () => set({ min: null, max: null }) }] : []),
    ...(p.get('spendingOnly') === 'true' ? [{ label: 'Só gastos reais', remove: () => set({ spendingOnly: null }) }] : []),
    ...(p.get('hideOwnTransfers') === 'true' ? [{ label: 'Sem transferências entre suas contas', remove: () => set({ hideOwnTransfers: null }) }] : []),
  ];

  const panel = (
    <div class="filter-panel">
      <Section title="Tipo" open>
        <div class="seg" role="group" aria-label="Tipo">
          {[['all', 'Todas'], ['expense', 'Gastos'], ['income', 'Entradas']].map(([value, label]) => (
            <button key={value} class={kind === value ? 'tab on' : 'tab'} onClick={() => set({ kind: value === 'all' ? null : value })}>
              {label}
            </button>
          ))}
        </div>
        <label class="check">
          <input type="checkbox" checked={p.get('spendingOnly') === 'true'} onChange={(e) => set({ spendingOnly: (e.currentTarget as HTMLInputElement).checked ? 'true' : null })} />
          Só gastos reais (sem pagar fatura, transferir entre contas ou investir)
        </label>
      </Section>
      <Section title="Categorias" active={categories.length} open>
        <CheckList options={(data?.facets.categories ?? []).map((f) => ({ value: f.name, label: f.name, count: f.count }))} selected={categories} onChange={(v) => set({ category: v })} />
      </Section>
      <Section title="Instituições" active={institutions.length}>
        <CheckList options={(data?.facets.institutions ?? []).map((f) => ({ value: f.name, label: f.name, count: f.count }))} selected={institutions} onChange={(v) => set({ institution: v })} />
      </Section>
      <Section title="Contas e cartões" active={accountIds.length}>
        <CheckList options={(data?.facets.accounts ?? []).map((f) => ({ value: f.id, label: f.name, count: f.count }))} selected={accountIds} onChange={(v) => set({ accountId: v })} />
      </Section>
      <Section title="Fatura do cartão" active={p.get('cycle') ? 1 : 0}>
        <select class="select" value={p.get('cycle') ?? ''} onChange={(e) => set({ cycle: (e.currentTarget as HTMLSelectElement).value || null })} aria-label="Ciclo da fatura">
          <option value="">Qualquer ciclo</option>
          <option value="open">Ciclo em aberto</option>
          {(cards.data?.cycles ?? []).map((c) => (
            <option key={c} value={c}>
              Fatura com venc. {monthName(c)}
            </option>
          ))}
        </select>
      </Section>
      <Section title="Valor" active={p.get('min') || p.get('max') ? 1 : 0}>
        <label class="amount">
          de R$
          <input key={`min${p.get('min')}`} inputMode="decimal" defaultValue={reais(p.get('min'))} onChange={(e) => set({ min: toCents((e.currentTarget as HTMLInputElement).value) })} />
          até
          <input key={`max${p.get('max')}`} inputMode="decimal" defaultValue={reais(p.get('max'))} onChange={(e) => set({ max: toCents((e.currentTarget as HTMLInputElement).value) })} />
        </label>
      </Section>
      <Section title="Status e fontes" active={states.length + (p.get('status') ? 1 : 0)}>
        <select class="select" value={p.get('status') ?? ''} onChange={(e) => set({ status: (e.currentTarget as HTMLSelectElement).value || null })} aria-label="Status">
          <option value="">Pendentes e lançadas</option>
          <option value="posted">Só lançadas</option>
          <option value="pending">Só pendentes</option>
        </select>
        <CheckList options={STATES} selected={states} onChange={(v) => set({ state: v })} searchable={false} />
        <div class="note">“Fora dos totais” e “ignorada” só aparecem aqui quando você marca a situação.</div>
      </Section>
    </div>
  );

  return (
    <div class="page-body">
      <h1 class="page-title">Transações</h1>
      <PeriodPicker from={p.get('from') ?? undefined} to={p.get('to') ?? undefined} now={now} onChange={(r) => set({ from: r.from ?? null, to: r.to ?? null })} />
      <div class="searchbar">
        <input class="search grow" placeholder="Buscar por descrição ou categoria" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
        <select class="select" value={p.get('sort') ?? 'date_desc'} onChange={(e) => set({ sort: (e.currentTarget as HTMLSelectElement).value === 'date_desc' ? null : (e.currentTarget as HTMLSelectElement).value })} aria-label="Ordem">
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button class={active.length > 0 ? 'chip on filter-toggle' : 'chip filter-toggle'} onClick={() => setSheet(true)}>
          Filtros{active.length > 0 ? ` (${active.length})` : ''}
        </button>
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

      <div class="tx-layout">
        <aside class="filter-side">{panel}</aside>
        <div class="tx-main">
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
      </div>

      {sheet && (
        <div class="overlay sheet-overlay" onClick={() => setSheet(false)}>
          <div class="drawer sheet filter-sheet" role="dialog" aria-label="Filtros" onClick={(e) => e.stopPropagation()}>
            <div class="sheet-handle" aria-hidden="true" />
            <div class="row-head">
              <h2>Filtros</h2>
              <button class="primary" onClick={() => setSheet(false)}>
                Ver {data?.total ?? ''} resultados
              </button>
            </div>
            {panel}
          </div>
        </div>
      )}
    </div>
  );
}
