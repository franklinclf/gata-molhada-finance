import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { onInvalidate } from './invalidate.ts';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

let nextInstance = 0;
/** What each place on screen last loaded for each set of inputs, so going back to a cycle or period shows it at once while it refreshes. */
const seen = new Map<string, unknown>();

/** Runs `load` on mount and whenever `deps` change; refreshes by itself every `everyMs` when given. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], everyMs?: number): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const instance = useRef(nextInstance++);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `${instance.current}|${JSON.stringify(deps)}`;
    if (seen.has(cacheKey)) setData(seen.get(cacheKey) as T);
    setLoading(!seen.has(cacheKey));
    load()
      .then((value) => {
        if (cancelled) return;
        if (seen.size > 400) seen.delete(seen.keys().next().value as string);
        seen.set(cacheKey, value);
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
    const timer = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(timer);
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
