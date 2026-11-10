import { useEffect, useRef } from 'preact/hooks';
import { useControls } from './layout-controls.ts';
import { hrefFor } from './router.ts';
import { Switch } from './ui.tsx';

/**
 * Dashboard customization inside the menu: "Largura total", the widgets of the environment in use (show or hide, size,
 * order) and "Restaurar padrão". Changes reach the dashboard behind the menu at once and are saved by it.
 * Away from the dashboard it only links there.
 */
export function LayoutPanel({ onDashboard, onClose, focus = true }: { onDashboard: boolean; onClose: () => void; focus?: boolean }) {
  const controls = useControls();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) root.current?.focus({ preventScroll: true });
  }, []);

  if (!onDashboard || !controls) {
    return (
      <div class="layout-panel" ref={root} tabIndex={-1}>
        <a class="navlink" href={hrefFor('')} onClick={onClose}>
          Ir ao dashboard para personalizar
        </a>
      </div>
    );
  }
  return (
    <div class="layout-panel" ref={root} tabIndex={-1}>
      <div class="dash-env" role="status">
        Editando: {controls.deviceName}
      </div>
      {controls.canWiden && <Switch label="Largura total" checked={controls.wide} onChange={controls.setWide} title="Usar toda a largura da tela" />}
      <ul class="layout-list" aria-label="Widgets do painel">
        {controls.rows.map((row) => (
          <li key={row.widget} class={row.id ? 'layout-row' : 'layout-row off'}>
            <label class="layout-show">
              <input type="checkbox" checked={row.id !== null} onChange={() => controls.toggle(row)} aria-label={`Mostrar ${row.title}`} />
              <span class="clip">{row.title}</span>
            </label>
            {row.id && (
              <>
                <select class="size-pick" aria-label={`Tamanho de ${row.title}`} value={row.size} onChange={(e) => controls.setSize(row, e.currentTarget.value)}>
                  {row.size === '' && <option value="">Personalizado</option>}
                  {row.sizes.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <button class="icon" disabled={!row.canUp} onClick={() => controls.shift(row, -1)} aria-label={`Subir ${row.title}`}>
                  ↑
                </button>
                <button class="icon" disabled={!row.canDown} onClick={() => controls.shift(row, 1)} aria-label={`Descer ${row.title}`}>
                  ↓
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div class="layout-actions">
        {controls.spread && (
          <button class="icon" onClick={controls.spread} title="Reparte os widgets pelas colunas da tela">
            Distribuir na largura
          </button>
        )}
        <button class="icon" onClick={controls.restore} title={`Volta o painel do ${controls.deviceName} ao padrão dele; o do outro ambiente não muda`}>
          Restaurar padrão do {controls.deviceName}
        </button>
      </div>
    </div>
  );
}
