import type { Layout } from '../../src/api/layout.ts';
import type { ExplorerResult } from '../../src/api/explorer.ts';
import type { BalancesView, CardsView, CashFlowView, FreshnessView, InstallmentsView, SpendingView } from '../../src/api/views.ts';

export type { BalancesView, CardsView, CashFlowView, ExplorerResult, FreshnessView, InstallmentsView, Layout, SpendingView };

export interface FindingItem {
  id: string;
  kind: string;
  severity: 'info' | 'warning';
  accountId: string;
  summary: string;
  openedAt: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (response.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized();
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message = (body as { message?: string; error?: string } | null)?.message ?? (body as { error?: string } | null)?.error ?? response.statusText;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  login: (password: string, code: string) =>
    request<{ expiresAt: string }>('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, code }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  session: () => request<{ authenticated: true }>('/api/auth/session'),
  balances: () => request<BalancesView>('/api/balances'),
  cards: (cycle = 'open') => request<CardsView>(`/api/cards${query({ cycle })}`),
  cashflow: (from: string, to: string) => request<CashFlowView>(`/api/cashflow${query({ from, to })}`),
  spending: (from: string, to: string, by: 'category' | 'merchant') => request<SpendingView>(`/api/spending${query({ from, to, by })}`),
  installments: () => request<InstallmentsView>('/api/installments'),
  transactions: (from: string, to: string, limit: number) => request<ExplorerResult>(`/api/transactions${query({ from, to, limit })}`),
  freshness: () => request<FreshnessView>('/api/freshness'),
  findings: () => request<{ items: FindingItem[] }>('/api/findings'),
  layout: () => request<Layout>('/api/layout'),
  saveLayout: (layout: Layout) => request<Layout>('/api/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout) }),
};
