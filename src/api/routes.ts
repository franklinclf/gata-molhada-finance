import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { cyclesFor } from './cycles.ts';
import { transactionDetail } from './detail.ts';
import { explore, type ExplorerQuery, type SortKey } from './explorer.ts';
import { acceptAll, acceptSuggestion, aiView, decide, listDecisions, rejectSuggestion, resetDecisions, type DecisionStatus } from './ai.ts';
import { forecast } from './forecast.ts';
import { installments } from './installments.ts';
import { calendar } from './calendar.ts';
import { detectRecurring, ignoreRecurring } from './recurring.ts';
import { createManual, deleteManual, updateManual, type ManualResult } from './manual.ts';
import { categoryTrend } from './trends.ts';
import { addAsset, deleteAsset, netWorth, setAssetValue, updateAsset, type AssetResult } from './networth.ts';
import { budgetsFor, copyBudgets, createBudgets, setBudget, suggestBudgets, type BudgetResult } from './budgets.ts';
import { createRule, deleteRule, exportRules, importRules, listRules, previewRule, reorderRules, updateRule, type RuleResult } from './rules.ts';
import { loadLayout, parseLayout, saveLayout } from './layout.ts';
import { addCategory, dismissSuggestion, joinCandidates, joinTransactions, listCategories, removeCategory, separateTransaction, setCategoryParent, setCycleSettled, setTransactionInstallment, setAccountHidden, setIgnored, setTransactionCategory, type MutationResult } from './mutations.ts';
import { effectiveTransactions, type ViewOptions } from './scope.ts';
import * as views from './views.ts';

