/** Room kept between a floating box and the edge of the window, and between the box and what it explains. */
const EDGE = 8;
const GAP = 6;

/**
 * Where a floating explanation goes for the element it explains: under it, starting at its left edge, moved left when it would
 * leave the window, and above it when there is no room below and more room above. All values in px of the window.
 */
export function placeTip(anchor: { left: number; top: number; bottom: number }, tip: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number } {
  const left = Math.max(EDGE, Math.min(anchor.left, view.width - tip.width - EDGE));
  const below = view.height - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  const top = tip.height > below && above > below ? Math.max(EDGE, anchor.top - GAP - tip.height) : anchor.bottom + GAP;
  return { left, top };
}

/**
 * One floating tooltip for the whole app. Any element with a data-tip attribute shows it on hover, and text that is cut
 * off by an ellipsis (class "clip") shows its full text. Nothing happens on touch screens, where there is no hover: an
 * explanation that matters there uses the Info component (Info.tsx), which also opens on focus and on a tap.
 */
export function installTooltip(): void {
  if (typeof document === 'undefined' || !matchMedia('(hover: hover)').matches) return;
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let current: Element | null = null;

  const textFor = (el: Element): string | null => {
    const marked = el.closest('[data-tip]');
    if (marked) return marked.getAttribute('data-tip');
    const clipped = el.closest('.clip');
    if (clipped && clipped.scrollWidth > clipped.clientWidth + 1) return clipped.textContent;
    return null;
  };

  const place = (x: number, y: number) => {
    const box = tip.getBoundingClientRect();
    // Chart columns ask for the tip beside them, vertically inside the chart, so it never covers the figures above or below the chart.
    const side = current?.closest('[data-tip-at="side"]');
    if (side) {
      const col = side.getBoundingClientRect();
      const chart = (side.parentElement ?? side).getBoundingClientRect();
      const right = col.right + 8;
      const left = right + box.width + 8 > window.innerWidth ? col.left - box.width - 8 : right;
      const top = Math.min(Math.max(8, chart.top + (chart.height - box.height) / 2), window.innerHeight - box.height - 8);
      tip.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
      return;
    }
    const left = Math.min(Math.max(8, x + 14), window.innerWidth - box.width - 8);
    const top = y + 18 + box.height > window.innerHeight ? y - box.height - 12 : y + 18;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  };

  document.addEventListener('mouseover', (event) => {
    const target = event.target as Element;
    const text = textFor(target);
    current = text ? target : null;
    if (!text) {
      tip.classList.remove('on');
      return;
    }
    tip.textContent = text;
    tip.classList.add('on');
    place(event.clientX, event.clientY);
  });
  document.addEventListener('mousemove', (event) => {
    // The text can change while the pointer stays on one element (the line chart reads the day under it).
    const target = event.target as Element;
    const text = textFor(target);
    if (!text) {
      if (current) {
        current = null;
        tip.classList.remove('on');
      }
      return;
    }
    current = target;
    if (tip.textContent !== text) tip.textContent = text;
    tip.classList.add('on');
    place(event.clientX, event.clientY);
  });
  document.addEventListener('mouseout', (event) => {
    if (!(event.relatedTarget instanceof Element) || !current?.contains(event.relatedTarget)) {
      if (!(event.relatedTarget instanceof Element) || !textFor(event.relatedTarget)) tip.classList.remove('on');
    }
  });
  document.addEventListener('scroll', () => tip.classList.remove('on'), true);
}
