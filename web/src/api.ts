import type { TransactionDetail } from '../../src/api/detail.ts';
import type { Layout, LayoutItem, WidgetId } from '../../src/api/layout.ts';
import type { CategoryRow } from '../../src/api/mutations.ts';
import type { Cycle } from '../../src/api/cycles.ts';
import type { ExplorerResult } from '../../src/api/explorer.ts';
import type { BalancesView, CardsView, CashFlowView, FreshnessView, InstallmentsView, SpendingView } from '../../src/api/views.ts';

export type { BalancesView, CardsView, CashFlowView, CategoryRow, Cycle, ExplorerResult, FreshnessView, InstallmentsView, Layout, LayoutItem, SpendingView, TransactionDetail, WidgetId };

export interface AccountItem {
  id: string;
  institution: string;
  kind: 'checking' | 'savings' | 'credit_card';
  name: string;
  last4: string | null;
  balance: number;
  creditLimit: number | null;
  limitGroupId: string | null;
  asOf: string | null;
  hidden: boolean;
}

export interface CategoriesResponse {
  items: CategoryRow[];
  rules: Array<{ match: string; category: string }>;
}

export interface FindingItem {
  id: string;
  kind: string;
  severity: 'info' | 'warning';
  accountId: string;
  transactionId: string;
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
  /** Explorer with any filters, given as URL parameters. */
  explore: (params: URLSearchParams) => request<ExplorerResult>(`/api/transactions?${params.toString()}`),
  detail: (id: string) => request<TransactionDetail>(`/api/transactions/${encodeURIComponent(id)}`),
  setCategory: (id: string, category: string | null, applyToSimilar: boolean) =>
    request<{ ok: true }>(`/api/transactions/${encodeURIComponent(id)}/category`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, applyToSimilar }) }),
  accounts: () => request<{ items: AccountItem[] }>('/api/accounts'),
  setHidden: (id: string, hidden: boolean) =>
    request<{ ok: true }>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden }) }),
  categories: () => request<CategoriesResponse>('/api/categories'),
  addCategory: (name: string) => request<{ ok: true }>('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  deleteCategory: (name: string) => request<{ ok: true }>(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  deleteRule: (match: string) => request<{ ok: true }>(`/api/category-rules/${encodeURIComponent(match)}`, { method: 'DELETE' }),
  cycles: (accountId: string) => request<{ accountId: string; cycles: Cycle[] }>(`/api/cycles${query({ accountId })}`),
  freshness: () => request<FreshnessView>('/api/freshness'),
  findings: () => request<{ items: FindingItem[] }>('/api/findings'),
  layout: () => request<Layout>('/api/layout'),
  saveLayout: (layout: Layout) => request<Layout>('/api/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout) }),
};
