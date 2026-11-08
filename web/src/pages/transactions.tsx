import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { brl, monthName, parseBrl } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { ManualForm } from '../ManualForm.tsx';
import { Select } from '../Select.tsx';
import { PeriodPicker } from '../period.tsx';
import { navigate, patchParams, type Route } from '../router.ts';
import { CategorySelect } from '../CategorySelect.tsx';
import { CheckList, Go, Loading, Section, STATE_LABEL, TxRow } from '../ui.tsx';
import { countNote, internalNote } from './page-logic.ts';

const STATES = ['confirmed', 'single_source', 'billed', 'stale_pending', 'ignored'].map((value) => ({ value, label: STATE_LABEL[value] ?? value }));

const SORTS = [
  { value: 'date_desc', label: 'Mais recentes' },
  { value: 'date_asc', label: 'Mais antigas' },
  { value: 'amount_desc', label: 'Maior valor' },
  { value: 'amount_asc', label: 'Menor valor' },
];

const PAGE = 50;

const reais = (cents: string | null) => (cents === null || cents === '' ? '' : String(Number(cents) / 100));
const toCents = (text: string) => {
  const cents = parseBrl(text, { allowZero: true });
  return cents === null ? null : String(cents);
};

/** A bound of the amount filter: applies a moment after typing stops, so there is no need to leave the field. */
function AmountField({ label, value, onCommit }: { label: string; value: string | null; onCommit: (cents: string | null) => void }) {
  const [text, setText] = useState(reais(value));
  // A change from outside (a removed chip, a link) replaces the text; the echo of what was typed does not.
  useEffect(() => {
    if (toCents(text) !== value) setText(reais(value));
  }, [value]);
  useEffect(() => {
    if (toCents(text) === value) return;
    const timer = setTimeout(() => onCommit(toCents(text)), 500);
    return () => clearTimeout(timer);
  }, [text]);
  return <input aria-label={label} inputMode="decimal" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />;
}

