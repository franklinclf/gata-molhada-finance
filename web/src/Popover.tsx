import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * A button that opens a floating panel under it, or a sheet from the bottom on a narrow screen (see .pop-panel in styles.css).
 * It closes with Esc (focus goes back to the button), a click outside and the backdrop. The panel is mounted only while open, so
 * what is inside starts fresh each time.
 */
export function Popover({ trigger, label, class: triggerClass = 'chip', align = 'left', tip, children }: { trigger: ComponentChildren; label?: string; class?: string; align?: 'left' | 'right'; tip?: string; children: (close: () => void) => ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

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

  return (
    <div class="pop" ref={root}>
      <button ref={button} type="button" class={triggerClass} aria-label={label} data-tip={tip} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && (
        <>
          <div class="pop-backdrop" onClick={() => close(false)} />
          <div class={`pop-panel ${align}`} role="dialog" aria-label={label}>
            <div class="sheet-handle" aria-hidden="true" />
            {children(close)}
          </div>
        </>
      )}
    </div>
  );
}
