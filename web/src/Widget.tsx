import type { ComponentChildren } from 'preact';
import { ago, isStale } from './format.ts';
import { hrefFor, navigate } from './router.ts';

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
  children: ComponentChildren;
}

export function Widget({ title, to, asOf, now, loading, error, actions, children }: Props) {
  const stale = asOf !== undefined && isStale(asOf, now);
  // The whole card opens its screen; controls and links inside it keep their own action.
  const open = (event: MouseEvent) => {
    if (!to || (event.target as HTMLElement).closest('a, button, select, input, label, summary, [data-no-nav]')) return;
    if (window.getSelection()?.toString()) return;
    navigate(to.page, to.params);
  };
  return (
    <section class={to ? 'widget linked' : 'widget'} onClick={open}>
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
        <div class="widget-actions" data-no-nav>{actions}</div>
      </header>
      <div class="widget-body">{error ? <div class="error">Não foi possível carregar: {error}</div> : loading ? <div class="empty">Carregando…</div> : children}</div>
      {asOf !== undefined && !error && <footer class={stale ? 'asof stale' : 'asof'}>Dados {asOf === null ? 'sem data de sincronização' : ago(asOf, now)}</footer>}
    </section>
  );
}

export function PeriodSelect<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string }>; onChange: (id: T) => void }) {
  return (
    <select class="select" value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value as T)} aria-label="Período">
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
