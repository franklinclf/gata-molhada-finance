import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type ExplorerResult } from '../api.ts';
import { brl, monthName } from '../format.ts';
import { accountLabel } from '../names.ts';
import { useLoad } from '../hooks.ts';
import { ManualForm } from '../ManualForm.tsx';
import { Select } from '../Select.tsx';
import { DateRangePicker } from '../DateRangePicker.tsx';
import { CycleSelect } from '../CycleSelect.tsx';
import { AmountSlider } from '../AmountSlider.tsx';
import { InstitutionTree } from '../InstitutionTree.tsx';
import { Info } from '../Info.tsx';
import { Popover } from '../Popover.tsx';
import { newRows, toggleId, withRange } from '../row-selection.ts';
import { navigate, patchParams, type Route } from '../router.ts';
import { CategorySelect } from '../CategorySelect.tsx';
import { CheckList, Go, Loading, Section, STATE_LABEL, Switch, TxRow } from '../ui.tsx';
import { BILL_TIP, billPaymentNote, countNote, ESTIMATED_TIP, estimatedNote, INTERNAL_TIP, internalNote, tileSums } from './page-logic.ts';

type Row = ExplorerResult['items'][number];

const SORTS = [
  { value: 'date_desc', label: 'Mais recentes' },
  { value: 'date_asc', label: 'Mais antigas' },
  { value: 'amount_desc', label: 'Maior valor' },
  { value: 'amount_asc', label: 'Menor valor' },
];

const SOURCE_LABEL: Record<string, string> = { pluggy: 'Meu Pluggy', pdf: 'Fatura em PDF', manual: 'Lançamento manual' };
/** The states the "ignoradas" switch stands for; the other states stay in the URL (old links, chips) but have no control. */
const HIDDEN_STATES = ['ignored', 'stale_pending'];

const PAGE = 50;
/** The server answers up to 500 rows per request. */
const MAX_REQUEST = 500;

const SHORTCUTS = 'Segure uma linha para selecionar\nX ou Espaço: marca a linha\nShift + clique ou seta: intervalo\nCtrl/Cmd + A: todas as carregadas\nEsc: sair da seleção';

