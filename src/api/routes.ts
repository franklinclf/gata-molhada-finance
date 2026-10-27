import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import * as views from './views.ts';

export interface ApiResult {
  status: number;
  body: unknown;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(value: string): boolean {
  return DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseRange(params: URLSearchParams, now: Date): Parsed<views.DateRange> {
  const fallback = views.monthRange(now);
  const from = params.get('from') ?? fallback.from;
  const to = params.get('to') ?? localDay(now.toISOString());
  if (!isRealDay(from) || !isRealDay(to)) return { ok: false, error: 'from and to must be dates like 2026-10-27' };
  if (from > to) return { ok: false, error: 'from must not be after to' };
  return { ok: true, value: { from, to } };
}

function parseInteger(params: URLSearchParams, name: string, fallback: number, min: number, max: number): Parsed<number> {
  const raw = params.get(name);
  if (raw === null) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return { ok: false, error: `${name} must be an integer from ${min} to ${max}` };
  return { ok: true, value };
}

const badRequest = (message: string): ApiResult => ({ status: 400, body: { error: 'bad_request', message } });

export function apiRoute(method: string, pathname: string, params: URLSearchParams, store: Store, now: Date): ApiResult | null {
  const known = [
    '/api/balances', '/api/cards', '/api/transactions', '/api/cashflow', '/api/spending',
    '/api/installments', '/api/freshness', '/api/findings',
  ];
  if (!known.includes(pathname)) return null;
  if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };

  switch (pathname) {
    case '/api/balances':
      return { status: 200, body: views.balances(store, now) };
    case '/api/cards':
      return { status: 200, body: views.cards(store, now) };
    case '/api/installments':
      return { status: 200, body: views.installments(store, now) };
    case '/api/freshness':
      return { status: 200, body: views.freshness(store, now) };
    case '/api/findings':
      return { status: 200, body: { items: views.findings(store, params.get('includeResolved') === 'true') } };
    case '/api/cashflow': {
      const range = parseRange(params, now);
      if (!range.ok) return badRequest(range.error);
      return { status: 200, body: views.cashFlow(store, range.value, now) };
    }
    case '/api/spending': {
      const range = parseRange(params, now);
      if (!range.ok) return badRequest(range.error);
      const by = params.get('by') ?? 'category';
      if (by !== 'category' && by !== 'merchant') return badRequest('by must be category or merchant');
      return { status: 200, body: views.spending(store, range.value, by, now) };
    }
    default: {
      const range = parseRange(params, now);
      if (!range.ok) return badRequest(range.error);
      const limit = parseInteger(params, 'limit', 50, 1, 500);
      const offset = parseInteger(params, 'offset', 0, 0, 1_000_000);
      if (!limit.ok) return badRequest(limit.error);
      if (!offset.ok) return badRequest(offset.error);
      const accountId = params.get('accountId') ?? undefined;
      return {
        status: 200,
        body: views.transactions(store, { ...range.value, accountId, limit: limit.value, offset: offset.value, includeExcluded: params.get('includeExcluded') === 'true' }, now),
      };
    }
  }
}
