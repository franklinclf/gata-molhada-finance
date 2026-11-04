// Tells every loaded screen that data changed, so a lists behind an open drawer shows an edit at once instead of at the next visit.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Reloads every `useLoad` on screen. Calls close together become one reload. */
export function invalidateData(): void {
  clearTimeout(timer);
  timer = setTimeout(() => listeners.forEach((fn) => fn()), 80);
}

export function onInvalidate(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