const Icon = ({ children }: { children: preact.ComponentChildren }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** Transaction explorer. Every filter lives in the URL, so a link from a widget opens it already scoped. */
export function TransactionsPage({ route, now, hidden }: { route: Route; now: Date; hidden: boolean }) {
  const p = route.params;
  const [text, setText] = useState(p.get('q') ?? '');
  const [sheet, setSheet] = useState(false);
  const [adding, setAdding] = useState(p.get('new') === '1');
  const [version, setVersion] = useState(0);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [similar, setSimilar] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const key = [...p.entries()].filter(([k]) => k !== 'tx').map(([k, v]) => `${k}=${v}`).sort().join('&');

  useEffect(() => setPicked([]), [key]);
  useEffect(() => setText(p.get('q') ?? ''), [p.get('q')]);
  useEffect(() => {
    if (text === (p.get('q') ?? '')) return;
    const timer = setTimeout(() => patchParams({ q: text || null }), 350);
    return () => clearTimeout(timer);
  }, [text]);

  const query = new URLSearchParams();
  p.forEach((v, k) => k !== 'tx' && k !== 'offset' && query.append(k, v));
  query.set('limit', String(PAGE));
  if (p.getAll('state').some((s) => HIDDEN_STATES.includes(s))) query.set('includeExcluded', 'true');
  const { data, error, loading } = useLoad(() => api.explore(query), [query.toString(), version]);
  const cards = useLoad(() => api.cards(), []);

  // ---------- infinite scroll ----------
  // `data` is the first page and feeds the tiles, so they stay put while later pages load. `extra` holds the pages after it.
  const [extra, setExtra] = useState<{ key: string; rows: Row[]; done: boolean; after: ExplorerResult | null }>({ key: '', rows: [], done: false, after: null });
  const [busy, setBusy] = useState(false);
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  const generation = useRef(0);
  const more = extra.key === key ? extra.rows : [];
  const rows: Row[] = data ? [...data.items, ...more] : [];
  const done = extra.key === key && extra.done;

  // A new first page (other filters, or a change made elsewhere) cancels what was still on its way.
  useEffect(() => {
    generation.current++;
    setBusy(false);
  }, [key, data]);

  useEffect(() => {
    if (!sentinel) return;
    const watcher = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting ?? false), { rootMargin: '600px' });
    watcher.observe(sentinel);
    return () => watcher.disconnect();
  }, [sentinel]);

  const fetchRows = (offset: number, limit: number) => {
    const q = new URLSearchParams(query);
    q.set('offset', String(offset));
    q.set('limit', String(limit));
    return api.explore(q);
  };

  useEffect(() => {
    if (!near || busy || loading || !data || done || rows.length >= data.total) return;
    const mine = generation.current;
    setBusy(true);
    fetchRows(rows.length, PAGE)
      .then((r) => {
        if (generation.current !== mine) return;
        const fresh = newRows(rows, r.items);
        setExtra({ key, rows: [...more, ...fresh], done: fresh.length === 0 || r.items.length < PAGE, after: data });
        setBusy(false);
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        setNote(e instanceof Error ? e.message : 'Não foi possível carregar mais.');
        setExtra({ key, rows: more, done: true, after: data });
        setBusy(false);
      });
  }, [near, busy, loading, data, rows.length, done]);

  // After a change elsewhere (a bulk edit, the drawer) the first page is fresh. The pages loaded after it are reloaded in one request so the
  // list keeps its length and the scroll stays; what left the list (ignored, another category under a filter) is dropped from the selection.
  useEffect(() => {
    if (!data) return;
    const mine = generation.current;
    const settle = (shown: Row[]) => {
      const ids = new Set(shown.map((t) => t.id));
      setPicked((current) => (current.every((id) => ids.has(id)) ? current : current.filter((id) => ids.has(id))));
    };
    if (extra.key !== key || extra.rows.length === 0 || extra.after === data) {
      if (extra.key !== key || extra.rows.length === 0) settle(data.items);
      return;
    }
    fetchRows(PAGE, Math.min(MAX_REQUEST, extra.rows.length))
      .then((r) => {
        if (generation.current !== mine) return;
        setExtra({ key, rows: r.items, done: r.items.length < extra.rows.length, after: data });
        settle([...data.items, ...r.items]);
      })
      .catch(() => generation.current === mine && setExtra({ key, rows: [], done: false, after: data }));
  }, [data]);

  // ---------- selection ----------
  // Estimated installments are not real records: they have no category, status or bill of their own to change.
  const pickable = rows.filter((t) => !t.estimated);
  const order = pickable.map((t) => t.id);
  const anchor = useRef<{ id: string; base: string[] } | null>(null);
  const hovered = useRef<string | null>(null);
  const toggleRow = (id: string, shift: boolean) => {
    if (shift && anchor.current) {
      setPicked(withRange(anchor.current.base, order, anchor.current.id, id));
      return;
    }
    const next = toggleId(picked, id);
    anchor.current = { id, base: next };
    setPicked(next);
  };
  const enter = (id: string) => {
    setPicking(true);
    const next = picked.includes(id) ? picked : [...picked, id];
    anchor.current = { id, base: next };
    setPicked(next);
  };
  const leave = () => {
    setPicking(false);
    setPicked([]);
    anchor.current = null;
  };

  const onListKey = (e: KeyboardEvent) => {
    const li = e.target instanceof HTMLElement && e.target.matches('li.tx') ? e.target : null;
    if (!li?.dataset.id) return;
    const id = li.dataset.id;
    if (e.key === 'x' || e.key === ' ') {
      e.preventDefault();
      if (!picking) setPicking(true);
      if (order.includes(id)) toggleRow(id, e.shiftKey);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = (e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling) as HTMLElement | null;
      if (!next) return;
      e.preventDefault();
      next.focus();
      if (e.shiftKey && next.dataset.id && order.includes(next.dataset.id)) {
        if (!picking) setPicking(true);
        if (!anchor.current) anchor.current = { id, base: picked };
        setPicked(withRange(anchor.current.base, order, anchor.current.id, next.dataset.id));
      }
    }
  };

  const drawerOpen = p.get('tx') !== null;
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // Only with nothing else in use: not while typing, in a menu or beside the drawer.
      const free = target === document.body || target.closest('.tx-list') !== null;
      if (e.defaultPrevented || drawerOpen || !free) return;
      if (e.key === 'Escape') leave();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setPicked(order);
      } else if ((e.key === 'x' || e.key === ' ') && hovered.current && order.includes(hovered.current)) {
        e.preventDefault();
        toggleRow(hovered.current, e.shiftKey);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

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

  // ---------- filters ----------
  const set = (updates: Record<string, string | string[] | null | undefined>) => patchParams(updates);
  const kind = p.get('kind') ?? 'all';
  const categories = p.getAll('category');
  const institutions = p.getAll('institution');
  const accountIds = p.getAll('accountId');
  const states = p.getAll('state');
  const sources = p.getAll('source');
  const origins = p.getAll('origin');
  const showHidden = states.some((s) => HIDDEN_STATES.includes(s));
  const flag = (name: string) => p.get(name) === 'true';
  const toggleFlag = (name: string) => (on: boolean) => set({ [name]: on ? 'true' : null });
  // Filtered to one bill, the payment of that bill stays in the list but not in the totals.
  const byBill = p.get('cycle') !== null;
  const sums = data ? tileSums(data.sums, data.internal, byBill) : { income: 0, expense: 0, net: 0 };
  const resultNote = data ? (byBill ? billPaymentNote(data.internal, hidden) : internalNote(data.internal, hidden)) : null;
  const estimated = data ? estimatedNote(data.estimated, hidden) : null;
  const typeActive = (kind !== 'all' ? 1 : 0) + (p.get('status') ? 1 : 0) + (p.get('installment') ? 1 : 0) + (p.get('recurrence') ? 1 : 0) + sources.length + states.length + ['spendingOnly', 'future', 'international'].filter(flag).length;
  const accountLabelOf = (id: string) => {
    const f = data?.facets.accounts.find((a) => a.id === id);
    return f ? accountLabel(f) : 'Conta';
  };
  const active = [
    ...categories.map((c) => ({ label: c || 'Sem categoria', remove: () => set({ category: categories.filter((x) => x !== c) }) })),
    ...institutions.map((c) => ({ label: c, remove: () => set({ institution: institutions.filter((x) => x !== c) }) })),
    ...accountIds.map((c) => ({ label: accountLabelOf(c), remove: () => set({ accountId: accountIds.filter((x) => x !== c) }) })),
    ...states.map((c) => ({ label: STATE_LABEL[c] ?? c, remove: () => set({ state: states.filter((x) => x !== c) }) })),
    ...sources.map((c) => ({ label: SOURCE_LABEL[c] ?? c, remove: () => set({ source: sources.filter((x) => x !== c) }) })),
    ...origins.map((c) => ({ label: `Origem: ${c}`, remove: () => set({ origin: origins.filter((x) => x !== c) }) })),
    ...(p.get('merchant') ? [{ label: `Estabelecimento: ${p.get('merchant')}`, remove: () => set({ merchant: null }) }] : []),
    ...(p.get('cycle') ? [{ label: p.get('cycle') === 'open' ? 'Fatura em aberto' : `Fatura ${monthName(p.get('cycle')!)}`, remove: () => set({ cycle: null }) }] : []),
    ...(p.get('status') ? [{ label: p.get('status') === 'pending' ? 'Só pendentes' : 'Só lançadas', remove: () => set({ status: null }) }] : []),
    ...(p.get('installment') ? [{ label: p.get('installment') === 'only' ? 'Só parceladas' : 'Sem parcelas', remove: () => set({ installment: null }) }] : []),
    ...(p.get('min') || p.get('max') ? [{ label: `Valor ${p.get('min') ? `de ${brl(Number(p.get('min')))}` : ''} ${p.get('max') ? `até ${brl(Number(p.get('max')))}` : ''}`.trim(), remove: () => set({ min: null, max: null }) }] : []),
    ...(flag('future') ? [{ label: 'Com datas futuras', remove: () => set({ future: null }) }] : []),
    ...(flag('spendingOnly') ? [{ label: 'Só gastos reais', remove: () => set({ spendingOnly: null }) }] : []),
    ...(flag('international') ? [{ label: 'Compras internacionais', remove: () => set({ international: null }) }] : []),
    ...(p.get('recurrence') ? [{ label: p.get('recurrence') === 'subscription' ? 'Só assinaturas' : p.get('recurrence') === 'recurring' ? 'Só outras recorrentes' : 'Assinaturas e recorrentes', remove: () => set({ recurrence: null }) }] : []),
    ...(flag('netSpending') ? [{ label: 'Gastos (compras menos estornos)', remove: () => set({ netSpending: null }) }] : []),
    ...(flag('hideOwnTransfers') ? [{ label: 'Sem transferências entre suas contas', remove: () => set({ hideOwnTransfers: null }) }] : []),
  ];

  const segmented = (label: string, name: string, current: string, options: Array<[string, string]>) => (
    <div class="ffield">
      <span class="muted">{label}</span>
      <div class="seg" role="group" aria-label={label}>
        {options.map(([value, text]) => (
          <button key={value} type="button" class={current === value ? 'tab on' : 'tab'} aria-pressed={current === value} onClick={() => set({ [name]: value === '' ? null : value })}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );

  const panel = (
    <div class="filter-panel">
      <Section
        title="Tipo e status"
        active={typeActive}
        onClear={() => set({ kind: null, status: null, installment: null, recurrence: null, source: null, state: null, spendingOnly: null, future: null, international: null })}
      >
        {segmented('Tipo', 'kind', kind === 'all' ? '' : kind, [['', 'Todas'], ['expense', 'Gastos'], ['income', 'Entradas']])}
        {segmented('Status', 'status', p.get('status') ?? '', [['', 'Todos'], ['posted', 'Lançadas'], ['pending', 'Pendentes']])}
        {segmented('Parcelas', 'installment', p.get('installment') ?? '', [['', 'Todas'], ['only', 'Só parceladas'], ['none', 'Sem parcelas']])}
        <div class="ffield">
          <span class="muted">Recorrência</span>
          <Select
            ariaLabel="Recorrência"
            value={p.get('recurrence') ?? ''}
            emptyLabel="Todas"
            options={[{ value: 'any', label: 'Assinaturas e recorrentes' }, { value: 'subscription', label: 'Só assinaturas' }, { value: 'recurring', label: 'Só outras recorrentes' }]}
            onChange={(value) => set({ recurrence: value || null })}
          />
        </div>
        <div class="ffield">
          <span class="muted">Fonte</span>
          <CheckList options={(data?.facets.sources ?? []).map((f) => ({ value: f.name, label: SOURCE_LABEL[f.name] ?? f.name, count: f.count }))} selected={sources} onChange={(v) => set({ source: v })} searchable={false} clearable={false} />
        </div>
        <div class="switches">
          <Switch label="Só gastos reais" checked={flag('spendingOnly')} onChange={toggleFlag('spendingOnly')} title="Sem pagar fatura, transferir entre contas ou investir" />
          <Switch label="Incluir datas futuras" checked={flag('future')} onChange={toggleFlag('future')} title="Mostra parcelas previstas" />
          <Switch label="Compras internacionais" checked={flag('international')} onChange={toggleFlag('international')} title="Só compras com valor em outra moeda" />
          <Switch
            label="Mostrar ignoradas e fora dos totais"
            checked={showHidden}
            onChange={(on) => set({ state: [...states.filter((s) => !HIDDEN_STATES.includes(s)), ...(on ? HIDDEN_STATES : [])] })}
            title="Ignoradas por você e pendentes que o banco não mostra mais"
          />
        </div>
      </Section>
      <Section title="Instituições e contas" active={institutions.length + accountIds.length} onClear={() => set({ institution: null, accountId: null })}>
        <InstitutionTree
          institutions={data?.facets.institutions ?? []}
          accounts={data?.facets.accounts ?? []}
          selectedInstitutions={institutions}
          selectedAccounts={accountIds}
          onChange={(next) => set(next)}
        />
      </Section>
      <Section title="Categorias" active={categories.length} onClear={() => set({ category: null })}>
        <CheckList options={(data?.facets.categories ?? []).map((f) => ({ value: f.name, label: f.name, count: f.count }))} selected={categories} onChange={(v) => set({ category: v })} clearable={false} />
      </Section>
      <Section title="Valor" active={p.get('min') || p.get('max') ? 1 : 0} onClear={() => set({ min: null, max: null })}>
        {data && (
          <AmountSlider
            range={data.amountRange}
            min={p.get('min') ? Number(p.get('min')) : null}
            max={p.get('max') ? Number(p.get('max')) : null}
            hidden={hidden}
            onCommit={(bounds) => set({ min: bounds.min === null ? null : String(bounds.min), max: bounds.max === null ? null : String(bounds.max) })}
          />
        )}
      </Section>
      <Section title="Origem e destino" active={origins.length + (p.get('merchant') ? 1 : 0)} onClear={() => set({ origin: null, merchant: null })}>
        <CheckList options={(data?.facets.origins ?? []).map((f) => ({ value: f.name, label: f.name, count: f.count }))} selected={origins} onChange={(v) => set({ origin: v })} clearable={false} />
      </Section>
    </div>
  );

  const sortValue = p.get('sort') ?? 'date_desc';
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
      <div class="pickers">
        <DateRangePicker from={p.get('from') ?? undefined} to={p.get('to') ?? undefined} now={now} onChange={(r) => set({ from: r.from ?? null, to: r.to ?? null })} />
        <CycleSelect value={p.get('cycle')} cycles={cards.data?.cycles ?? []} now={now} onChange={(value) => set({ cycle: value })} />
      </div>
      <div class="searchbar">
        <input class="search grow" placeholder="Buscar por descrição, categoria ou valor" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
        <button class={active.length > 0 ? 'chip on filter-toggle' : 'chip filter-toggle'} onClick={() => setSheet(true)}>
          Filtros{active.length > 0 ? ` (${active.length})` : ''}
        </button>
        <button class="chip" onClick={() => setAdding(!adding)}>
          + Nova
        </button>
      </div>

      {picking && (
        <div class="bulk-bar">
          <strong>{picked.length} selecionada{picked.length === 1 ? '' : 's'}</strong>
          <button class="link" onClick={() => setPicked(order)}>Selecionar as {pickable.length} carregadas</button>
          {data && data.total > rows.length && <span class="muted">{rows.length} de {data.total} no filtro; role a lista para carregar mais.</span>}
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
                  <strong class="good-text">{brl(sums.income, hidden)}</strong>
                </div>
                <div>
                  <span class="muted tile-label">
                    Saídas
                    {estimated && <Info tip={`${estimated} ${ESTIMATED_TIP}`} label="Sobre as parcelas estimadas" />}
                  </span>
                  <strong class="bad-text">{brl(sums.expense, hidden)}</strong>
                </div>
                <div>
                  <span class="muted tile-label">
                    Resultado do filtro
                    {resultNote && <Info tip={`${resultNote} ${byBill ? BILL_TIP : INTERNAL_TIP}`} label="Sobre o resultado" />}
                  </span>
                  <strong>{brl(sums.net, hidden)}</strong>
                </div>
              </div>
              <div class="list-bar">
                <span class="muted">{rows.length < data.total ? `${rows.length} de ${data.total}` : `${data.total}`} {data.total === 1 ? 'transação' : 'transações'}</span>
                <span class="grow" />
                <Popover
                  align="right"
                  class="icon-btn"
                  label="Ordenar"
                  tip={`Ordem: ${SORTS.find((s) => s.value === sortValue)?.label ?? ''}`}
                  trigger={
                    <Icon>
                      <path d="M7 4v16M3 16l4 4 4-4" />
                      <path d="M17 20V4M13 8l4-4 4 4" />
                    </Icon>
                  }
                >
                  {(close) => (
                    <div class="menu" role="menu">
                      {SORTS.map((s) => (
                        <button
                          key={s.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={sortValue === s.value}
                          class={sortValue === s.value ? 'menu-item on' : 'menu-item'}
                          onClick={() => {
                            set({ sort: s.value === 'date_desc' ? null : s.value });
                            close();
                          }}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  )}
                </Popover>
                <button type="button" class={picking ? 'icon-btn on' : 'icon-btn'} aria-label="Selecionar" aria-pressed={picking} data-tip={SHORTCUTS} onClick={() => (picking ? leave() : setPicking(true))}>
                  <Icon>
                    <rect x="4" y="4" width="16" height="16" rx="3" />
                    <path d="M8 12l3 3 5-6" />
                  </Icon>
                </button>
              </div>
              {data.items.length === 0 ? (
                <div class="empty">
                  Nenhuma transação com esses filtros. <button class="link" onClick={() => navigate('transactions')}>Limpar filtros</button>
                </div>
              ) : (
                <ul
                  class="rows tall tx-list panel"
                  onKeyDown={onListKey}
                  onPointerOver={(e) => (hovered.current = (e.target as HTMLElement).closest<HTMLElement>('li.tx')?.dataset.id ?? null)}
                  onPointerLeave={() => (hovered.current = null)}
                >
                  {rows.map((t) => (
                    <TxRow key={t.id} t={t} hidden={hidden} onOpen={(id) => patchParams({ tx: id })} pick={{ on: picked.includes(t.id), active: picking, toggle: (shift) => toggleRow(t.id, shift), hold: () => enter(t.id) }} />
                  ))}
                </ul>
              )}
              {rows.length < data.total && !done && (
                <div ref={setSentinel} class="sentinel muted">
                  {busy ? 'Carregando mais…' : ''}
                </div>
              )}
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
