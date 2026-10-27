import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { LayoutItem } from './api.ts';
import { COLUMNS, place, type Box } from './grid.ts';

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
  onChange: (items: LayoutItem[]) => void;
  renderItem: (item: LayoutItem) => ComponentChildren;
  onRemove: (id: string) => void;
  titleOf: (item: LayoutItem) => string;
}

/**
 * Dashboard grid. While editing, a widget moves by its top bar and resizes by its corner; neighbours make room.
 * The draft is kept in state during the gesture and saved when the pointer is released.
 */
export function Grid({ items, editing, onChange, renderItem, onRemove, titleOf }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<LayoutItem[] | null>(null);
  const drag = useRef<Drag | null>(null);
  const shown = draft ?? items;

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
      cellW: (box.width + GAP) / COLUMNS,
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
    setDraft(place(items, d.id, target));
  }

  function end() {
    if (!drag.current) return;
    drag.current = null;
    if (draft) onChange(draft);
    setDraft(null);
  }

  return (
    <div ref={container} class={editing ? 'grid12 editing' : 'grid12'} style={{ '--row': `${ROW_HEIGHT}px`, '--gap': `${GAP}px` }}>
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
          {renderItem(item)}
          {editing && <div class="resize" onPointerDown={(e) => start(e, item, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Arraste para redimensionar" />}
        </div>
      ))}
    </div>
  );
}
