import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { placePanel } from './placement.ts';

/** Same breakpoint as the narrow-screen rules in styles.css. */
const NARROW = '(max-width: 760px)';

/**
 * A button that opens a floating panel. The panel is placed next to the button, kept inside the viewport and flipped above it
 * when there is no room below. On a narrow screen a dialog turns into a sheet from the bottom; a `menu` stays a small panel
 * anchored to its button at every size. It closes with Esc (focus goes back to the button) and a click outside. The panel is
 * mounted only while open, so what is inside starts fresh each time.
 */
export function Popover({ trigger, label, class: triggerClass = 'chip', align = 'left', tip, menu = false, children }: { trigger: ComponentChildren; label?: string; class?: string; align?: 'left' | 'right'; tip?: string; /** A short list of choices: anchored at every size, with arrow keys. */ menu?: boolean; children: (close: () => void) => ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [style, setStyle] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const sheet = narrow && !menu;
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  // Measured before the first paint, and again when the screen or the content changes size, so the panel never shows in the wrong place.
  useLayoutEffect(() => {
    if (!open || sheet) return setStyle(null);
    const place = () => {
      if (!panel.current || !button.current) return;
      const box = panel.current.getBoundingClientRect();
      // The panel is measured without its own height cap, then the cap is the room that is left.
      const full = { width: box.width, height: panel.current.scrollHeight + (box.height - panel.current.clientHeight) };
      const next = placePanel(button.current.getBoundingClientRect(), full, { width: document.documentElement.clientWidth, height: window.innerHeight }, align);
      setStyle((was) => (was && was.left === next.left && was.top === next.top && was.maxHeight === next.maxHeight ? was : { left: next.left, top: next.top, maxHeight: next.maxHeight }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const watcher = new ResizeObserver(place);
    if (panel.current) watcher.observe(panel.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      watcher.disconnect();
    };
  }, [open, sheet, align]);

  // A menu puts the focus on its current choice (or the first one), so the arrows work at once.
  useEffect(() => {
    if (!open || !menu) return;
    const items = panel.current?.querySelectorAll<HTMLElement>('[role^=menuitem]');
    (panel.current?.querySelector<HTMLElement>('[aria-checked=true]') ?? items?.[0])?.focus();
  }, [open, menu]);

  const onMenuKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!menu || step === 0) return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role^=menuitem]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    items[(at + step + items.length) % items.length]?.focus();
  };

  return (
    <div class="pop" ref={root}>
      <button ref={button} type="button" class={triggerClass} aria-label={label} data-tip={tip} aria-haspopup={menu ? 'menu' : 'dialog'} aria-expanded={open} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && (
        <>
          {sheet && <div class="pop-backdrop" onClick={() => close(false)} />}
          <div
            ref={panel}
            class={`pop-panel ${sheet ? 'sheet' : 'anchored'}${menu ? ' pop-menu' : ''}`}
            role={menu ? undefined : 'dialog'}
            aria-label={menu ? undefined : label}
            style={sheet ? undefined : style ? { left: `${style.left}px`, top: `${style.top}px`, maxHeight: `${style.maxHeight}px` } : { left: '0px', top: '0px', visibility: 'hidden' }}
            onKeyDown={onMenuKey}
          >
            {sheet && <div class="sheet-handle" aria-hidden="true" />}
            {children(close)}
          </div>
        </>
      )}
    </div>
  );
}
