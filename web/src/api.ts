import type { TransactionDetail } from '../../src/api/detail.ts';
import type { Layout, LayoutItem, WidgetId } from '../../src/api/layout.ts';
import type { AiView, Decision, DecisionStatus, Suggestion } from '../../src/api/ai.ts';
import type { ForecastView } from '../../src/api/forecast.ts';
import type { Candidate, CategoryRow } from '../../src/api/mutations.ts';
import type { Cycle } from '../../src/api/cycles.ts';
import type { ExplorerResult } from '../../src/api/explorer.ts';
import type { InstallmentsView, InstallmentPurchase, InstallmentSlot } from '../../src/api/installments.ts';
import type { TrendView } from '../../src/api/trends.ts';
import type { NetWorthView } from '../../src/api/networth.ts';
import type { BudgetsView, BudgetLine, SuggestionLine } from '../../src/api/budgets.ts';
import type { RuleRow, RulePreview, ImportReport } from '../../src/api/rules.ts';
import type { Rule, RuleConditions } from '../../src/api/rules-engine.ts';
import type { BalancesView, BillsView, CardsView, CashFlowView, FreshnessView, SpendingView } from '../../src/api/views.ts';

export type { TrendView, NetWorthView, BudgetLine, BudgetsView, SuggestionLine, ImportReport, Rule, RuleConditions, RulePreview, RuleRow, AiView, Decision, DecisionStatus, ForecastView, Suggestion, InstallmentPurchase, InstallmentSlot, Candidate, BalancesView, BillsView, CardsView, CashFlowView, CategoryRow, Cycle, ExplorerResult, FreshnessView, InstallmentsView, Layout, LayoutItem, SpendingView, TransactionDetail, WidgetId };

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

export interface RefreshView {
  available: boolean;
  running?: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
  result?: 'completed' | 'timeout' | 'failed' | null;
  timedOut?: string[];
  error?: string | null;
}

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
  setInstallment: (id: string, number: number | null, total: number | null) =>
    request<{ ok: true }>(`/api/transactions/${encodeURIComponent(id)}/installment`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number, total }) }),
  decisions: (status?: string, q?: string) => request<{ items: Decision[]; counts: Record<DecisionStatus, number> }>(`/api/ai/decisions${query({ status, q })}`),
  decide: (key: string, action: 'accept' | 'reject' | 'reset', category?: string) =>
    request<{ ok: true }>('/api/ai/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, action, category }) }),
  resetDecisions: (statuses: string[] | 'all') => request<{ reset: number }>('/api/ai/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statuses }) }),
  forecast: () => request<ForecastView>('/api/cards/forecast'),
  accounts: () => request<{ items: AccountItem[] }>('/api/accounts'),
  setHidden: (id: string, hidden: boolean) =>
    request<{ ok: true }>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden }) }),
  createManual: (input: { accountId: string; day: string; amount: number; description: string; category?: string; notes?: string }) =>
    request<{ id: string }>('/api/manual-transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  updateManual: (id: string, patch: { accountId?: string; day?: string; amount?: number; description?: string; category?: string }) =>
    request<Record<string, never>>(`/api/manual-transactions/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  deleteManual: (id: string) => request<Record<string, never>>(`/api/manual-transactions/${id}`, { method: 'DELETE' }),
  spendingTrend: (months: number) => request<TrendView>(`/api/spending/trend${query({ months })}`),
  netWorth: () => request<NetWorthView>('/api/networth'),
  addAsset: (name: string, kind: 'asset' | 'liability', value: number | null) =>
    request<{ id: number }>('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, kind, value }) }),
  setAssetValue: (id: number, day: string, value: number | null) =>
    request<Record<string, never>>(`/api/assets/${id}/values`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, value }) }),
  updateAsset: (id: number, patch: { name?: string; archived?: boolean }) =>
    request<Record<string, never>>(`/api/assets/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  deleteAsset: (id: number) => request<Record<string, never>>(`/api/assets/${id}`, { method: 'DELETE' }),
  budgets: (month: string) => request<BudgetsView>(`/api/budgets${query({ month })}`),
  setBudget: (scope: 'category' | 'group', name: string, month: string, amount: number | null, recurring: boolean) =>
    request<Record<string, never>>('/api/budgets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, name, month, amount, recurring }) }),
  budgetSuggestions: (month: string, months: number) => request<{ items: SuggestionLine[] }>(`/api/budgets/suggestions${query({ month, months })}`),
  createBudgets: (month: string, items: Array<{ name: string; amount: number }>) =>
    request<{ created: number }>('/api/budgets/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, items }) }),
  copyBudgets: (from: string, to: string, adjustPercent: number, overwrite: boolean) =>
    request<{ copied: number; skipped: number }>('/api/budgets/copy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, adjustPercent, overwrite }) }),
  rules: () => request<{ items: RuleRow[] }>('/api/rules'),
  saveRule: (rule: { id?: number; name: string; active: boolean; conditions: RuleConditions; actions: { category: string } }) =>
    request<Rule>(rule.id === undefined ? '/api/rules' : `/api/rules/${rule.id}`, { method: rule.id === undefined ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rule) }),
  setRuleActive: (id: number, active: boolean) => request<Rule>(`/api/rules/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) }),
  deleteRuleById: (id: number) => request<Record<string, never>>(`/api/rules/${id}`, { method: 'DELETE' }),
  reorderRules: (ids: number[]) => request<Record<string, never>>('/api/rules/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }),
  previewRule: (conditions: RuleConditions, category: string) =>
    request<RulePreview>('/api/rules/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conditions, actions: { category } }) }),
  exportRules: () => request<unknown>('/api/rules/export'),
  importRules: (file: unknown, overwrite: boolean) =>
    request<ImportReport>('/api/rules/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(file as object), overwrite }) }),
  categories: () => request<CategoriesResponse>('/api/categories'),
  addCategory: (name: string) => request<{ ok: true }>('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  setCategoryParent: (name: string, parent: string | null) =>
    request<{ ok: true }>(`/api/categories/${encodeURIComponent(name)}/parent`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent }) }),
  deleteCategory: (name: string) => request<{ ok: true }>(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  deleteRule: (match: string) => request<{ ok: true }>(`/api/category-rules/${encodeURIComponent(match)}`, { method: 'DELETE' }),
  setCycleSettled: (accountId: string, cycleKey: string, settled: boolean | null) =>
    request<{ ok: true }>('/api/cycles', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, cycleKey, settled }) }),
  cycles: (accountId: string) => request<{ accountId: string; cycles: Cycle[] }>(`/api/cycles${query({ accountId })}`),
  freshness: () => request<FreshnessView>('/api/freshness'),
  refreshState: () => request<RefreshView>('/api/refresh'),
  refreshNow: () => request<{ started: true }>('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  findings: () => request<{ items: FindingItem[] }>('/api/findings'),
  layout: () => request<Layout>('/api/layout'),
  saveLayout: (layout: Layout) => request<Layout>('/api/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout) }),
};
