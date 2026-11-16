import { useEffect, useRef, useState } from 'preact/hooks';
import { centsToPosition, clampHandles, positionToCents, STEPS } from './amount-slider.ts';
import { brl } from './format.ts';

/**
 * Two handles over the amounts of the result (absolute cents), on a logarithmic scale so small values stay reachable. Built on two
 * native range inputs laid over each other, which gives arrow keys, Home/End and touch dragging for free. A handle at its end means
 * "no bound", so the param is dropped instead of written.
 */
export function AmountSlider({ range, min, max, hidden, onCommit }: { range: { min: number; max: number }; min: number | null; max: number | null; hidden: boolean; onCommit: (bounds: { min: number | null; max: number | null }) => void }) {
  const fromUrl = (): [number, number] => [min === null ? 0 : centsToPosition(min, range.min, range.max), max === null ? STEPS : centsToPosition(max, range.min, range.max)];
  const [pos, setPos] = useState<[number, number]>(fromUrl);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragging = useRef(false);
  const cents = (p: [number, number]) => ({ min: p[0] <= 0 ? null : positionToCents(p[0], range.min, range.max), max: p[1] >= STEPS ? null : positionToCents(p[1], range.min, range.max) });

  // A change from outside (a chip removed, a link, "Limpar") moves the handles; the echo of a drag does not.
  useEffect(() => {
    if (dragging.current) return;
    const now = cents(pos);
    if (now.min !== min || now.max !== max) setPos(fromUrl());
  }, [min, max, range.min, range.max]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const move = (which: 'low' | 'high', value: number) => {
    dragging.current = true;
    const next = clampHandles(which === 'low' ? value : pos[0], which === 'high' ? value : pos[1], which);
    setPos(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dragging.current = false;
      onCommit(cents(next));
    }, 350);
  };

  if (range.max <= range.min) return <div class="muted">Sem valores para ajustar neste filtro.</div>;
  const [lo, hi] = pos;
  const shown = cents(pos);
  const text = (c: number | null, fallback: number) => brl(c ?? fallback, hidden);
  return (
    <div class="amount-slider">
      <div class="amount-values" aria-live="polite">
        <strong>{text(shown.min, range.min)}</strong>
        <span class="muted">até</span>
        <strong>{text(shown.max, range.max)}</strong>
      </div>
      <div class="dual">
        <div class="dual-track" />
        <div class="dual-fill" style={{ left: `${lo / 10}%`, right: `${100 - hi / 10}%` }} />
        {/* The lower handle goes on top when both sit near the top end, or it could not be dragged back. */}
        <input type="range" aria-label="Valor mínimo" min={0} max={STEPS} step={5} value={lo} style={{ zIndex: lo > STEPS * 0.9 ? 3 : 2 }} onInput={(e) => move('low', Number((e.currentTarget as HTMLInputElement).value))} aria-valuetext={text(shown.min, range.min)} />
        <input type="range" aria-label="Valor máximo" min={0} max={STEPS} step={5} value={hi} style={{ zIndex: 2 }} onInput={(e) => move('high', Number((e.currentTarget as HTMLInputElement).value))} aria-valuetext={text(shown.max, range.max)} />
      </div>
      <div class="amount-ends muted">
        <span>{brl(range.min, hidden)}</span>
        <span>{brl(range.max, hidden)}</span>
      </div>
    </div>
  );
}
