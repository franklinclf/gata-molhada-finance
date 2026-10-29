import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { canCreate, filterOptions, step, toRows, type Option } from './select-model.ts';

export type { Option } from './select-model.ts';

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: readonly Option[];
  placeholder?: string;
  ariaLabel?: string;
  /** Show a search box. By default it appears when there are more than 8 options. */
  searchable?: boolean;
  /** Lets the person type a name that is not in the list; `onChange` then gets that text. */
  creatable?: boolean;
  /** Adds an option with an empty value at the top, for example "Sem grupo". */
  emptyLabel?: string;
  disabled?: boolean;
  class?: string;
}

const PANEL_MAX = 340;

/**
 * A dropdown that replaces the browser's own: the same list on every system, with headings for groups, a search box,
 * keyboard use (arrows, Enter, Esc, type to search) and, when asked, a way to create a new option. On a phone it opens
 * as a sheet from the bottom.
 */
export function Select({ value, onChange, options, placeholder = 'Escolher', ariaLabel, searchable, creatable = false, emptyLabel, disabled = false, class: className }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const [place, setPlace] = useState<{ top?: number; bottom?: number; left: number; width: number }>({ left: 0, width: 240 });
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const all: Option[] = emptyLabel !== undefined ? [{ value: '', label: emptyLabel }, ...options] : [...options];
  const showSearch = searchable ?? (options.length > 8 || creatable);
  const shown = filterOptions(all, query);
  const make = creatable && canCreate(all, query);
  const rows = toRows(shown);
  const count = shown.length + (make ? 1 : 0);
  const current = all.find((o) => o.value === value);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery('');
    if (refocus) trigger.current?.focus();
  };
  const choose = (next: string) => {
    onChange(next);
    close();
  };
  const pick = (index: number) => {
    if (index < shown.length) choose(shown[index]!.value);
    else if (make) choose(query.trim());
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    const width = Math.max(box.width, 240);
    const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
    setPlace(below < PANEL_MAX && box.top > below ? { bottom: window.innerHeight - box.top + 4, left, width } : { top: box.bottom + 4, left, width });
    setAt(Math.max(0, shown.findIndex((o) => o.value === value)));
    setTimeout(() => (showSearch ? search.current?.focus() : list.current?.focus()), 0);
  }, [open]);
  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, open, query]);
  useEffect(() => {
    if (!open) return;
    const onResize = () => close(false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAt((a) => step(a, 1, count));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((a) => step(a, -1, count));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setAt(Math.max(0, count - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(at);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') close(false);
    else if (!showSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      // Without a search box, typing jumps to the next option that starts with that letter.
      const letter = e.key.toLowerCase();
      const from = shown.findIndex((o, i) => i > at && o.label.toLowerCase().startsWith(letter));
      const index = from >= 0 ? from : shown.findIndex((o) => o.label.toLowerCase().startsWith(letter));
      if (index >= 0) setAt(index);
    }
  };

  let optionIndex = -1;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={`select select-btn${className ? ` ${className}` : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span class={current ? 'select-value clip' : 'select-value clip muted'}>{current ? current.label : value !== '' ? value : placeholder}</span>
        <span aria-hidden="true" class="select-chevron">▾</span>
      </button>
      {open &&
        createPortal(
          <>
            <div class="select-backdrop" onClick={() => close()} />
            <div class="select-panel" style={{ top: place.top, bottom: place.bottom, left: place.left, width: place.width }} onKeyDown={onKeyDown}>
              {showSearch && (
                <input ref={search} class="select-search" aria-label="Buscar" placeholder={creatable ? 'Buscar ou criar…' : 'Buscar…'} value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
              )}
              <ul ref={list} class="select-list" role="listbox" tabIndex={-1} aria-label={ariaLabel}>
                {rows.map((row, i) => {
                  if (row.kind === 'group') {
                    return (
                      <li key={`g${i}`} class="select-group" role="presentation">
                        {row.label}
                      </li>
                    );
                  }
                  optionIndex++;
                  const index = optionIndex;
                  const selected = row.option.value === value;
                  return (
                    <li key={`o${row.option.value}`} role="option" aria-selected={selected} data-active={index === at} class={`select-option${index === at ? ' active' : ''}${row.option.group ? ' nested' : ''}`} onMouseEnter={() => setAt(index)} onClick={() => choose(row.option.value)}>
                      <span class="select-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                      <span class="grow clip">{row.option.label}</span>
                      {row.option.hint && <span class="muted">{row.option.hint}</span>}
                    </li>
                  );
                })}
                {make && (
                  <li role="option" aria-selected={false} data-active={at === shown.length} class={`select-option create${at === shown.length ? ' active' : ''}`} onMouseEnter={() => setAt(shown.length)} onClick={() => choose(query.trim())}>
                    <span class="select-check" aria-hidden="true">+</span>
                    <span class="grow clip">Criar “{query.trim()}”</span>
                  </li>
                )}
                {count === 0 && <li class="select-empty">Nada encontrado.</li>}
              </ul>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
