import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { brl, dayMonth, foreignMoney, localDay } from './format.ts';
import { sourceLabel, theSource } from './names.ts';
import { hrefFor } from './router.ts';
import { Checkbox } from './Checkbox.tsx';
import { HOLD_MS, movedTooFar } from './row-selection.ts';

export function Loading({ error }: { error?: string | null }) {
  return error ? <div class="error">Não foi possível carregar: {error}</div> : <div class="empty">Carregando…</div>;
}

/** An on/off switch with its label. A button, so Space and Enter work; the state is announced through aria-checked. */
export function Switch({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (next: boolean) => void; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} class="switch-btn" title={title} onClick={() => onChange(!checked)}>
      <span class="switch-track" aria-hidden="true">
        <span class="switch-thumb" />
      </span>
      {label}
    </button>
  );
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
export function CheckList({ options, selected, onChange, searchable = true, maxHeight = 240, clearable = true }: { options: Option[]; selected: string[]; onChange: (value: string[]) => void; searchable?: boolean; maxHeight?: number; /** Shows a "Limpar" link under the list; a filter section that has its own in the header turns it off. */ clearable?: boolean }) {
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
            <Checkbox state={selected.includes(o.value)} label={o.label || 'Sem categoria'} onChange={() => toggle(o.value)} />
            <span class="grow clip">{o.label || 'Sem categoria'}</span>
            {o.count !== undefined && <span class="muted">{o.count}</span>}
          </label>
        ))}
      </div>
      {clearable && selected.length > 0 && (
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

/** A filter section that can be folded away. It starts open; a "Limpar" in the header shows only while the section has a filter on. */
export function Section({ title, active, onClear, children }: { title: string; active?: number; onClear?: () => void; children: ComponentChildren }) {
  const count = active ?? 0;
  return (
    <details class="fsection" open>
      <summary>
        <span>{title}</span>
        {count > 0 && <span class="badge info">{count}</span>}
        {count > 0 && onClear && (
          <button
            type="button"
            class="link fclear"
            onClick={(e) => {
              // Inside the summary: without this the click would also fold the section.
              e.preventDefault();
              e.stopPropagation();
              onClear();
            }}
          >
            Limpar
          </button>
        )}
      </summary>
      <div class="fbody">{children}</div>
    </details>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, [string, string]> = {
    open: ['Em aberto', 'info'],
    paid: ['Paga', 'good'],
    rolled: ['Sobra rolou', 'warn'],
    partial: ['Paga em parte', 'warn'],
    // Closed and not paid yet, before its due date.
    unpaid: ['Fechada', 'warn'],
    overdue: ['Vencida', 'bad'],
    empty: ['Sem gastos', 'muted'],
    unknown: ['Pagamento não conferido', 'muted'],
  };
  const [text, tone] = labels[status] ?? [status, 'muted'];
  return <span class={`badge ${tone}`}>{text}</span>;
}

/** Short chip texts. The first two and `billed` have no control anymore: they stay for old links. */
export const STATE_LABEL: Record<string, string> = {
  confirmed: 'Confirmadas',
  single_source: 'Em uma fonte',
  conflict: 'Fontes divergem',
  stale_pending: 'Pendentes sumidas',
  billed: 'Pendentes na fatura',
  ignored: 'Ignoradas',
};

/** What a row needs to take part in a selection: its state, a toggle (with Shift held for a range) and the press-and-hold that starts selecting. */
export interface RowPick {
  on: boolean;
  /** Selection mode is on: the row shows a checkbox and a click toggles it instead of opening the drawer. */
  active: boolean;
  toggle: (shift: boolean) => void;
  hold: () => void;
}

export function TxRow({ t, hidden, onOpen, pick: wanted }: { t: { id: string; estimated?: true; sourceIds?: string[]; title?: string; customName?: string | null; description: string; amount: number; occurredAt: string; status: string; state: string; category: string | null; foreign?: { currency: string; amount: number; converted: boolean } | null; reversal?: { side: 'charge' | 'refund'; otherDay: string; amount: number; partial: boolean } | null; account: { institution: string; last4: string | null } }; hidden: boolean; onOpen: (id: string) => void; pick?: RowPick }) {
  // An estimated installment is read-only (no category, status or bill to change), so it is never picked: a click opens its explanation.
  const pick = t.estimated ? undefined : wanted;
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const fired = useRef(false);
  const [pressing, setPressing] = useState(false);
  const cancel = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
    setPressing(false);
  };
  const press = (e: PointerEvent) => {
    // A press on the checkbox or a button inside the row is not a hold; one already selecting needs no hold.
    fired.current = false;
    if (!pick || pick.active || e.button > 0) return;
    const timer = setTimeout(() => {
      fired.current = true;
      hold.current = null;
      setPressing(false);
      navigator.vibrate?.(15);
      pick.hold();
    }, HOLD_MS);
    hold.current = { timer, x: e.clientX, y: e.clientY };
    setPressing(true);
  };
  const move = (e: PointerEvent) => {
    if (hold.current && movedTooFar(hold.current, { x: e.clientX, y: e.clientY })) cancel();
  };
  const act = (shift: boolean) => (pick?.active ? pick.toggle(shift) : onOpen(t.id));
  return (
    <li
      class={`tx${pick?.on ? ' picked' : ''}${pressing ? ' pressing' : ''}${pick ? ' holdable' : ''}`}
      data-no-nav
      data-id={t.id}
      onPointerDown={press}
      onPointerMove={move}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => fired.current && e.preventDefault()}
      onClick={(e) => {
        // The click that ends a press-and-hold must not also open the row.
        if (fired.current) {
          fired.current = false;
          return;
        }
        act(e.shiftKey);
      }}
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && act(e.shiftKey)}
    >
      {/* The gutter is there with selection off too (empty), so a row does not shift when the mode turns on. */}
      {wanted && (
        <span class="tx-gutter">
          {pick?.active && <Checkbox class="tx-pick" state={pick.on} label="Selecionar" onChange={() => pick.toggle(false)} />}
        </span>
      )}
      <div class="grow">
        {/* A name the owner gave keeps the bank text at hand. */}
        <div class="clip" data-tip={t.customName ? `${t.title ?? t.customName}\nBanco: ${t.description}` : undefined}>
          {t.title ?? t.description}
        </div>
        {/* On a narrow screen the account moves to its own line, so the category is the part that keeps its room. */}
        <div class="muted tx-meta">
          <span class="tx-day">{dayMonth(localDay(t.occurredAt))}</span>
          <span class="tx-acct">
            {t.account.institution}
            {t.account.last4 ? ` •••• ${t.account.last4}` : ''}
          </span>
          <span class="tx-cat">
            {t.category ?? 'Sem categoria'}
            {t.status === 'pending' ? ' · pendente' : ''}
            {t.state === 'ignored' ? ' · ignorada' : t.state === 'stale_pending' ? ' · fora dos totais' : ''}
          </span>
          {/* The badges sit in the meta line, not beside the text, so the title and the category keep the whole width of the row. */}
          <span class="tx-badges">
            {t.foreign && <span class="badge info" data-tip={hidden ? 'Compra em outra moeda' : `Compra em ${foreignMoney(t.foreign.amount, t.foreign.currency)}, cobrada em reais pelo cartão`}>{t.foreign.currency}</span>}
            {/* With one live source, "only one source has it" says nothing, so only a retired source's leftovers are marked. */}
            {t.state === 'single_source' && t.sourceIds && t.sourceIds.length === 1 && t.sourceIds[0] !== 'pluggy' && <span class="badge muted" data-tip={`Só ${theSource(t.sourceIds[0]!)} tem esta transação`}>só {sourceLabel(t.sourceIds[0]!)}</span>}
            {t.reversal?.side === 'charge' && (
              <span class="badge good" data-tip={hidden ? 'Estornado' : `${t.reversal.partial ? 'Estorno parcial' : 'Estornado'} em ${dayMonth(t.reversal.otherDay)}: ${brl(t.reversal.amount)} de volta`}>
                {t.reversal.partial ? 'estorno parcial' : 'estornado'}
              </span>
            )}
            {t.reversal?.side === 'refund' && <span class="badge good" data-tip={`Devolve a compra de ${dayMonth(t.reversal.otherDay)}`}>estorno</span>}
            {t.estimated && <span class="badge info" data-tip="parcela de um parcelamento que o banco cobra na fatura, mas não listou">estimada</span>}
          </span>
        </div>
      </div>
      <strong class={`${t.amount >= 0 ? 'good-text' : ''}${t.reversal?.side === 'charge' && !t.reversal.partial ? ' struck' : ''}`}>{brl(t.amount, hidden)}</strong>
    </li>
  );
}
