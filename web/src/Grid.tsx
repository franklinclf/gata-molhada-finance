import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LayoutItem } from './api.ts';
import { columnsFor, COLUMNS, place, type Box } from './grid.ts';

export const ROW_HEIGHT = 72;
export const GAP = 14;

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
  /** Use as many columns as the screen holds (about one per 112 px) instead of 12. */
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
  const columns = wide && width > 0 ? columnsFor(width, GAP) : COLUMNS;
  useEffect(() => onColumns?.(columns), [columns]);
  const cellWidth = width > 0 ? (width + GAP) / columns : 0;
  // A widget saved on a wider screen is shown inside the columns there are now.
  const fitted = (list: LayoutItem[]) => list.map((i) => (i.x + i.w > columns ? { ...i, w: Math.min(i.w, columns), x: Math.max(0, Math.min(i.x, columns - Math.min(i.w, columns))) } : i));
  const shown = fitted(draft ?? items);

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
    setDraft(place(fitted(items), d.id, target, columns));
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
            <div class="grip" onPointerDown={(e) => start(e, item, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Arraste para mover">
              <span>{titleOf(item)}</span>
              <button
                class="x"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemove(item.id)}
                aria-label={`Remover ${titleOf(item)}`}
              >
                ×
              </button>
            </div>
          )}
          {!editing && canDrag && <div class="mini-grip" onPointerDown={(e) => start(e, item, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Arraste para mover" aria-label={`Mover ${titleOf(item)}`}>⠿</div>}
          {renderItem(item, { width: item.w * cellWidth - GAP, height: item.h * (ROW_HEIGHT + GAP) - GAP })}
          {!editing && canDrag && <div class="resize quiet" onPointerDown={(e) => start(e, item, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Arraste para redimensionar" />}
          {editing && <div class="resize" onPointerDown={(e) => start(e, item, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Arraste para redimensionar" />}
        </div>
      ))}
    </div>
  );
}
