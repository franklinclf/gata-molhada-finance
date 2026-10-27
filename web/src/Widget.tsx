import type { ComponentChildren } from 'preact';
import { ago, isStale } from './format.ts';

interface Props {
  title: string;
  /** Oldest "last synced" time behind the numbers. Shown on every widget so the age of the data is never hidden. */
  asOf?: string | null | undefined;
  now: Date;
  loading?: boolean;
  error?: string | null;
  actions?: ComponentChildren;
  children: ComponentChildren;
}

export function Widget({ title, asOf, now, loading, error, actions, children }: Props) {
  const stale = asOf !== undefined && isStale(asOf, now);
  return (
    <section class="widget">
      <header>
        <h2>{title}</h2>
        <div class="widget-actions">{actions}</div>
      </header>
      {error ? <div class="error">Não foi possível carregar: {error}</div> : loading ? <div class="empty">Carregando…</div> : children}
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
