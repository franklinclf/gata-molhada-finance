/** Smallest font size (px) a figure shrinks to before it is allowed to be cut. */
export const MIN_FIT_FONT = 9;

/** The font size at which text that is `contentWidth` wide at `fontPx` fits `boxWidth`. Text that already fits keeps its size; the result never goes below `min`. */
export function fitFontSize(fontPx: number, contentWidth: number, boxWidth: number, min = MIN_FIT_FONT): number {
  if (contentWidth <= boxWidth || contentWidth <= 0 || boxWidth <= 0) return fontPx;
  return Math.max(min, Math.floor(((fontPx * boxWidth) / contentWidth) * 10) / 10);
}

/** Shrinks each key figure (`.big`) under `root` until it shows whole. The size set by the stylesheet is the starting point, so a wider widget grows the figure back. */
export function fitBigFigures(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('.big')) {
    el.style.fontSize = '';
    const box = el.clientWidth;
    const content = el.scrollWidth;
    if (content <= box) continue;
    const size = fitFontSize(parseFloat(getComputedStyle(el).fontSize), content, box);
    el.style.fontSize = `${size}px`;
  }
}
