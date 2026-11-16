import { ariaChecked, nextCheck } from './checkbox.ts';
import type { CheckState } from './inst-tree.ts';

/**
 * The app's own checkbox: a button with role=checkbox, so Space works and a screen reader hears checked, unchecked or mixed.
 * `state` is `some` for a box that stands for a partly chosen group. Styled in styles.css (.cbx), with a visible focus ring.
 */
export function Checkbox({ state, onChange, label, class: className, disabled = false }: { state: CheckState | boolean; onChange: (next: boolean) => void; label?: string; class?: string; disabled?: boolean }) {
  const resolved: CheckState = state === true ? 'on' : state === false ? 'off' : state;
  return (
    <button
      type="button"
      role="checkbox"
      class={className ? `cbx ${className}` : 'cbx'}
      aria-checked={ariaChecked(resolved)}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        // A click on the box is its own: a row or label around it must not act on it as well.
        e.stopPropagation();
        onChange(nextCheck(resolved));
      }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        {resolved === 'some' ? <path d="M4 8h8" /> : <path d="M3.5 8.5l3 3 6-7" />}
      </svg>
    </button>
  );
}
