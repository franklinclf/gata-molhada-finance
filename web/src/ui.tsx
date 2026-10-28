import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { brl, dayMonth, localDay } from './format.ts';
import { hrefFor } from './router.ts';

export function Loading({ error }: { error?: string | null }) {
  return error ? <div class="error">Não foi possível carregar: {error}</div> : <div class="empty">Carregando…</div>;
}

export function Money({ cents, hidden, signed }: { cents: number; hidden: boolean; signed?: boolean }) {
  const cls = signed ? (cents > 0 ? 'good-text' : cents < 0 ? 'bad-text' : '') : '';
  return <span class={cls}>{brl(cents, hidden)}</span>;
}

/** A link that opens a screen with a scope, so a number can lead to what is behind it. */
export function Go({ page, params, children, class: cls }: { page: string; params?: Record<string, string | undefined>; children: ComponentChildren; class?: string }) {
  return (
    <a class={cls ? `go ${cls}` : 'go'} href={hrefFor(page, params)}>
      {children}
    </a>
  );
}

export interface Option {
  value: string;
  label: string;
  count?: number;
}

/** A list of checkboxes with optional search, used inline in the filter panel and inside the popover select. */
export function CheckList({ options, selected, onChange, searchable = true, maxHeight = 240 }: { options: Option[]; selected: string[]; onChange: (value: string[]) => void; searchable?: boolean; maxHeight?: number }) {
  const [filter, setFilter] = useState('');
  const visible = options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  return (
    <div class="checklist">
      {searchable && options.length > 6 && <input class="search" placeholder="Buscar" value={filter} onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)} />}
      <div class="options" style={{ maxHeight: `${maxHeight}px` }}>
        {visible.length === 0 && <div class="muted">Nada encontrado</div>}
        {visible.map((o) => (
          <label key={o.value} class="option">
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
            <span class="grow clip">{o.label || 'Sem categoria'}</span>
            {o.count !== undefined && <span class="muted">{o.count}</span>}
          </label>
        ))}
      </div>
      {selected.length > 0 && (
        <button class="link" onClick={() => onChange([])}>
          Limpar
        </button>
      )}
    </div>
  );
}

/** A button that opens a checklist. */
export function MultiSelect({ label, options, selected, onChange, searchable = true }: { label: string; options: Option[]; selected: string[]; onChange: (value: string[]) => void; searchable?: boolean }) {
  return (
    <details class="multi">
      <summary class={selected.length > 0 ? 'chip on' : 'chip'}>
        {label}
        {selected.length > 0 ? ` (${selected.length})` : ''}
      </summary>
      <div class="popover">
        <CheckList options={options} selected={selected} onChange={onChange} searchable={searchable} />
      </div>
    </details>
  );
}

/** A filter section that can be folded away; sections with an active filter start open. */
export function Section({ title, active, children, open = false }: { title: string; active?: number; children: ComponentChildren; open?: boolean }) {
  // Opened by default only when it mounts, so clearing the last filter does not fold it under the cursor.
  const [startOpen] = useState(open || (active ?? 0) > 0);
  return (
    <details class="fsection" open={startOpen}>
      <summary>
        <span>{title}</span>
        {(active ?? 0) > 0 && <span class="badge info">{active}</span>}
      </summary>
      <div class="fbody">{children}</div>
    </details>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, [string, string]> = {
    open: ['Em aberto', 'info'],
    paid: ['Paga', 'good'],
    partial: ['Paga em parte', 'warn'],
    unpaid: ['A pagar', 'warn'],
    overdue: ['Vencida', 'bad'],
    empty: ['Sem gastos', 'muted'],
    unknown: ['Sem dados', 'muted'],
  };
  const [text, tone] = labels[status] ?? [status, 'muted'];
  return <span class={`badge ${tone}`}>{text}</span>;
}

export const STATE_LABEL: Record<string, string> = {
  confirmed: 'Confirmada pelas duas fontes',
  single_source: 'Só uma fonte tem (normal)',
  conflict: 'Fontes discordam do status',
  stale_pending: 'Pendente que o banco não mostra (fora dos totais)',
  billed: 'Pendente confirmada pela fatura do cartão',
  ignored: 'Ignorada por você (fora dos totais)',
};

export function TxRow({ t, hidden, onOpen }: { t: { id: string; sourceIds?: string[]; description: string; amount: number; occurredAt: string; status: string; state: string; category: string | null; account: { institution: string; last4: string | null } }; hidden: boolean; onOpen: (id: string) => void }) {
  return (
    <li class="tx" data-no-nav onClick={() => onOpen(t.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(t.id)}>
      <div class="grow">
        <div class="clip">{t.description}</div>
        <div class="muted clip">
          {dayMonth(localDay(t.occurredAt))} · {t.account.institution}
          {t.account.last4 ? ` •••• ${t.account.last4}` : ''} · {t.category ?? 'Sem categoria'}
          {t.status === 'pending' ? ' · pendente' : ''}
          {t.state === 'ignored' ? ' · ignorada' : t.state === 'stale_pending' ? ' · fora dos totais' : ''}
        </div>
      </div>
      {t.state === 'single_source' && t.sourceIds && t.sourceIds.length === 1 && <span class="badge muted" data-tip={`Só o ${t.sourceIds[0]} tem esta transação`}>só {t.sourceIds[0]}</span>}
      <strong class={t.amount >= 0 ? 'good-text' : ''}>{brl(t.amount, hidden)}</strong>
    </li>
  );
}
