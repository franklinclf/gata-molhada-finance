/**
 * One floating tooltip for the whole app. Any element with a data-tip attribute shows it on hover, and text that is cut
 * off by an ellipsis (class "clip") shows its full text. Nothing happens on touch screens, where there is no hover.
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
