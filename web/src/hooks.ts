import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { onInvalidate } from './invalidate.ts';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** What each loader last loaded for each set of inputs, so reopening a screen or going back to a cycle shows it at once while it refreshes. */
const seen = new Map<string, unknown>();

/**
 * Cache key of a loader. The loader source tells two loaders with equal deps apart (`() => api.cards()` against
 * `() => api.goals()`) and survives remounting, which an instance counter did not. Callers whose loader closes over
 * something that is not in `deps` can pass an explicit `cacheKey`.
 */
function keyOf(load: () => unknown, deps: unknown[], cacheKey?: string): string {
  return `${cacheKey ?? load.toString()}|${JSON.stringify(deps)}`;
}

/**
 * Runs `load` on mount and whenever `deps` change; refreshes by itself every `everyMs` when given.
 * The refresh timer pauses while the tab is hidden and runs once when the tab comes back after `everyMs` or more.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], everyMs?: number, cacheKey?: string): Loaded<T> {
  const first = keyOf(load, deps, cacheKey);
  const [data, setData] = useState<T | null>(() => (seen.has(first) ? (seen.get(first) as T) : null));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !seen.has(first));
  const [tick, setTick] = useState(0);
  const lastLoad = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const key = keyOf(load, deps, cacheKey);
    if (seen.has(key)) setData(seen.get(key) as T);
    setLoading(!seen.has(key));
    lastLoad.current = Date.now();
    load()
      .then((value) => {
        if (cancelled) return;
        seen.delete(key);
        if (seen.size >= 400) seen.delete(seen.keys().next().value as string);
        seen.set(key, value);
        setData(value);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'erro');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  useEffect(() => onInvalidate(() => setTick((n) => n + 1)), []);

  useEffect(() => {
    if (!everyMs) return;
    const timer = setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1);
    }, everyMs);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastLoad.current >= everyMs) setTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [everyMs]);

  return { data, error, loading, reload: useCallback(() => setTick((n) => n + 1), []) };
}

/** A boolean saved in localStorage, for example "hide values". */
export function useStoredFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const saved = localStorage.getItem(key);
    return saved === null ? initial : saved === '1';
  });
  return [
    value,
    (next) => {
      localStorage.setItem(key, next ? '1' : '0');
      setValue(next);
    },
  ];
}
