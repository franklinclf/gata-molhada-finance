import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_SIZES, defaultLayout, MOBILE_BREAKPOINT, MOBILE_SIZES, WIDGET_IDS } from '../../src/api/layout.ts';
import type { Device } from '../../src/api/layout.ts';
import { api } from './api.ts';
import type { LayoutItem, WidgetId } from './api.ts';
import { compact, fitToColumns, freeSlot, isTinyPx, packStack, reflow, shiftInStack, sizeClassPx, type Pixels } from './grid.ts';
import { Grid } from './Grid.tsx';
import { useLoad, useStoredFlag } from './hooks.ts';
import { Loading, Switch } from './ui.tsx';
import { FixedHeight, WidgetSize, WidgetTiny } from './Widget.tsx';
import { Select } from './Select.tsx';
import { WIDGETS } from './widgets/index.ts';

/** The phone layout is for viewports narrower than MOBILE_BREAKPOINT (700 px), the same limit the server-side defaults are built for. */
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 0.02}px)`;

/** The environment this window uses, which decides the layout that is shown and edited. */
export function useDevice(): Device {
  const [mobile, setMobile] = useState(() => matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const media = matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return mobile ? 'mobile' : 'desktop';
}

const DEVICE_NAME: Record<Device, string> = { desktop: 'computador', mobile: 'celular' };

/** The size choices of a phone widget: half the width or all of it, compact (figure and one line) or complete. */
const MOBILE_CHOICES: Array<[string, string]> = [
  ['half', 'Metade, compacto'],
  ['compact', 'Compacto'],
  ['full', 'Completo'],
];
const mobileChoice = (i: LayoutItem) => (i.w === 1 ? 'half' : i.h <= 2 ? 'compact' : 'full');

export function Dashboard({ hidden, now, editing, setEditing }: { hidden: boolean; now: Date; editing: boolean; setEditing: (on: boolean) => void }) {
  const device = useDevice();
  const narrow = device === 'mobile';
  const saved = useLoad(async () => ({ device, layout: await api.layout(device) }), [device]);
  const [items, setItems] = useState<LayoutItem[] | null>(null);
  const [columns, setColumns] = useState(12);
  const [wide, setWide] = useStoredFlag('gmf-wide', true);
  // The dashboard may use the whole width of the screen, not only the centered column the other pages use.
  useEffect(() => {
    document.body.classList.toggle('wide', wide);
    return () => document.body.classList.remove('wide');
  }, [wide]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Each environment has its own layout: the one on screen is dropped while the other loads.
  useEffect(() => setItems(null), [device]);
  // A reload after any change must not put back an older layout while a move waits to be saved.
  useEffect(() => {
    if (saved.data && saved.data.device === device && !timer.current) setItems(saved.data.layout.items);
  }, [saved.data, device]);

  function update(next: LayoutItem[]) {
    setItems(next);
    if (timer.current) clearTimeout(timer.current);
    const target = device;
    timer.current = setTimeout(() => {
      timer.current = null;
      void api.saveLayout({ version: 2, items: next }, target).catch(() => {});
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
    const id = `${widget}-${Date.now().toString(36)}`;
    if (narrow) {
      const { w, h } = MOBILE_SIZES[widget];
      // Last in the stack: packing puts it after the others.
      update(packStack([...items!, { id, widget, x: 0, y: 100_000, w, h }]));
      return;
    }
    const { w, h } = DEFAULT_SIZES[widget];
    // The place is searched among the widgets as they are shown now, so the new one never lands on another.
    const slot = freeSlot(fitToColumns(items!, columns), w, h, columns);
    update([...items!, { id, widget, ...slot, w, h }]);
  }

  const ordered = narrow ? [...packStack(items)].sort((a, b) => a.y - b.y || a.x - b.x) : items;
  const render = (item: LayoutItem, pixels?: Pixels) => {
    const { component: Component } = WIDGETS[item.widget];
    // On the phone the saved height says how much to show; on the desktop the room on screen does.
    const size = narrow ? (item.w === 1 || item.h <= 2 ? 'sm' : 'md') : !pixels ? 'md' : sizeClassPx(pixels.width, pixels.height);
    const tiny = !narrow && pixels !== undefined && isTinyPx(pixels.height);
    return (
      <WidgetSize.Provider value={tiny ? 'sm' : size}>
        <WidgetTiny.Provider value={tiny}>
          <Component
            item={item}
            now={now}
            hidden={hidden}
            pixels={narrow ? undefined : pixels}
            size={tiny ? 'sm' : size}
            config={item.config ?? {}}
            setConfig={(patch) => update(items.map((i) => (i.id === item.id ? { ...i, config: { ...(i.config ?? {}), ...patch } } : i)))}
          />
        </WidgetTiny.Provider>
      </WidgetSize.Provider>
    );
  };

  function remove(id: string) {
    const gone = items!.find((i) => i.id === id);
    if (!gone) return;
    setRemoved({ title: WIDGETS[gone.widget].title, items: items! });
    const rest = items!.filter((i) => i.id !== id);
    // The ones below move up into the hole.
    update(narrow ? packStack(rest) : compact(fitToColumns(items!, columns).filter((i) => i.id !== id)));
  }
  function chooseMobileSize(item: LayoutItem, choice: string) {
    const full = Math.max(MOBILE_SIZES[item.widget].h, 3);
    const next = choice === 'half' ? { w: 1, h: 2 } : choice === 'compact' ? { w: 2, h: 2 } : { w: 2, h: full };
    update(packStack(items!.map((i) => (i.id === item.id ? { ...i, ...next } : i))));
  }
  const missing = WIDGET_IDS.filter((id) => !items.some((i) => i.widget === id));

  // The controls sit in a row above the panel, so the top menu is the same on every page. "Personalizar painel" opens from the main menu.
  const tools = (
    <div class="dash-tools">
      {editing && (
        <>
          <span class="dash-env" role="status">
            Editando: {DEVICE_NAME[device]}
          </span>
          <Select ariaLabel="Adicionar widget" value="" placeholder={missing.length === 0 ? 'Todos os widgets já estão no painel' : '+ Adicionar widget'} disabled={missing.length === 0} onChange={(value) => value && add(value as WidgetId)} options={missing.map((id) => ({ value: id, label: WIDGETS[id].title }))} />
          {!narrow && columns > 12 && (
            <button class="icon" onClick={() => update(reflow(items, columns))} title="Reparte os widgets pelas colunas da tela">
              Distribuir na largura
            </button>
          )}
          <button class="icon" onClick={() => update(defaultLayout(device).items)} title={`Volta o painel do ${DEVICE_NAME[device]} ao padrão dele; o do outro ambiente não muda`}>
            Restaurar padrão do {DEVICE_NAME[device]}
          </button>
        </>
      )}
      {!narrow && <Switch label="Largura total" checked={wide} onChange={setWide} title="Usar toda a largura da tela" />}
      {editing && (
        <button class="icon" onClick={() => setEditing(false)}>
          Concluir
        </button>
      )}
    </div>
  );

  return (
    <>
      {(!narrow || editing) && tools}
      {narrow ? (
        <FixedHeight.Provider value={false}>
          <div class={editing ? 'stack editing' : 'stack'}>
            {ordered.map((item, n) => (
              <div class={`stack-cell${item.w === 1 ? ' half' : ''}${item.h <= 2 ? ' compact' : ''}`} key={item.id}>
                {editing && (
                  <div class="stack-bar">
                    <span class="grow clip">{WIDGETS[item.widget].title}</span>
                    <select class="size-pick" aria-label={`Tamanho de ${WIDGETS[item.widget].title}`} value={mobileChoice(item)} onChange={(e) => chooseMobileSize(item, e.currentTarget.value)}>
                      {MOBILE_CHOICES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button class="icon" disabled={n === 0} onClick={() => update(shiftInStack(items, item.id, -1))} aria-label={`Subir ${WIDGETS[item.widget].title}`}>
                      ↑
                    </button>
                    <button class="icon" disabled={n === ordered.length - 1} onClick={() => update(shiftInStack(items, item.id, 1))} aria-label={`Descer ${WIDGETS[item.widget].title}`}>
                      ↓
                    </button>
                    <button class="icon x" onClick={() => remove(item.id)} aria-label={`Remover ${WIDGETS[item.widget].title}`}>
                      ×
                    </button>
                  </div>
                )}
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
      {items.length === 0 && <div class="empty page">O painel está vazio. Use “Personalizar painel” no menu para adicionar widgets.</div>}
    </>
  );
}
