import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_SIZES, defaultLayout, WIDGET_IDS } from '../../src/api/layout.ts';
import { api } from './api.ts';
import type { LayoutItem, WidgetId } from './api.ts';
import { freeSlot, reflow, sizeClassPx } from './grid.ts';
import { Grid } from './Grid.tsx';
import { useLoad, useStoredFlag } from './hooks.ts';
import { setTopbarTools } from './topbar.ts';
import { Loading } from './ui.tsx';
import { Select } from './Select.tsx';
import { WIDGETS } from './widgets/index.ts';

function useNarrow(): boolean {
  const query = '(max-width: 900px)';
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
  const [columns, setColumns] = useState(12);
  const [wide, setWide] = useStoredFlag('gmf-wide', true);
  // The dashboard may use the whole width of the screen, not only the centered column the other pages use.
  useEffect(() => {
    document.body.classList.toggle('wide', wide);
    return () => document.body.classList.remove('wide');
  }, [wide]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (saved.data) setItems(saved.data.items);
  }, [saved.data]);

  function update(next: LayoutItem[]) {
    setItems(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void api.saveLayout({ version: 2, items: next }).catch(() => {}), 500);
  }

  // The controls live in the top bar.
  const toolsRef = useRef<ComponentChildren>(null);
  // Only when something the controls show changes: handing them over after every render would re-render the app, and so this page, forever.
  useEffect(() => {
    setTopbarTools(toolsRef.current);
  }, [editing, wide, columns, items, narrow]);
  useEffect(() => () => setTopbarTools(null), []);

  if (!items) return <Loading error={saved.error} />;

  function add(widget: WidgetId) {
    const { w, h } = DEFAULT_SIZES[widget];
    const slot = freeSlot(items!, w, h, columns);
    const id = `${widget}-${Date.now().toString(36)}`;
    update([...items!, { id, widget, ...slot, w, h }]);
  }

  const ordered = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const render = (item: LayoutItem, pixels?: { width: number; height: number }) => {
    const { component: Component } = WIDGETS[item.widget];
    return (
      <Component
        item={item}
        now={now}
        hidden={hidden}
        size={narrow || !pixels ? 'md' : sizeClassPx(pixels.width, pixels.height)}
        config={item.config ?? {}}
        setConfig={(patch) => update(items.map((i) => (i.id === item.id ? { ...i, config: { ...(i.config ?? {}), ...patch } } : i)))}
      />
    );
  };

  const tools = (
    <>
        {!narrow && (
          <button class="icon" onClick={() => setEditing(!editing)} aria-pressed={editing}>
            {editing ? 'Concluir' : 'Personalizar painel'}
          </button>
        )}
        {!narrow && (
          <button class="icon" onClick={() => setWide(!wide)} aria-pressed={wide} title="Usar toda a largura da tela">
            {wide ? 'Largura total' : 'Largura normal'}
          </button>
        )}
        {editing && !narrow && (
          <>
            <Select ariaLabel="Adicionar widget" value="" placeholder="+ Adicionar widget" onChange={(value) => value && add(value as WidgetId)} options={WIDGET_IDS.filter((id) => !items.some((i) => i.widget === id)).map((id) => ({ value: id, label: WIDGETS[id].title }))} />
            {columns > 12 && (
              <button class="icon" onClick={() => update(reflow(items, columns))} title="Reparte os widgets pelas colunas da tela">
                Distribuir na largura
              </button>
            )}
            <button class="icon" onClick={() => update(defaultLayout().items)}>
              Restaurar padrão
            </button>
          </>
        )}
    </>
  );
  toolsRef.current = tools;

  return (
    <>
      {narrow ? (
        <div class="stack">
          {ordered.map((item) => (
            <div class="stack-cell" key={item.id}>
              {render(item)}
            </div>
          ))}
        </div>
      ) : (
        <Grid items={items} editing={editing} canDrag={!narrow} wide={wide} onColumns={setColumns} onChange={update} renderItem={render} onRemove={(id) => update(items.filter((i) => i.id !== id))} titleOf={(i) => WIDGETS[i.widget].title} />
      )}
      {items.length === 0 && <div class="empty page">O painel está vazio. Use “Personalizar painel” para adicionar widgets.</div>}
    </>
  );
}
