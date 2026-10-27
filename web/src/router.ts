import { useEffect, useState } from 'preact/hooks';

export interface Route {
  /** First segment, for example "transactions". Empty for the dashboard. */
  page: string;
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const text = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = text.split('?');
  return { page: path.split('/')[0] ?? '', params: new URLSearchParams(query) };
}

export function hrefFor(page: string, params?: Record<string, string | undefined> | URLSearchParams): string {
  const search = new URLSearchParams();
  if (params instanceof URLSearchParams) params.forEach((v, k) => search.append(k, v));
  else for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') search.set(k, v);
  const query = search.toString();
  return `#/${page}${query ? `?${query}` : ''}`;
}

export function navigate(page: string, params?: Record<string, string | undefined> | URLSearchParams): void {
  location.hash = hrefFor(page, params);
}

/** Changes some parameters of the current route (a null value removes it) without adding a history entry. */
export function patchParams(updates: Record<string, string | string[] | null | undefined>, replace = true): void {
  const route = parseHash(location.hash);
  const params = new URLSearchParams(route.params);
  for (const [key, value] of Object.entries(updates)) {
    params.delete(key);
    if (Array.isArray(value)) for (const v of value) params.append(key, v);
    else if (value !== null && value !== undefined && value !== '') params.set(key, value);
  }
  const next = hrefFor(route.page, params);
  if (replace) history.replaceState(null, '', next);
  else location.hash = next;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
