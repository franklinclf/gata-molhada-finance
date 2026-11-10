import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LayoutItem } from './api.ts';
import { MIN_SIZES } from '../../src/api/layout.ts';
import { collapseEmpty, columnsFor, COLUMNS, fitToColumns, PARTIAL_COLUMNS, WIDE_SLOT, place, type Box } from './grid.ts';
import { Collapse } from './Widget.tsx';

export const ROW_HEIGHT = 72;
export const GAP = 14;
/** The move bar above a widget while customizing; the widget is that much shorter than its cell. */
const GRIP_HEIGHT = 32;

/** Sizes offered while customizing, in cells: from one cell (1 × 1, only for single-figure widgets) and a title with a figure (2 × 1) to half of a wide screen. */
export const SIZES: Array<[number, number, string]> = [
  [1, 1, 'Célula (1 × 1)'],
  [2, 1, 'Mínimo (2 × 1)'],
  [3, 1, 'Faixa (3 × 1)'],
  [2, 2, 'Pequeno (2 × 2)'],
  [3, 2, 'Pequeno largo (3 × 2)'],
  [3, 3, 'Quadrado (3 × 3)'],
  [4, 4, 'Médio (4 × 4)'],
  [4, 6, 'Alto (4 × 6)'],
  [6, 6, 'Largo (6 × 6)'],
  [8, 7, 'Grande (8 × 7)'],
];

/** The sizes a widget can take here: not under its minimum and not wider than the grid. */
export function sizeOptions(min: { w: number; h: number }, columns: number): Array<[number, number, string]> {
  return SIZES.filter(([w, h]) => w >= min.w && h >= min.h && w <= columns);
}

interface Drag {
  id: string;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  cellW: number;
  cellH: number;
  origin: Box;
}

interface Props {
  items: LayoutItem[];
  editing: boolean;
  /** Widgets can be moved and resized from a small handle at any time, not only while editing. */
  canDrag?: boolean;
  onChange: (items: LayoutItem[]) => void;
  renderItem: (item: LayoutItem, pixels: { width: number; height: number }) => ComponentChildren;
  /** Use as many columns as the screen holds (13, and one more per 144 px past 1876 px) instead of 9. */
  wide?: boolean;
  onColumns?: (columns: number) => void;
  onRemove: (id: string) => void;
  titleOf: (item: LayoutItem) => string;
}

/**
 * Dashboard grid. While editing, a widget moves by its top bar and resizes by its corner; neighbours make room.
 * The draft is kept in state during the gesture and saved when the pointer is released.
 */
export function Grid({ items, editing, canDrag = true, wide = false, onColumns, onChange, renderItem, onRemove, titleOf }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<LayoutItem[] | null>(null);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Shrink first, then wrap: the count only drops once the columns would be thinner than the minimum slot. Without "Largura total" the grid does not grow past 9.
  const columns = width > 0 ? columnsFor(width, GAP, WIDE_SLOT, wide ? 36 : PARTIAL_COLUMNS) : COLUMNS;
  useEffect(() => onColumns?.(columns), [columns]);
  const cellWidth = width > 0 ? (width + GAP) / columns : 0;
  // A widget saved on a wider screen is shown inside the columns there are now, in a free place and never over another widget.
  const fitted = (list: LayoutItem[]) => fitToColumns(list, columns);
  // Widgets with nothing to show (no goals, nothing to review) report it and take a line; while customizing every widget keeps the size it was given.
  const [empty, setEmpty] = useState<ReadonlySet<string>>(new Set());
  const reporter = (id: string) => (on: boolean) => setEmpty((was) => (was.has(id) === on ? was : new Set(on ? [...was, id] : [...was].filter((x) => x !== id))));
  const shown = editing ? fitted(draft ?? items) : collapseEmpty(fitted(draft ?? items), empty);

  const byId = (id: string) => items.find((i) => i.id === id)!;
  const minOf = (i: LayoutItem) => MIN_SIZES[i.widget];

  function start(event: PointerEvent, item: LayoutItem, mode: Drag['mode']) {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
    drag.current = {
      id: item.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      cellW: (box.width + GAP) / columns,
      cellH: ROW_HEIGHT + GAP,
      origin: { id: item.id, x: item.x, y: item.y, w: item.w, h: item.h },
    };
  }

  function move(event: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = Math.round((event.clientX - d.startX) / d.cellW);
    const dy = Math.round((event.clientY - d.startY) / d.cellH);
    const target = d.mode === 'move' ? { x: d.origin.x + dx, y: d.origin.y + dy } : { w: d.origin.w + dx, h: d.origin.h + dy };
    setDraft(place(fitted(items), d.id, target, columns, minOf(byId(d.id))));
  }

  const sizeValue = (i: LayoutItem) => (SIZES.some(([w, h]) => w === i.w && h === i.h) ? `${i.w}x${i.h}` : '');
  function resize(i: LayoutItem, value: string) {
    const [w, h] = value.split('x').map(Number);
    if (w && h) onChange(place(fitted(items), i.id, { w, h }, columns, minOf(i)));
  }

  function end() {
    if (!drag.current) return;
    drag.current = null;
    if (draft) onChange(draft);
    setDraft(null);
  }

  return (
    <div ref={container} class={editing ? 'grid12 editing' : 'grid12'} style={{ '--row': `${ROW_HEIGHT}px`, '--gap': `${GAP}px`, '--cols': columns }}>
      {shown.map((item) => (
        <div
          key={item.id}
          class={drag.current?.id === item.id ? 'cell dragging' : 'cell'}
          style={{ gridColumn: `${item.x + 1} / span ${item.w}`, gridRow: `${item.y + 1} / span ${item.h}` }}
        >
          {editing && (
            <div class="grip" onPointerDown={(e) => start(e, item, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
              {/* The widget below already shows its title, so the bar only says what it does. */}
              <span aria-label={`Mover ${titleOf(item)}`}>⠿ Mover</span>
              <span class="grip-actions">
                <select class="size-pick" aria-label={`Tamanho de ${titleOf(item)}`} value={sizeValue(item)} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => resize(item, e.currentTarget.value)}>
                  {sizeValue(item) === '' && <option value="">{item.w} × {item.h}</option>}
                  {sizeOptions(MIN_SIZES[item.widget], columns).map(([w, h, label]) => (
                    <option key={`${w}x${h}`} value={`${w}x${h}`}>
                      {label}
                    </option>
                  ))}
                </select>
                {item.y > 0 && (
                  <button class="top" onPointerDown={(e) => e.stopPropagation()} onClick={() => onChange(place(fitted(items), item.id, { y: 0 }, columns, minOf(item)))} aria-label={`Enviar ${titleOf(item)} para o topo`}>
                    ↑ Topo
                  </button>
                )}
                <button
                  class="x"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remover ${titleOf(item)}`}
                >
                  ×
                </button>
              </span>
            </div>
          )}
          {!editing && canDrag && <div class="mini-grip" onPointerDown={(e) => start(e, item, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Arraste para mover" aria-label={`Mover ${titleOf(item)}`}>⠿</div>}
          <Collapse.Provider value={reporter(item.id)}>{renderItem(item, { width: item.w * cellWidth - GAP, height: item.h * (ROW_HEIGHT + GAP) - GAP - (editing ? GRIP_HEIGHT : 0) })}</Collapse.Provider>
          {!editing && canDrag && <div class="resize quiet" onPointerDown={(e) => start(e, item, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Arraste para redimensionar" />}
          {editing && <div class="resize" onPointerDown={(e) => start(e, item, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Arraste para redimensionar" />}
        </div>
      ))}
    </div>
  );
}
