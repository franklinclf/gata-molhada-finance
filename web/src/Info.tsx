import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { placeTip } from './tooltip.ts';

/**
 * A short text, or a small "i" when there is none, that holds a longer explanation, so a narrow table cell or a line keeps only what
 * matters and the rest is one gesture away. The explanation opens on hover, on keyboard focus and on a tap (touch screens have no
 * hover), and closes with Esc, a tap elsewhere or a scroll. It is the button's description (aria-describedby), so a screen reader
 * reads it with the short text. It floats over the page, so a table that scrolls sideways does not cut it.
 *
 * Use it for the explanation of a value; an action (a button) stays outside, in plain sight.
 */
export function Info({ tip, children, label = 'Explicação' }: { tip: string; children?: ComponentChildren; /** Name of the "i" button for a screen reader, when there is no short text. */ label?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // A tap or a click keeps it open after the pointer leaves; hover alone does not.
  const [pinned, setPinned] = useState(false);
  const hide = () => {
    setOpen(false);
    setPinned(false);
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (!open || !el || !trigger.current) return;
    const at = placeTip(trigger.current.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
  }, [open, tip]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !box.current?.contains(target)) hide();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={children === undefined ? 'info-btn info-icon' : 'info-btn info-text'}
        aria-label={children === undefined ? label : undefined}
        aria-describedby={id}
        onPointerEnter={(e) => e.pointerType === 'mouse' && setOpen(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && !pinned && setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={hide}
        onClick={(e) => {
          // Inside a clickable row, opening the explanation does not also act on the row.
          e.stopPropagation();
          if (pinned) hide();
          else {
            setPinned(true);
            setOpen(true);
          }
        }}
      >
        {children ?? <span aria-hidden="true">i</span>}
      </button>
      {/* Always in the page, also when closed, so the description is there when the button gets focus. */}
      {createPortal(
        <div ref={box} id={id} role="tooltip" class={open ? 'info-tip on' : 'info-tip'}>
          {tip}
        </div>,
        document.body,
      )}
    </>
  );
}
