import { useEffect, useState } from 'preact/hooks';
import { api } from './api.ts';
import type { Layout } from './api.ts';
import { useLoad } from './hooks.ts';
import { moveWidget, toggleWidget } from './layout.ts';
import { WIDGETS } from './widgets/index.ts';

export function Dashboard({ hidden, onToggleHidden, onLogout }: { hidden: boolean; onToggleHidden: () => void; onLogout: () => void }) {
  const saved = useLoad(() => api.layout(), []);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (saved.data) setLayout(saved.data);
  }, [saved.data]);

  // Keeps the "há N min" labels current.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  function change(next: Layout) {
    setLayout(next);
    void api.saveLayout(next).catch(() => {});
  }

  if (!layout) return <div class="empty page">{saved.error ?? 'Carregando…'}</div>;

  return (
    <>
      <header class="topbar">
        <h1>Gata Molhada</h1>
        <div class="topbar-actions">
          <button class="icon" onClick={onToggleHidden} aria-pressed={hidden} title={hidden ? 'Mostrar valores' : 'Ocultar valores'}>
            {hidden ? 'Mostrar valores' : 'Ocultar valores'}
          </button>
          <button class="icon" onClick={() => setEditing(!editing)} aria-pressed={editing}>
            {editing ? 'Concluir' : 'Personalizar'}
          </button>
          <button class="icon" onClick={onLogout}>Sair</button>
        </div>
      </header>
      <main class="grid">
        {layout.widgets
          .filter((slot) => editing || !slot.hidden)
          .map((slot) => {
            const { component: Component, title } = WIDGETS[slot.id];
            return (
              <div class={slot.hidden ? 'cell off' : 'cell'} key={slot.id}>
                {editing && (
                  <div class="editbar">
                    <span>{title}</span>
                    <span>
                      <button onClick={() => change(moveWidget(layout, slot.id, -1))} aria-label="Mover para cima">↑</button>
                      <button onClick={() => change(moveWidget(layout, slot.id, 1))} aria-label="Mover para baixo">↓</button>
                      <button onClick={() => change(toggleWidget(layout, slot.id))}>{slot.hidden ? 'Mostrar' : 'Ocultar'}</button>
                    </span>
                  </div>
                )}
                {!slot.hidden && <Component now={now} hidden={hidden} />}
              </div>
            );
          })}
      </main>
    </>
  );
}