/** Transaction explorer. Every filter lives in the URL, so a link from a widget opens it already scoped. */
export function TransactionsPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const p = route.params;
  const [limit, setLimit] = useState(PAGE);
  const [text, setText] = useState(p.get('q') ?? '');
  const [sheet, setSheet] = useState(false);
  const [adding, setAdding] = useState(p.get('new') === '1');
  const [version, setVersion] = useState(0);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [similar, setSimilar] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const key = [...p.entries()].filter(([k]) => k !== 'tx').map(([k, v]) => `${k}=${v}`).sort().join('&');

  // Changing a filter starts again from the first page.
  useEffect(() => setLimit(PAGE), [key]);
  useEffect(() => setPicked([]), [key]);
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
  const exportQuery = new URLSearchParams(query);
  exportQuery.delete('limit');
  exportQuery.delete('offset');
  const { data, error, loading } = useLoad(() => api.explore(query), [query.toString(), version]);
  const cards = useLoad(() => api.cards(), []);
  // Items that left the list (ignored ones, a changed category under a category filter) must not stay selected out of sight.
  useEffect(() => {
    if (!data) return;
    const shown = new Set(data.items.map((t) => t.id));
    setPicked((current) => (current.every((id) => shown.has(id)) ? current : current.filter((id) => shown.has(id))));
  }, [data]);

  const bulk = async (change: Parameters<typeof api.bulkEdit>[1]) => {
    setNote(null);
    try {
      const r = await api.bulkEdit(picked, change, { applyToSimilar: similar && typeof (change as { category?: unknown }).category === 'string' });
      // Like in the drawer, the option is turned off after a save so the next change does not create rules by accident.
      if ('category' in change) setSimilar(false);
      // Moving to a bill only applies to card purchases, so the skipped ones are named by that reason.
      const skipped = 'cycleKey' in change ? `${r.skipped} não ${r.skipped === 1 ? 'é' : 'são'} de cartão` : `${r.skipped} não se aplica${r.skipped === 1 ? '' : 'm'}`;
      const ruled = r.ruled ? ` Regra salva para ${r.ruled} ${r.ruled === 1 ? 'descrição' : 'descrições'}, que vale também para as próximas.` : '';
      setNote(`${r.changed} alterada${r.changed === 1 ? '' : 's'}${r.skipped > 0 ? `, ${skipped}` : ''}.${ruled} A seleção continua, para você poder voltar atrás.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Não foi possível alterar.');
    }
  };
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
    ...(p.get('merchant') ? [{ label: `Estabelecimento: ${p.get('merchant')}`, remove: () => set({ merchant: null }) }] : []),
    ...(p.get('cycle') ? [{ label: p.get('cycle') === 'open' ? 'Fatura em aberto' : `Fatura ${monthName(p.get('cycle')!)}`, remove: () => set({ cycle: null }) }] : []),
    ...(p.get('status') ? [{ label: p.get('status') === 'pending' ? 'Só pendentes' : 'Só lançadas', remove: () => set({ status: null }) }] : []),
    ...(p.get('min') || p.get('max') ? [{ label: `Valor ${p.get('min') ? `de ${brl(Number(p.get('min')))}` : ''} ${p.get('max') ? `até ${brl(Number(p.get('max')))}` : ''}`.trim(), remove: () => set({ min: null, max: null }) }] : []),
    ...(p.get('future') === 'true' ? [{ label: 'Com datas futuras', remove: () => set({ future: null }) }] : []),
    ...(p.get('spendingOnly') === 'true' ? [{ label: 'Só gastos reais', remove: () => set({ spendingOnly: null }) }] : []),
    ...(p.get('recurrence') ? [{ label: p.get('recurrence') === 'subscription' ? 'Só assinaturas' : p.get('recurrence') === 'recurring' ? 'Só outras recorrentes' : 'Assinaturas e recorrentes', remove: () => set({ recurrence: null }) }] : []),
    ...(p.get('netSpending') === 'true' ? [{ label: 'Gastos (compras menos estornos)', remove: () => set({ netSpending: null }) }] : []),
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
        <label class="check">
          <input type="checkbox" checked={p.get('future') === 'true'} onChange={(e) => set({ future: (e.currentTarget as HTMLInputElement).checked ? 'true' : null })} />
          Incluir lançamentos com data futura (parcelas previstas)
        </label>
        <label class="inline-field">
          Recorrência
          <Select
            ariaLabel="Recorrência"
            value={p.get('recurrence') ?? ''}
            emptyLabel="Todas"
            options={[{ value: 'any', label: 'Assinaturas e recorrentes' }, { value: 'subscription', label: 'Só assinaturas' }, { value: 'recurring', label: 'Só outras recorrentes (aluguel, contas)' }]}
            onChange={(value) => set({ recurrence: value || null })}
          />
        </label>
      </Section>
      <Section title="Categorias" active={categories.length} open={window.innerWidth >= 760}>
        <CheckList options={(data?.facets.categories ?? []).map((f) => ({ value: f.name, label: f.name, count: f.count }))} selected={categories} onChange={(v) => set({ category: v })} />
      </Section>
      <Section title="Instituições" active={institutions.length}>
        <CheckList options={(data?.facets.institutions ?? []).map((f) => ({ value: f.name, label: f.name, count: f.count }))} selected={institutions} onChange={(v) => set({ institution: v })} />
      </Section>
      <Section title="Contas e cartões" active={accountIds.length}>
        <CheckList options={(data?.facets.accounts ?? []).map((f) => ({ value: f.id, label: f.name, count: f.count }))} selected={accountIds} onChange={(v) => set({ accountId: v })} />
      </Section>
      <Section title="Fatura do cartão" active={p.get('cycle') ? 1 : 0}>
        <Select ariaLabel="Fatura" value={p.get('cycle') ?? ''} onChange={(value) => set({ cycle: value || null })} options={[{ value: '', label: 'Qualquer ciclo' }, { value: 'open', label: 'Fatura em aberto' }, ...(cards.data?.cycles ?? []).map((c) => ({ value: c, label: `Fatura com venc. ${monthName(c)}` }))]} />
      </Section>
      <Section title="Valor" active={p.get('min') || p.get('max') ? 1 : 0}>
        <label class="amount">
          de R$
          <AmountField label="Valor de" value={p.get('min')} onCommit={(min) => set({ min })} />
          até
          <AmountField label="Valor até" value={p.get('max')} onCommit={(max) => set({ max })} />
        </label>
      </Section>
      <Section title="Status e fontes" active={states.length + (p.get('status') ? 1 : 0)}>
        <Select ariaLabel="Status" value={p.get('status') ?? ''} onChange={(value) => set({ status: value || null })} options={[{ value: '', label: 'Pendentes e lançadas' }, { value: 'posted', label: 'Só lançadas' }, { value: 'pending', label: 'Só pendentes' }]} />
        <CheckList options={STATES} selected={states} onChange={(v) => set({ state: v })} searchable={false} />
        <div class="note">“Fora dos totais” e “ignorada” só aparecem aqui quando você marca a situação.</div>
      </Section>
    </div>
  );

  return (
    <div class="page-body">
      <h1 class="page-title">Transações</h1>
      {adding && (
        <ManualForm
          now={now}
          onCancel={() => {
            setAdding(false);
            patchParams({ new: null });
          }}
          onSaved={(id) => {
            setAdding(false);
            setVersion((n) => n + 1);
            patchParams({ tx: id, new: null });
          }}
        />
      )}
      <PeriodPicker from={p.get('from') ?? undefined} to={p.get('to') ?? undefined} now={now} onChange={(r) => set({ from: r.from ?? null, to: r.to ?? null })} />
      <div class="searchbar">
        <input class="search grow" placeholder="Buscar por descrição ou categoria" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
        <Select ariaLabel="Ordem" value={p.get('sort') ?? 'date_desc'} onChange={(value) => set({ sort: value === 'date_desc' ? null : value })} options={SORTS.map((s) => ({ value: s.value, label: s.label }))} />
        <button class={active.length > 0 ? 'chip on filter-toggle' : 'chip filter-toggle'} onClick={() => setSheet(true)}>
          Filtros{active.length > 0 ? ` (${active.length})` : ''}
        </button>
        <button class={picking ? 'chip on' : 'chip'} onClick={() => { setPicking(!picking); setPicked([]); }} aria-pressed={picking}>
          Selecionar
        </button>
        <button class="chip" onClick={() => setAdding(!adding)}>
          + Nova
        </button>
      </div>

      {picking && (
        <div class="bulk-bar">
          <strong>{picked.length} selecionada{picked.length === 1 ? '' : 's'}</strong>
          <button class="link" onClick={() => setPicked(data?.items.map((t) => t.id) ?? [])}>Selecionar as {data?.items.length ?? 0} exibidas</button>
          {data && data.total > data.items.length && <span class="muted">{data.items.length} de {data.total} no filtro. Use “Mostrar mais” para incluir outras.</span>}
          {picked.length > 0 && <button class="link" onClick={() => setPicked([])}>Limpar</button>}
          <CategorySelect ariaLabel="Categoria das selecionadas" placeholder="Mudar categoria para..." value="" onChange={(category) => category !== '' && picked.length > 0 && void bulk({ category })} />
          <label class="switch">
            <input type="checkbox" checked={similar} onChange={(e) => setSimilar((e.currentTarget as HTMLInputElement).checked)} />
            <span>Valer também para as de mesma descrição</span>
          </label>
          <button class="chip" disabled={picked.length === 0} onClick={() => void bulk({ category: null })}>Voltar à categoria da fonte</button>
          <Select
            ariaLabel="Status das selecionadas"
            placeholder="Mudar status..."
            value=""
            disabled={picked.length === 0}
            options={[{ value: 'posted', label: 'Marcar lançadas' }, { value: 'pending', label: 'Marcar pendentes' }, { value: 'source', label: 'Status como a fonte diz' }]}
            onChange={(value) => value !== '' && void bulk({ status: value === 'source' ? null : (value as 'posted' | 'pending') })}
          />
          <Select
            ariaLabel="Mover as selecionadas para a fatura"
            placeholder="Mover para a fatura..."
            value=""
            disabled={picked.length === 0}
            options={[{ value: 'auto', label: 'Voltar ao automático' }, ...(cards.data?.cycles ?? []).map((c) => ({ value: c, label: `Fatura com venc. ${monthName(c)}` }))]}
            onChange={(value) => value !== '' && void bulk({ cycleKey: value === 'auto' ? null : value })}
          />
          <button class="chip" disabled={picked.length === 0} onClick={() => (picked.length <= 20 || window.confirm(`Ignorar ${picked.length} transações? Elas saem dos totais até você restaurar.`)) && void bulk({ ignored: true })}>Ignorar</button>
          <button class="chip" disabled={picked.length === 0} onClick={() => void bulk({ ignored: false })}>Restaurar</button>
          {note && <span class="muted">{note}</span>}
        </div>
      )}

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
              {data.total === 0 && key === '' ? (
                <div class="empty">
                  Nenhuma transação ainda. Conecte o Meu Pluggy em <Go page="settings" params={{ tab: 'data' }}>Ajustes, aba Dados</Go>.
                </div>
              ) : (
              <>
              <div class="summary">
                <div>
                  <span class="muted">Transações</span>
                  <strong>{data.total}</strong>
                  {countNote(data.total, data.sums.count) && <span class="muted tile-note">{countNote(data.total, data.sums.count)}</span>}
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
                  <span class="muted">Resultado do filtro</span>
                  <strong>{brl(data.sums.net, hidden)}</strong>
                </div>
              </div>
              {internalNote(data.internal, hidden) && (
                <div class="note">
                  {internalNote(data.internal, hidden)} <button class="link" onClick={() => set({ spendingOnly: 'true' })}>Ver só gastos reais</button>
                </div>
              )}
              {data.items.length === 0 ? (
                <div class="empty">
                  Nenhuma transação com esses filtros. <button class="link" onClick={() => navigate('transactions')}>Limpar filtros</button>
                </div>
              ) : (
                <ul class="rows tall tx-list panel">
                  {data.items.map((t) => (
                    <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} pick={picking ? { on: picked.includes(t.id), toggle: () => setPicked(picked.includes(t.id) ? picked.filter((x) => x !== t.id) : [...picked, t.id]) } : undefined} />
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
              )}
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
