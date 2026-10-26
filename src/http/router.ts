import type { Store } from '../store/store.ts';

export interface RouterDeps {
  store: Store;
  version: string;
  now: () => Date;
}

export interface RouteResult {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export function route(method: string, pathname: string, deps: RouterDeps): RouteResult {
  if (pathname === '/healthz') {
    if (method !== 'GET' && method !== 'HEAD') {
      return { status: 405, headers: { Allow: 'GET, HEAD' }, body: null };
    }
    let status = 200;
    let payload: Record<string, unknown>;
    const time = deps.now().toISOString();
    try {
      payload = { status: 'ok', version: deps.version, schemaVersion: deps.store.schemaVersion(), time };
    } catch {
      status = 503;
      payload = { status: 'degraded', version: deps.version, time };
    }
    return { status, headers: JSON_HEADERS, body: method === 'HEAD' ? null : JSON.stringify(payload) };
  }
  return { status: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
}
