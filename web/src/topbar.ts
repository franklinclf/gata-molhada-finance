import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** A page can put its own controls in the top bar, next to the main menu (the dashboard does, for customizing the panel). */
let tools: ComponentChildren = null;
const listeners = new Set<() => void>();

export function setTopbarTools(next: ComponentChildren): void {
  tools = next;
  listeners.forEach((l) => l());
}

export function useTopbarTools(): ComponentChildren {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return tools;
}
