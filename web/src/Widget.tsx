import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { fitBigFigures } from './fit-text.ts';
import { ago } from './format.ts';
import type { SizeClass } from './grid.ts';
import { hrefFor, navigate } from './router.ts';
import { Select } from './Select.tsx';

/** False where a widget is as tall as its content (the phone stack): there a list shows every row. */
export const FixedHeight = createContext(true);
/** The look the dashboard gives the widget around it (see `sizeClassPx`). A small widget tightens its spacing and shows only the key figure. */
export const WidgetSize = createContext<SizeClass>('md');
/** True when the dashboard gives the widget one row: the title and the key figure are all it shows. */
export const WidgetTiny = createContext(false);
/** Lets a widget with nothing to show tell the grid, which then gives it a line instead of its whole cell. */
export const Collapse = createContext<(collapsed: boolean) => void>(() => {});

interface Props {
  title: string;
  /** Where the title leads: the detailed screen of this widget, with its current scope. */
  to?: { page: string; params?: Record<string, string | undefined> };
  /** Oldest "last synced" time behind the numbers. Shown as a tooltip on the header. */
  asOf?: string | null | undefined;
  now: Date;
  loading?: boolean;
  error?: string | null;
  actions?: ComponentChildren;
  /** The main figure and chart. It stays in view while the rest of the widget scrolls. */
  head?: ComponentChildren;
  /** Set when there is nothing to show (no goals, nothing waiting): the widget becomes its title with this short text beside it, and gives the space back. */
  empty?: string;
  /** The partitioned detail (cards, categories, accounts, lists). It scrolls under the head, or opens in full with the expand button. */
  children?: ComponentChildren;
  /** A small but tall box (a narrow column): the secondary head lines and the detail stay visible instead of only the key figure. */
  column?: boolean;
}

const icon = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true } as const;
const ExpandIcon = () => (
  <svg {...icon}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);
const CollapseIcon = () => (
  <svg {...icon}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export function Widget({ title, to, asOf, now, loading, error, actions, empty, head, children, column }: Props) {
  const [expanded, setExpanded] = useState(false);
  const small = useContext(WidgetSize) === 'sm';
  const tiny = useContext(WidgetTiny);
  const report = useContext(Collapse);
  const collapsed = empty !== undefined && !loading && !error;
  useEffect(() => {
    report(collapsed);
    return () => report(false);
  }, [collapsed]);
  const body = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);
  // A soft fade at the foot of the body tells that more is below, so a row cut by the edge does not look like a wrong number.
  const checkFade = () => {
    const el = body.current;
    if (!el) return;
    const more = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    setFade((was) => (was === more ? was : more));
  };
  // A key figure is never cut: it shrinks to the width it has (see fit-text.ts).
  const fitFigures = () => body.current && fitBigFigures(body.current);
  useLayoutEffect(() => {
    checkFade();
    fitFigures();
  });
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      checkFade();
      fitFigures();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The age of the data is not a line on every widget: it is a tooltip on the header, and "Atualização das fontes" lists it per bank.
  const age = asOf === undefined || error ? undefined : `Dados ${asOf === null ? 'sem data de sincronização' : ago(asOf, now)}`;
  // The whole card opens its screen; controls and links inside it keep their own action.
  const open = (event: MouseEvent) => {
    if (!to || (event.target as HTMLElement).closest('a, button, select, input, label, summary, [data-no-nav]')) return;
    if (window.getSelection()?.toString()) return;
    navigate(to.page, to.params);
  };
  return (
    <>
    {expanded && <div class="widget-backdrop" onClick={() => setExpanded(false)} />}
    <section class={`${to ? 'widget linked' : 'widget'}${expanded ? ' expanded' : ''}${small && !expanded ? ' sm' : ''}${small && column && !expanded ? ' col' : ''}${tiny && !expanded ? ' tiny' : ''}${collapsed ? ' empty-state' : ''}`} onClick={open}>
      <header data-tip={age}>
        <h2 title={title}>
          {to ? (
            <a class="go title clip" href={hrefFor(to.page, to.params)}>
              {title} <span aria-hidden="true">›</span>
            </a>
          ) : (
            title
          )}
        </h2>
        {collapsed && <span class="empty-note muted" data-tip={empty}>{empty}</span>}
        <div class="widget-actions" data-no-nav>
          {actions}
          {children !== undefined && !collapsed && (
            <button class="expand" onClick={() => setExpanded(!expanded)} data-tip={expanded ? 'Recolher (Esc)' : 'Expandir para ver tudo'} aria-label={expanded ? 'Recolher' : 'Expandir'}>
              {expanded ? <CollapseIcon /> : <ExpandIcon />}
            </button>
          )}
        </div>
      </header>
      <div ref={body} class={fade ? 'widget-body fade' : 'widget-body'} onScroll={checkFade} hidden={collapsed}>
        {collapsed ? null : error ? (
          <div class="error">Não foi possível carregar: {error}</div>
        ) : loading ? (
          <div class="empty">Carregando…</div>
        ) : (
          <>
            {head !== undefined && <div class="widget-head">{head}</div>}
            {children !== undefined && <div class="widget-scroll">{children}</div>}
          </>
        )}
      </div>
    </section>
    </>
  );
}

interface FitListProps {
  rows: ComponentChildren[];
  class?: string;
  /** Rows the server has that are not loaded yet (a long transaction list). They are fetched as the end of the list comes into view. */
  unloaded?: number;
  /** Asks for the next batch of `unloaded` rows. */
  loadMore?: () => void;
  loadingMore?: boolean;
}

/**
 * A list that shows every row and scrolls with the widget body, whose head stays in view. When the server has more rows than were loaded,
 * the next batch is asked for as the end of the list comes into view, so there is no button to press.
 */
export function FitList({ rows, class: cls = 'rows', unloaded = 0, loadMore, loadingMore = false }: FitListProps) {
  const end = useRef<HTMLLIElement>(null);
  const more = useRef(loadMore);
  more.current = loadMore;
  const wanting = unloaded > 0 && !loadingMore;
  useEffect(() => {
    const el = end.current;
    if (!el || !wanting) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more.current?.();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [wanting, rows.length]);
  return (
    <ul class={`${cls} fit`}>
      {rows}
      {unloaded > 0 && (
        <li ref={end} class="more-rows" aria-hidden="true">
          {loadingMore ? 'Carregando…' : ''}
        </li>
      )}
    </ul>
  );
}

export function PeriodSelect<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string }>; onChange: (id: T) => void }) {
  return (
    <Select ariaLabel="Período" value={value} onChange={(next) => onChange(next as T)} options={options.map((o) => ({ value: o.id, label: o.label }))} />
  );
}