export interface ApiResult {
  status: number;
  body: unknown;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CYCLE = /^(open|\d{4}-\d{2})$/;
const STATES = ['confirmed', 'single_source', 'conflict', 'stale_pending', 'billed', 'ignored'] as const;
const SORTS: SortKey[] = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'];

function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
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

function parseInteger(params: URLSearchParams, name: string, fallback: number | undefined, min: number, max: number): Parsed<number | undefined> {
  const raw = params.get(name);
  if (raw === null || raw === '') return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return { ok: false, error: `${name} must be an integer from ${min} to ${max}` };
  return { ok: true, value };
}

const list = (params: URLSearchParams, name: string): string[] | undefined => {
  const all = params.getAll(name).flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');
  return all.length > 0 ? all : undefined;
};

/** Reads the explorer filters. A day filter is applied only when given, unlike the fixed-period views. */
export function parseExplorer(params: URLSearchParams): Parsed<ExplorerQuery> {
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  if ((from !== undefined && !isRealDay(from)) || (to !== undefined && !isRealDay(to))) return { ok: false, error: 'from and to must be dates like 2026-10-27' };
  if (from !== undefined && to !== undefined && from > to) return { ok: false, error: 'from must not be after to' };
  const kind = params.get('kind') ?? 'all';
  if (kind !== 'all' && kind !== 'expense' && kind !== 'income') return { ok: false, error: 'kind must be all, expense or income' };
  const status = params.get('status') ?? undefined;
  if (status !== undefined && status !== 'pending' && status !== 'posted') return { ok: false, error: 'status must be pending or posted' };
  const states = list(params, 'state');
  if (states?.some((s) => !(STATES as readonly string[]).includes(s))) return { ok: false, error: `state must be one of ${STATES.join(', ')}` };
  const cycle = params.get('cycle') ?? undefined;
  if (cycle !== undefined && !CYCLE.test(cycle)) return { ok: false, error: 'cycle must be open or a month like 2026-10' };
  const sort = (params.get('sort') ?? 'date_desc') as SortKey;
  if (!SORTS.includes(sort)) return { ok: false, error: `sort must be one of ${SORTS.join(', ')}` };
  const limit = parseInteger(params, 'limit', 50, 1, 500);
  const offset = parseInteger(params, 'offset', 0, 0, 1_000_000);
  const min = parseInteger(params, 'min', undefined, 0, 1_000_000_000);
  const max = parseInteger(params, 'max', undefined, 0, 1_000_000_000);
  for (const parsed of [limit, offset, min, max]) if (!parsed.ok) return parsed;
  // Category names can contain commas, so each one is its own parameter. An empty value means "no category".
  const categories = params.has('category') ? params.getAll('category') : undefined;
  return {
    ok: true,
    value: {
      from,
      to,
      accountIds: list(params, 'accountId'),
      institutions: params.has('institution') ? params.getAll('institution') : undefined,
      categories,
      kind,
      q: params.get('q') ?? undefined,
      merchant: params.get('merchant') ?? undefined,
      status,
      states: states as ExplorerQuery['states'],
      min: (min as { value?: number }).value,
      max: (max as { value?: number }).value,
      cycle,
      spendingOnly: params.get('spendingOnly') === 'true',
      hideOwnTransfers: params.get('hideOwnTransfers') === 'true',
      sort,
      limit: (limit as { value: number }).value,
      offset: (offset as { value: number }).value,
      includeExcluded: params.get('includeExcluded') === 'true',
    },
  };
}

const badRequest = (message: string): ApiResult => ({ status: 400, body: { error: 'bad_request', message } });
const methodNotAllowed = (): ApiResult => ({ status: 405, body: { error: 'method_not_allowed' } });
const fromMutation = (result: MutationResult): ApiResult => (result.ok ? { status: 200, body: { ok: true } } : { status: result.status, body: { error: result.error } });

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function apiRoute(method: string, pathname: string, params: URLSearchParams, store: Store, now: Date, body = ''): ApiResult | null {
  const opts: ViewOptions = { includeHidden: params.get('includeHidden') === 'true' };
  const parts = pathname.split('/').filter(Boolean); // ['api', 'transactions', ':id', ...]
  const [, resource, id, sub] = parts;

  switch (resource) {
    case 'layout': {
      if (parts.length !== 2) return null;
      if (method === 'GET') return { status: 200, body: loadLayout(store) };
      if (method !== 'PUT') return methodNotAllowed();
      const raw = parseBody(body);
      const layout = raw ? parseLayout(raw) : null;
      if (!layout) return badRequest('layout must be { widgets: [...] } with known widgets');
      saveLayout(store, layout, now);
      return { status: 200, body: layout };
    }
    case 'recurring': {
      if (parts.length === 2) return method === 'GET' ? { status: 200, body: { items: detectRecurring(store, now, opts) } } : methodNotAllowed();
      if (parts.length === 3 && id === 'ignore') {
        if (method !== 'POST') return methodNotAllowed();
        const input = parseBody(body);
        if (!input) return badRequest('body must be { key, ignored }');
        return fromMutation(ignoreRecurring(store, input.key, input.ignored, now));
      }
      return null;
    }
    case 'calendar': {
      if (parts.length !== 2) return null;
      if (method !== 'GET') return methodNotAllowed();
      const month = params.get('month') ?? localDay(now.toISOString()).slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return badRequest('month must look like 2026-10');
      return { status: 200, body: calendar(store, month, now, opts) };
    }
    case 'manual-transactions': {
      const asResult = <T,>(r: ManualResult<T>): ApiResult => (r.ok ? { status: 200, body: r.value } : { status: r.status, body: { error: r.error } });
      if (parts.length === 2) {
        if (method !== 'POST') return methodNotAllowed();
        const input = parseBody(body);
        return input ? asResult(createManual(store, input, now)) : badRequest('body must be { accountId, day, amount, description }');
      }
      if (parts.length !== 3 || id === undefined) return null;
      if (method === 'DELETE') return asResult(deleteManual(store, id, now));
      if (method !== 'PUT') return methodNotAllowed();
      const input = parseBody(body);
      return input ? asResult(updateManual(store, id, input, now)) : badRequest('body must be an object');
    }
    case 'networth': {
      if (parts.length !== 2) return null;
      return method === 'GET' ? { status: 200, body: netWorth(store, now, opts) } : methodNotAllowed();
    }
    case 'assets': {
      const asResult = <T,>(r: AssetResult<T>): ApiResult => (r.ok ? { status: 200, body: r.value } : { status: r.status, body: { error: r.error } });
      if (parts.length === 2) {
        if (method !== 'POST') return methodNotAllowed();
        const input = parseBody(body);
        return input ? asResult(addAsset(store, input, now)) : badRequest('body must be { name, kind, value?, day? }');
      }
      const assetId = Number(id);
      if (!Number.isInteger(assetId)) return null;
      if (parts.length === 3) {
        if (method === 'DELETE') return asResult(deleteAsset(store, assetId));
        if (method !== 'PUT') return methodNotAllowed();
        const input = parseBody(body);
        return input ? asResult(updateAsset(store, assetId, input)) : badRequest('body must be an object');
      }
      if (parts.length === 4 && sub === 'values') {
        if (method !== 'PUT') return methodNotAllowed();
        const input = parseBody(body);
        return input ? asResult(setAssetValue(store, assetId, input, now)) : badRequest('body must be { day, value }');
      }
      return null;
    }
    case 'budgets': {
      const asResult = <T,>(r: BudgetResult<T>): ApiResult => (r.ok ? { status: 200, body: r.value } : { status: r.status, body: { error: r.error } });
      const month = params.get('month') ?? localDay(now.toISOString()).slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return badRequest('month must look like 2026-10');
      if (parts.length === 2) {
        if (method === 'GET') return { status: 200, body: budgetsFor(store, month, now) };
        if (method !== 'PUT') return methodNotAllowed();
        const input = parseBody(body);
        return input ? asResult(setBudget(store, input, now)) : badRequest('body must be { scope, name, month, amount, recurring }');
      }
      if (parts.length === 3 && id === 'suggestions') {
        if (method !== 'GET') return methodNotAllowed();
        const months = Number(params.get('months') ?? '3');
        if (![3, 6, 12].includes(months)) return badRequest('months must be 3, 6 or 12');
        return { status: 200, body: { month, months, items: suggestBudgets(store, month, months, now) } };
      }
      if (parts.length === 3 && (id === 'batch' || id === 'copy')) {
        if (method !== 'POST') return methodNotAllowed();
        const input = parseBody(body);
        if (!input) return badRequest('body must be an object');
        return id === 'batch' ? asResult(createBudgets(store, input.month, input.items, now)) : asResult(copyBudgets(store, input, now));
      }
      return null;
    }
    case 'rules': {
      const asResult = <T,>(r: RuleResult<T>): ApiResult => (r.ok ? { status: 200, body: r.value } : { status: r.status, body: { error: r.error } });
      if (parts.length === 2) {
        if (method === 'GET') return { status: 200, body: { items: listRules(store) } };
        if (method !== 'POST') return methodNotAllowed();
        const input = parseBody(body);
        return input ? asResult(createRule(store, input, now)) : badRequest('body must be a rule');
      }
      if (parts.length === 3 && method === 'GET' && id === 'export') return { status: 200, body: exportRules(store) };
      if (parts.length === 3 && (id === 'preview' || id === 'reorder' || id === 'import')) {
        if (method !== 'POST') return methodNotAllowed();
        const input = parseBody(body);
        if (!input) return badRequest('body must be an object');
        if (id === 'preview') return asResult(previewRule(store, input));
        if (id === 'import') return asResult(importRules(store, input, now));
        return asResult(reorderRules(store, input.ids, now));
      }
      const ruleId = Number(id);
      if (parts.length !== 3 || !Number.isInteger(ruleId)) return null;
      if (method === 'DELETE') return asResult(deleteRule(store, ruleId));
      if (method === 'PUT') {
        const input = parseBody(body);
        return input ? asResult(updateRule(store, ruleId, input, now)) : badRequest('body must be a rule');
      }
      return methodNotAllowed();
    }
    case 'balances':
      if (parts.length !== 2) return null;
      return method === 'GET' ? { status: 200, body: views.balances(store, now, opts) } : methodNotAllowed();
    case 'cards': {
      if (parts.length === 3 && id === 'forecast') return method === 'GET' ? { status: 200, body: forecast(store, now, opts) } : methodNotAllowed();
      if (parts.length === 3 && id === 'bills') return method === 'GET' ? { status: 200, body: views.cardBills(store, now, opts) } : methodNotAllowed();
      if (parts.length !== 2) return null;
      if (method !== 'GET') return methodNotAllowed();
      const cycle = params.get('cycle') ?? 'open';
      if (!CYCLE.test(cycle)) return badRequest('cycle must be open or a month like 2026-10');
      return { status: 200, body: views.cards(store, now, opts, cycle) };
    }
    case 'cycles': {
      if (parts.length !== 2) return null;
      if (method === 'PUT') {
        const input = parseBody(body);
        if (!input) return badRequest('body must be { accountId, cycleKey, settled }');
        return fromMutation(setCycleSettled(store, input.accountId, input.cycleKey, input.settled, now));
      }
      if (method !== 'GET') return methodNotAllowed();
      const accountId = params.get('accountId');
      const account = store.listCanonicalAccounts().find((a) => a.id === accountId && a.kind === 'credit_card');
      if (!account) return { status: 404, body: { error: 'not_found' } };
      const cycles = cyclesFor(store, account, effectiveTransactions(store, { includeHidden: true }), localDay(now.toISOString()));
      return { status: 200, body: { accountId: account.id, cycles: [...cycles].reverse() } };
    }
    case 'installments':
      if (parts.length !== 2) return null;
      return method === 'GET' ? { status: 200, body: installments(store, now, opts) } : methodNotAllowed();
    case 'freshness':
      if (parts.length !== 2) return null;
      return method === 'GET' ? { status: 200, body: views.freshness(store, now) } : methodNotAllowed();
    case 'findings':
      if (parts.length === 4 && id !== undefined && sub === 'dismiss') return method === 'POST' ? fromMutation(dismissSuggestion(store, id, now)) : methodNotAllowed();
      if (parts.length !== 2) return null;
      return method === 'GET' ? { status: 200, body: { items: views.findings(store, params.get('includeResolved') === 'true') } } : methodNotAllowed();
    case 'cashflow':
    case 'spending': {
      if (resource === 'spending' && parts.length === 3 && id === 'trend') {
        if (method !== 'GET') return methodNotAllowed();
        const months = Number(params.get('months') ?? '6');
        if (![3, 6, 12].includes(months)) return badRequest('months must be 3, 6 or 12');
        return { status: 200, body: categoryTrend(store, now, months) };
      }
      if (parts.length !== 2) return null;
      if (method !== 'GET') return methodNotAllowed();
      const range = parseRange(params, now);
      if (!range.ok) return badRequest(range.error);
      if (resource === 'cashflow') return { status: 200, body: views.cashFlow(store, range.value, now, opts) };
      const by = params.get('by') ?? 'category';
      if (by !== 'category' && by !== 'merchant') return badRequest('by must be category or merchant');
      return { status: 200, body: views.spending(store, range.value, by, now, opts) };
    }
    case 'transactions': {
      if (parts.length === 2) {
        if (method !== 'GET') return methodNotAllowed();
        const query = parseExplorer(params);
        if (!query.ok) return badRequest(query.error);
        return { status: 200, body: explore(store, query.value, now, opts) };
      }
      if (parts.length === 3 && id !== undefined) {
        if (method !== 'GET') return methodNotAllowed();
        const detail = transactionDetail(store, id, now);
        return detail ? { status: 200, body: detail } : { status: 404, body: { error: 'not_found' } };
      }
      if (parts.length === 4 && id !== undefined && sub === 'candidates') {
        if (method !== 'GET') return methodNotAllowed();
        const candidates = joinCandidates(store, id);
        return candidates ? { status: 200, body: { items: candidates } } : { status: 404, body: { error: 'not_found' } };
      }
      if (parts.length === 4 && id !== undefined && sub === 'merge') {
        if (method === 'DELETE') return fromMutation(separateTransaction(store, id, now));
        if (method !== 'POST') return methodNotAllowed();
        const input = parseBody(body);
        if (!input) return badRequest('body must be { otherId }');
        return fromMutation(joinTransactions(store, id, input.otherId, now));
      }
      if (parts.length === 4 && id !== undefined && sub === 'installment') {
        if (method !== 'PUT') return methodNotAllowed();
        const input = parseBody(body);
        if (!input) return badRequest('body must be { number, total } or both null');
        return fromMutation(setTransactionInstallment(store, id, input.number, input.total, now));
      }
      if (parts.length === 4 && id !== undefined && sub === 'ignore') {
        if (method !== 'PUT') return methodNotAllowed();
        const input = parseBody(body);
        if (!input) return badRequest('body must be { ignored }');
        return fromMutation(setIgnored(store, id, input.ignored, now));
      }
      if (parts.length === 4 && id !== undefined && sub === 'category') {
        if (method !== 'PUT') return methodNotAllowed();
        const input = parseBody(body);
        if (!input || !('category' in input)) return badRequest('body must be { category, applyToSimilar? }');
        return fromMutation(setTransactionCategory(store, id, input.category, input.applyToSimilar === true, now));
      }
      return null;
    }
    case 'accounts': {
      if (parts.length === 2) {
        if (method !== 'GET') return methodNotAllowed();
        const hidden = store.listHiddenAccountIds();
        return {
          status: 200,
          body: {
            items: store.listCanonicalAccounts().map((a) => ({
              id: a.id, institution: a.institution, kind: a.kind, name: a.name, last4: a.last4, balance: a.balance, creditLimit: a.creditLimit,
              limitGroupId: a.limitGroupId, asOf: a.balanceAsOf, hidden: hidden.has(a.id),
            })),
          },
        };
      }
      if (parts.length === 3 && id !== undefined) {
        if (method !== 'PUT') return methodNotAllowed();
        const input = parseBody(body);
        if (!input) return badRequest('body must be { hidden }');
        return fromMutation(setAccountHidden(store, id, input.hidden, now));
      }
      return null;
    }
    case 'categories': {
      if (parts.length === 2) {
        if (method === 'GET') return { status: 200, body: { items: listCategories(store), rules: [...store.listCategoryRules()].map(([match, category]) => ({ match, category })) } };
        if (method !== 'POST') return methodNotAllowed();
        const input = parseBody(body);
        if (!input) return badRequest('body must be { name }');
        return fromMutation(addCategory(store, input.name, now));
      }
      if (parts.length === 4 && id !== undefined && sub === 'parent') {
        if (method !== 'PUT') return methodNotAllowed();
        const input = parseBody(body);
        if (!input || !('parent' in input)) return badRequest('body must be { parent }');
        let name: string;
        try {
          name = decodeURIComponent(id);
        } catch {
          return badRequest('bad category name');
        }
        return fromMutation(setCategoryParent(store, name, input.parent, now));
      }
      if (parts.length === 3 && id !== undefined) {
        if (method !== 'DELETE') return methodNotAllowed();
        let name: string;
        try {
          name = decodeURIComponent(id);
        } catch {
          return badRequest('bad category name');
        }
        return fromMutation(removeCategory(store, name));
      }
      return null;
    }
    case 'ai': {
      if (parts.length === 2) return method === 'GET' ? { status: 200, body: aiView(store, now) } : methodNotAllowed();
      if (parts.length === 3 && id === 'decisions') {
        if (method !== 'GET') return methodNotAllowed();
        const status = params.get('status') ?? undefined;
        if (status !== undefined && !['applied', 'accepted', 'rejected', 'skipped'].includes(status)) return badRequest('status must be applied, accepted, rejected or skipped');
        return { status: 200, body: listDecisions(store, { status: status as DecisionStatus | undefined, q: params.get('q') ?? undefined }) };
      }
      if (parts.length !== 3 || method !== 'POST') return parts.length === 3 ? methodNotAllowed() : null;
      const input = parseBody(body) ?? {};
      if (id === 'accept') return fromMutation(acceptSuggestion(store, input.key, input.category, now));
      if (id === 'reject') return fromMutation(rejectSuggestion(store, input.key));
      if (id === 'decide') return fromMutation(decide(store, input.key, input.action, input.category, now));
      if (id === 'reset') {
        const result = resetDecisions(store, input.statuses, now);
        return result.ok ? { status: 200, body: { reset: result.reset } } : { status: result.status, body: { error: result.error } };
      }
      if (id === 'accept-all') return { status: 200, body: { accepted: acceptAll(store, 'medium', now) } };
      return null;
    }
    case 'category-rules': {
      if (parts.length !== 3 || id === undefined) return null;
      if (method !== 'DELETE') return methodNotAllowed();
      let match: string;
      try {
        match = decodeURIComponent(id);
      } catch {
        return badRequest('bad rule key');
      }
      if (!store.listCategoryRules().has(match)) return { status: 404, body: { error: 'not_found' } };
      store.setCategoryRule(match, null, now.toISOString());
      return { status: 200, body: { ok: true } };
    }
    default:
      return null;
  }
}
