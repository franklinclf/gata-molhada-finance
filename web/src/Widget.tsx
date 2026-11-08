import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ago, isStale } from './format.ts';
import type { SizeClass } from './grid.ts';
import { hrefFor, navigate } from './router.ts';
import { Select } from './Select.tsx';

/** False where a widget is as tall as its content (the phone stack): there a list shows every row. */
export const FixedHeight = createContext(true);
/** The look the dashboard gives the widget around it (see `sizeClassPx`). A small widget gives up its footer and tightens its spacing. */
export const WidgetSize = createContext<SizeClass>('md');
/** Lets a widget with nothing to show tell the grid, which then gives it a line instead of its whole cell. */
export const Collapse = createContext<(collapsed: boolean) => void>(() => {});
/** True when the widget body has a fixed height to fill, so lists may be cut to what fits. */
const FitRows = createContext(false);

interface Props {
  title: string;
  /** Where the title leads: the detailed screen of this widget, with its current scope. */
  to?: { page: string; params?: Record<string, string | undefined> };
  /** Oldest "last synced" time behind the numbers. Shown on every widget so the age of the data is never hidden. */
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

export function Widget({ title, to, asOf, now, loading, error, actions, empty, head, children }: Props) {
  const [expanded, setExpanded] = useState(false);
  const fixed = useContext(FixedHeight);
  const small = useContext(WidgetSize) === 'sm';
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
  useLayoutEffect(checkFade);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const observer = new ResizeObserver(checkFade);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const stale = asOf !== undefined && isStale(asOf, now);
  const age = asOf === undefined || error ? undefined : `Dados ${asOf === null ? 'sem data de sincronização' : ago(asOf, now)}`;
  // A small widget has no room for the footer line: the age goes to the tooltip, and the footer comes back when the data is stale.
  const footer = age !== undefined && !(small && !stale);
  // The whole card opens its screen; controls and links inside it keep their own action.
  const open = (event: MouseEvent) => {
    if (!to || (event.target as HTMLElement).closest('a, button, select, input, label, summary, [data-no-nav]')) return;
    if (window.getSelection()?.toString()) return;
    navigate(to.page, to.params);
  };
  return (
    <>
    {expanded && <div class="widget-backdrop" onClick={() => setExpanded(false)} />}
    <section class={`${to ? 'widget linked' : 'widget'}${expanded ? ' expanded' : ''}${small && !expanded ? ' sm' : ''}${collapsed ? ' empty-state' : ''}`} onClick={open}>
      <header data-tip={small && !footer ? age : undefined}>
        <h2>
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
          <FitRows.Provider value={fixed && !expanded}>
            {head !== undefined && <div class="widget-head">{head}</div>}
            {children !== undefined && <div class="widget-scroll">{children}</div>}
          </FitRows.Provider>
        )}
      </div>
      {footer && !collapsed && <footer class={stale ? 'asof stale' : 'asof'}>{age}</footer>}
    </section>
    </>
  );
}

/**
 * A list that shows as many rows as the widget has room for and ends with "+N" for the rest, so the height is used and no row is cut in half.
 * Every row is drawn first and the ones past the edge are hidden after measuring, so rows of any height (a wrapped name, a two-line item) fit correctly.
 * Where the widget has no fixed height, or it is expanded, every row shows.
 */
export function FitList({ rows, noun, class: cls = 'rows' }: { rows: ComponentChildren[]; /** Singular and plural of what the rows are, for "+3 cartões". */ noun: [string, string]; class?: string }) {
  const list = useRef<HTMLUListElement>(null);
  const fit = useContext(FitRows);
  const [cut, setCut] = useState(0);
  const measure = () => {
    const ul = list.current;
    if (!ul) return;
    const items = ([...ul.children] as HTMLElement[]).filter((el) => el.dataset.more === undefined);
    for (const el of items) el.hidden = false;
    const body = ul.closest('.widget-body') as HTMLElement | null;
    if (!fit || !body) return setCut(0);
    // Positions are taken inside the scrolled content, so the answer does not depend on how far the body is scrolled.
    const origin = body.getBoundingClientRect().top - body.scrollTop;
    const bottom = (el: Element) => el.getBoundingClientRect().bottom - origin;
    const scroller = ul.parentElement!;
    const below = scroller.getBoundingClientRect().bottom - ul.getBoundingClientRect().bottom;
    const limit = body.clientHeight - below;
    if (items.length === 0 || bottom(items[items.length - 1]!) <= limit) return setCut(0);
    const moreLine = 34;
    const shown = items.filter((el) => bottom(el) <= limit - moreLine).length;
    items.forEach((el, i) => (el.hidden = i >= shown));
    setCut(items.length - shown);
  };
  const again = useRef(measure);
  again.current = measure;
  useLayoutEffect(measure);
  useEffect(() => {
    const body = list.current?.closest('.widget-body');
    if (!body) return;
    const observer = new ResizeObserver(() => again.current());
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  return (
    <ul class={`${cls} fit`} ref={list}>
      {rows}
      {cut > 0 && (
        <li data-more class="more-rows muted">
          +{cut} {cut === 1 ? noun[0] : noun[1]}
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
