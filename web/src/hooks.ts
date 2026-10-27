import { useCallback, useEffect, useState } from 'preact/hooks';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` on mount and whenever `deps` change; refreshes by itself every `everyMs` when given. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], everyMs?: number): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((value) => {
        if (cancelled) return;
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
