import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_SIZES, defaultLayout, WIDGET_IDS } from '../../src/api/layout.ts';
import { api } from './api.ts';
import type { LayoutItem, WidgetId } from './api.ts';
import { compact, fitToColumns, freeSlot, reflow, sizeClassPx, type Pixels } from './grid.ts';
import { Grid } from './Grid.tsx';
import { useLoad, useStoredFlag } from './hooks.ts';
import { Loading } from './ui.tsx';
import { FixedHeight, WidgetSize } from './Widget.tsx';
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

  // A reload after any change must not put back an older layout while a move waits to be saved.
  useEffect(() => {
    if (saved.data && !timer.current) setItems(saved.data.items);
  }, [saved.data]);

  function update(next: LayoutItem[]) {
    setItems(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void api.saveLayout({ version: 2, items: next }).catch(() => {});
    }, 500);
  }

  // A removed widget can be put back for a few seconds.
  const [removed, setRemoved] = useState<{ title: string; items: LayoutItem[] } | null>(null);
  useEffect(() => {
    if (!removed) return;
    const gone = setTimeout(() => setRemoved(null), 10_000);
    return () => clearTimeout(gone);
  }, [removed]);

  if (!items) return <Loading error={saved.error} />;

  function add(widget: WidgetId) {
    const { w, h } = DEFAULT_SIZES[widget];
    // The place is searched among the widgets as they are shown now, so the new one never lands on another.
    const slot = freeSlot(fitToColumns(items!, columns), w, h, columns);
    const id = `${widget}-${Date.now().toString(36)}`;
    update([...items!, { id, widget, ...slot, w, h }]);
  }

  // On a phone the widgets are one column in layout order; the balance goes first so the daily check does not start with a scroll past the bills.
  const ordered = [...items].sort((a, b) => (narrow ? Number(b.widget === 'balances') - Number(a.widget === 'balances') : 0) || a.y - b.y || a.x - b.x);
  const render = (item: LayoutItem, pixels?: Pixels) => {
    const { component: Component } = WIDGETS[item.widget];
    const size = narrow || !pixels ? 'md' : sizeClassPx(pixels.width, pixels.height);
    return (
      <WidgetSize.Provider value={size}>
        <Component
          item={item}
          now={now}
          hidden={hidden}
          pixels={narrow ? undefined : pixels}
          size={size}
          config={item.config ?? {}}
          setConfig={(patch) => update(items.map((i) => (i.id === item.id ? { ...i, config: { ...(i.config ?? {}), ...patch } } : i)))}
        />
      </WidgetSize.Provider>
    );
  };

  function remove(id: string) {
    const gone = items!.find((i) => i.id === id);
    if (!gone) return;
    setRemoved({ title: WIDGETS[gone.widget].title, items: items! });
    // The ones below move up into the hole.
    update(compact(fitToColumns(items!, columns).filter((i) => i.id !== id)));
  }
  const missing = WIDGET_IDS.filter((id) => !items.some((i) => i.widget === id));

  // The controls sit in a row above the panel, so the top menu is the same on every page.
  const tools = narrow ? null : (
    <div class="dash-tools">
      {editing && (
        <>
          <Select ariaLabel="Adicionar widget" value="" placeholder={missing.length === 0 ? 'Todos os widgets já estão no painel' : '+ Adicionar widget'} disabled={missing.length === 0} onChange={(value) => value && add(value as WidgetId)} options={missing.map((id) => ({ value: id, label: WIDGETS[id].title }))} />
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
      <button class="icon" onClick={() => setWide(!wide)} aria-pressed={wide} title="Usar toda a largura da tela">
        {wide ? 'Largura total' : 'Largura normal'}
      </button>
      <button class="icon" onClick={() => setEditing(!editing)} aria-pressed={editing}>
        {editing ? 'Concluir' : 'Personalizar painel'}
      </button>
    </div>
  );

  return (
    <>
      {tools}
      {narrow ? (
        <FixedHeight.Provider value={false}>
          <div class="stack">
            {ordered.map((item) => (
              <div class="stack-cell" key={item.id}>
                {render(item)}
              </div>
            ))}
          </div>
        </FixedHeight.Provider>
      ) : (
        <Grid items={items} editing={editing} canDrag={!narrow} wide={wide} onColumns={setColumns} onChange={update} renderItem={render} onRemove={remove} titleOf={(i) => WIDGETS[i.widget].title} />
      )}
      {removed && (
        <div class="dash-undo" role="status">
          {removed.title} saiu do painel.
          <button
            class="icon"
            onClick={() => {
              update(removed.items);
              setRemoved(null);
            }}
          >
            Desfazer
          </button>
        </div>
      )}
      {items.length === 0 && <div class="empty page">O painel está vazio. Use “Personalizar painel” para adicionar widgets.</div>}
    </>
  );
}
