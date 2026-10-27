import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_SIZES, defaultLayout, WIDGET_IDS } from '../../src/api/layout.ts';
import { api } from './api.ts';
import type { LayoutItem, WidgetId } from './api.ts';
import { freeSlot, sizeClass } from './grid.ts';
import { Grid } from './Grid.tsx';
import { useLoad } from './hooks.ts';
import { Loading } from './ui.tsx';
import { WIDGETS } from './widgets/index.ts';

function useNarrow(): boolean {
  const query = '(max-width: 760px)';
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function Dashboard({ hidden, now }: { hidden: boolean; now: Date }) {
  const saved = useLoad(() => api.layout(), []);
  const [items, setItems] = useState<LayoutItem[] | null>(null);
  const [editing, setEditing] = useState(false);
  const narrow = useNarrow();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (saved.data) setItems(saved.data.items);
  }, [saved.data]);

  function update(next: LayoutItem[]) {
    setItems(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void api.saveLayout({ version: 2, items: next }).catch(() => {}), 500);
  }

  if (!items) return <Loading error={saved.error} />;

  function add(widget: WidgetId) {
    const { w, h } = DEFAULT_SIZES[widget];
    const slot = freeSlot(items!, w, h);
    const id = `${widget}-${Date.now().toString(36)}`;
    update([...items!, { id, widget, ...slot, w, h }]);
  }

  const ordered = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const render = (item: LayoutItem) => {
    const { component: Component } = WIDGETS[item.widget];
    return (
      <Component
        item={item}
        now={now}
        hidden={hidden}
        size={narrow ? 'md' : sizeClass(item.w, item.h)}
        config={item.config ?? {}}
        setConfig={(patch) => update(items.map((i) => (i.id === item.id ? { ...i, config: { ...(i.config ?? {}), ...patch } } : i)))}
      />
    );
  };

  return (
    <>
      <div class="toolbar">
        {!narrow && (
          <button class="icon" onClick={() => setEditing(!editing)} aria-pressed={editing}>
            {editing ? 'Concluir' : 'Personalizar painel'}
          </button>
        )}
        {editing && !narrow && (
          <>
            <select class="select" value="" onChange={(e) => { const value = (e.currentTarget as HTMLSelectElement).value as WidgetId; if (value) add(value); }} aria-label="Adicionar widget">
              <option value="">+ Adicionar widget</option>
              {WIDGET_IDS.map((id) => (
                <option key={id} value={id}>
                  {WIDGETS[id].title}
                </option>
              ))}
            </select>
            <button class="icon" onClick={() => update(defaultLayout().items)}>
              Restaurar padrão
            </button>
          </>
        )}
      </div>
      {narrow ? (
        <div class="stack">
          {ordered.map((item) => (
            <div class="stack-cell" key={item.id}>
              {render(item)}
            </div>
          ))}
        </div>
      ) : (
        <Grid items={items} editing={editing} onChange={update} renderItem={render} onRemove={(id) => update(items.filter((i) => i.id !== id))} titleOf={(i) => WIDGETS[i.widget].title} />
      )}
      {items.length === 0 && <div class="empty page">O painel está vazio. Use “Personalizar painel” para adicionar widgets.</div>}
    </>
  );
}
