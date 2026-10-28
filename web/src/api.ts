import type { TransactionDetail } from '../../src/api/detail.ts';
import type { Layout, LayoutItem, WidgetId } from '../../src/api/layout.ts';
import type { AiView, Suggestion } from '../../src/api/ai.ts';
import type { Candidate, CategoryRow } from '../../src/api/mutations.ts';
import type { Cycle } from '../../src/api/cycles.ts';
import type { ExplorerResult } from '../../src/api/explorer.ts';
import type { InstallmentsView, InstallmentPurchase, InstallmentSlot } from '../../src/api/installments.ts';
import type { BalancesView, BillsView, CardsView, CashFlowView, FreshnessView, SpendingView } from '../../src/api/views.ts';

export type { AiView, Suggestion, InstallmentPurchase, InstallmentSlot, Candidate, BalancesView, BillsView, CardsView, CashFlowView, CategoryRow, Cycle, ExplorerResult, FreshnessView, InstallmentsView, Layout, LayoutItem, SpendingView, TransactionDetail, WidgetId };

export interface SecurityView {
  strength: 'password' | 'passkey' | 'device';
  passkeysAvailable: boolean;
  passkeys: Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null; transports: string[] }>;
  devices: Array<{ id: string; name: string; createdAt: string; lastUsedAt: string; expiresAt: string; current: boolean }>;
}

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
  details: { otherTransactionId?: string; sources?: string[]; amount?: number };
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
  login: (password: string, code: string, trust = false, deviceName = '') =>
    request<{ expiresAt: string; trusted: boolean }>('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, code, trust, deviceName }) }),
  methods: () => request<{ password: boolean; passkeys: boolean }>('/api/auth/methods'),
  passkeyLoginOptions: () => request<Record<string, unknown>>('/api/auth/passkey/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  passkeyLogin: (credential: Record<string, unknown>, trust = false, deviceName = '') =>
    request<{ expiresAt: string; trusted: boolean }>('/api/auth/passkey/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential, trust, deviceName }) }),
  security: () => request<SecurityView>('/api/auth/security'),
  passkeyRegisterOptions: () => request<Record<string, unknown>>('/api/auth/passkey/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  registerPasskey: (credential: Record<string, unknown>, name: string) =>
    request<{ ok: true }>('/api/auth/passkey/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential, name }) }),
  deletePasskey: (id: string) => request<{ ok: true }>(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  trustDevice: (name: string) => request<{ ok: true }>('/api/auth/devices/trust', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  forgetDevice: (id: string) => request<{ ok: true }>(`/api/auth/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  session: () => request<{ authenticated: true }>('/api/auth/session'),
  balances: () => request<BalancesView>('/api/balances'),
  cards: (cycle = 'open') => request<CardsView>(`/api/cards${query({ cycle })}`),
  cashflow: (from: string, to: string) => request<CashFlowView>(`/api/cashflow${query({ from, to })}`),
  spending: (from: string, to: string, by: 'category' | 'merchant') => request<SpendingView>(`/api/spending${query({ from, to, by })}`),
  bills: () => request<BillsView>('/api/cards/bills'),
  installments: () => request<InstallmentsView>('/api/installments'),
  transactions: (from: string, to: string, limit: number) => request<ExplorerResult>(`/api/transactions${query({ from, to, limit })}`),
  /** Explorer with any filters, given as URL parameters. */
  explore: (params: URLSearchParams) => request<ExplorerResult>(`/api/transactions?${params.toString()}`),
  detail: (id: string) => request<TransactionDetail>(`/api/transactions/${encodeURIComponent(id)}`),
  setCategory: (id: string, category: string | null, applyToSimilar: boolean) =>
    request<{ ok: true }>(`/api/transactions/${encodeURIComponent(id)}/category`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, applyToSimilar }) }),
  candidates: (id: string) => request<{ items: Candidate[] }>(`/api/transactions/${encodeURIComponent(id)}/candidates`),
  join: (id: string, otherId: string) =>
    request<{ ok: true }>(`/api/transactions/${encodeURIComponent(id)}/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ otherId }) }),
  separate: (id: string) => request<{ ok: true }>(`/api/transactions/${encodeURIComponent(id)}/merge`, { method: 'DELETE' }),
  setIgnored: (id: string, ignored: boolean) =>
    request<{ ok: true }>(`/api/transactions/${encodeURIComponent(id)}/ignore`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ignored }) }),
  dismiss: (findingId: string) => request<{ ok: true }>(`/api/findings/${encodeURIComponent(findingId)}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  ai: () => request<AiView>('/api/ai'),
  acceptAi: (key: string, category?: string) => request<{ ok: true }>('/api/ai/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, category }) }),
  rejectAi: (key: string) => request<{ ok: true }>('/api/ai/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }),
  acceptAllAi: () => request<{ accepted: number }>('/api/ai/accept-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  accounts: () => request<{ items: AccountItem[] }>('/api/accounts'),
  setHidden: (id: string, hidden: boolean) =>
    request<{ ok: true }>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden }) }),
  categories: () => request<CategoriesResponse>('/api/categories'),
  addCategory: (name: string) => request<{ ok: true }>('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  deleteCategory: (name: string) => request<{ ok: true }>(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  deleteRule: (match: string) => request<{ ok: true }>(`/api/category-rules/${encodeURIComponent(match)}`, { method: 'DELETE' }),
  setCycleSettled: (accountId: string, cycleKey: string, settled: boolean | null) =>
    request<{ ok: true }>('/api/cycles', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, cycleKey, settled }) }),
  cycles: (accountId: string) => request<{ accountId: string; cycles: Cycle[] }>(`/api/cycles${query({ accountId })}`),
  freshness: () => request<FreshnessView>('/api/freshness'),
  findings: () => request<{ items: FindingItem[] }>('/api/findings'),
  layout: () => request<Layout>('/api/layout'),
  saveLayout: (layout: Layout) => request<Layout>('/api/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout) }),
};
