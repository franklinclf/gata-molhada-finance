import { FIRST_YEAR, MONTH_SHORT, monthKey } from './month-range.ts';

export interface Cell {
  /** `full` and `part` draw the month as inside the choice; `part` is lighter (a day range that cuts the month). */
  state: 'none' | 'part' | 'full';
  /** The first month of a range that waits for the second click. */
  anchor?: boolean;
  disabled?: boolean;
  dim?: boolean;
}

const MONTH_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/**
 * Twelve months of a year (4 x 3) with arrows to change the year, shared by the date range and the card bill pickers.
 * The year label is a button too: `onYear` lets a picker use it (the date one selects the whole year).
 */
export function MonthGrid({ year, onNavigate, maxYear, cell, onPick, onYear, yearOn }: { year: number; onNavigate: (year: number) => void; maxYear: number; cell: (key: string) => Cell; onPick: (key: string) => void; onYear?: () => void; yearOn?: boolean }) {
  return (
    <div class="mgrid">
      <div class="mgrid-head">
        <button type="button" class="chip" aria-label="Ano anterior" disabled={year <= FIRST_YEAR} onClick={() => onNavigate(year - 1)}>
          ‹
        </button>
        {onYear ? (
          <button type="button" class={yearOn ? 'chip on mgrid-year' : 'chip mgrid-year'} data-tip="Selecionar o ano inteiro" onClick={onYear}>
            {year}
          </button>
        ) : (
          <span class="mgrid-year">{year}</span>
        )}
        <button type="button" class="chip" aria-label="Próximo ano" disabled={year >= maxYear} onClick={() => onNavigate(year + 1)}>
          ›
        </button>
      </div>
      <div
        class="mgrid-cells"
        role="group"
        aria-label={`Meses de ${year}`}
        onKeyDown={(e) => {
          // Arrows walk the grid (4 columns), so a keyboard user does not tab through twelve buttons.
          const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 }[e.key];
          if (step === undefined) return;
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = buttons[at + step];
          if (at >= 0 && next) {
            e.preventDefault();
            next.focus();
          }
        }}
      >
        {MONTH_SHORT.map((name, i) => {
          const key = monthKey(year, i + 1);
          const c = cell(key);
          const cls = ['mcell', c.state === 'full' ? 'on' : c.state === 'part' ? 'part' : '', c.anchor ? 'anchor' : '', c.dim ? 'dim' : ''].filter(Boolean).join(' ');
          return (
            <button key={key} type="button" class={cls} disabled={c.disabled} aria-pressed={c.state === 'full'} aria-label={`${MONTH_LONG[i]} de ${year}`} onClick={() => onPick(key)}>
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
