import { useState } from 'preact/hooks';

/** A small clipboard button next to a value worth copying. Text selection is off in the app, so this is how you copy. */
export function CopyButton({ value, label = 'Copiar' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  async function copy(event: Event) {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Older browsers: fall back to a temporary field.
      const field = document.createElement('textarea');
      field.value = value;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  }
  return (
    <button class={done ? 'copy done' : 'copy'} onClick={(e) => void copy(e)} aria-label={done ? 'Copiado' : label} data-tip={done ? 'Copiado' : label} data-no-nav>
      {done ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2.5" />
          <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />
        </svg>
      )}
    </button>
  );
}
