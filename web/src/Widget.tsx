import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ago, isStale } from './format.ts';
import { hrefFor, navigate } from './router.ts';
import { Select } from './Select.tsx';

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
  /** The partitioned detail (cards, categories, accounts, lists). It scrolls under the head, or opens in full with the expand button. */
  children?: ComponentChildren;
}

export function Widget({ title, to, asOf, now, loading, error, actions, head, children }: Props) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);
  const stale = asOf !== undefined && isStale(asOf, now);
  // The whole card opens its screen; controls and links inside it keep their own action.
  const open = (event: MouseEvent) => {
    if (!to || (event.target as HTMLElement).closest('a, button, select, input, label, summary, [data-no-nav]')) return;
    if (window.getSelection()?.toString()) return;
    navigate(to.page, to.params);
  };
  return (
    <>
    {expanded && <div class="widget-backdrop" onClick={() => setExpanded(false)} />}
    <section class={`${to ? 'widget linked' : 'widget'}${expanded ? ' expanded' : ''}`} onClick={open}>
      <header>
        <h2>
          {to ? (
            <a class="go title clip" href={hrefFor(to.page, to.params)}>
              {title} <span aria-hidden="true">›</span>
            </a>
          ) : (
            title
          )}
        </h2>
        <div class="widget-actions" data-no-nav>
          {actions}
          {children !== undefined && (
            <button class="expand" onClick={() => setExpanded(!expanded)} data-tip={expanded ? 'Recolher (Esc)' : 'Expandir para ver tudo'} aria-label={expanded ? 'Recolher' : 'Expandir'}>
              {expanded ? '✕' : '⤢'}
            </button>
          )}
        </div>
      </header>
      <div class="widget-body">
        {error ? (
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
      {asOf !== undefined && !error && <footer class={stale ? 'asof stale' : 'asof'}>Dados {asOf === null ? 'sem data de sincronização' : ago(asOf, now)}</footer>}
    </section>
    </>
  );
}

export function PeriodSelect<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string }>; onChange: (id: T) => void }) {
  return (
    <Select ariaLabel="Período" value={value} onChange={(next) => onChange(next as T)} options={options.map((o) => ({ value: o.id, label: o.label }))} />
  );
}
