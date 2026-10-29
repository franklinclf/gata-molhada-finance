import type { AdapterCapabilities, RefreshHandle, SourceAdapter } from '../../core/adapter.ts';
import {
  SourceFormatError,
  SourceHttpError,
  type HttpClient,
  type SnapshotSink,
} from '../../core/http.ts';
import type { AccountKind, Freshness, SourceAccount, SourceBill, SourceTransaction } from '../../core/types.ts';
import { asArray, asRecord, optString, reqIsoInstant, reqNumber, UnsupportedAccountError } from '../shape.ts';
import { normalizeAccount, normalizeBill, normalizeTransaction } from './normalize.ts';

export interface PluggyItemConfig {
  /** Name the user gives the connection, for example the bank. MeuPluggy items hide the real name. */
  label: string;
  itemId: string;
}

export interface PluggyConfig {
  clientId: string;
  clientSecret: string;
  items: PluggyItemConfig[];
}

export interface PluggyDeps {
  http: HttpClient;
  sink: SnapshotSink;
  now?: () => Date;
  baseUrl?: string;
}

const MAX_PAGES = 200;

/**
 * The bank network limits reads per month. When the limit is hit, the item ends as PARTIAL_SUCCESS and a
 * product in statusDetail carries a warning with code 423.
 */
function hasQuotaWarning(item: Record<string, unknown>): boolean {
  if (item.status !== 'PARTIAL_SUCCESS' || typeof item.statusDetail !== 'object' || item.statusDetail === null) return false;
  return Object.values(item.statusDetail as Record<string, unknown>).some((product) => {
    const warnings = typeof product === 'object' && product !== null ? (product as Record<string, unknown>).warnings : null;
    return Array.isArray(warnings) && warnings.some((w) => typeof w === 'object' && w !== null && String((w as Record<string, unknown>).code) === '423');
  });
}

export class PluggyAdapter implements SourceAdapter {
  readonly id = 'pluggy';
  readonly capabilities: AdapterCapabilities = {
    refreshOnDemand: true,
    pendingTransactions: true,
    creditLimits: true,
    rawDescription: true,
    installments: true,
  };

  private readonly config: PluggyConfig;
  private readonly http: HttpClient;
  private readonly sink: SnapshotSink;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private apiKey: string | null = null;
  private readonly kinds = new Map<string, AccountKind>();
  private warnings: string[] = [];

  constructor(config: PluggyConfig, deps: PluggyDeps) {
    this.config = config;
    this.http = deps.http;
    this.sink = deps.sink;
    this.now = deps.now ?? (() => new Date());
    this.baseUrl = deps.baseUrl ?? 'https://api.pluggy.ai';
  }

  drainWarnings(): string[] {
    const out = this.warnings;
    this.warnings = [];
    return out;
  }

  async fetchAccounts(): Promise<{ accounts: SourceAccount[]; freshness: Freshness[] }> {
    const accounts: SourceAccount[] = [];
    const freshness: Freshness[] = [];
    const observedAt = this.now().toISOString();

    for (const item of this.config.items) {
      freshness.push(this.freshnessOf(item, asRecord(await this.get(`/items/${item.itemId}`), 'pluggy.item'), observedAt));

      const list = asRecord(await this.get(`/accounts?itemId=${item.itemId}`), 'pluggy.accounts');
      for (const raw of asArray(list.results, 'pluggy.accounts.results')) {
        try {
          const account = normalizeAccount(raw, item.label);
          this.kinds.set(account.externalId, account.kind);
          accounts.push(account);
        } catch (error) {
          if (!(error instanceof UnsupportedAccountError)) throw error;
          this.warnings.push(`${item.label}: skipped an account (${error.message})`);
        }
      }
    }
    return { accounts, freshness };
  }

  /** Reads only the items, which is cheap and does not touch the banks. */
  async fetchFreshness(): Promise<Freshness[]> {
    const observedAt = this.now().toISOString();
    const out: Freshness[] = [];
    for (const item of this.config.items) {
      out.push(this.freshnessOf(item, asRecord(await this.get(`/items/${item.itemId}`, false), 'pluggy.item'), observedAt));
    }
    return out;
  }

  private freshnessOf(item: PluggyItemConfig, body: Record<string, unknown>, observedAt: string): Freshness {
    return {
      sourceId: this.id,
      institution: item.label,
      lastUpdatedAt: reqIsoInstant(body, 'lastUpdatedAt', 'pluggy.item'),
      observedAt,
      ...(hasQuotaWarning(body) ? { quotaExhausted: true } : {}),
    };
  }

  async fetchTransactions(since: Date): Promise<SourceTransaction[]> {
    if (this.kinds.size === 0) await this.fetchAccounts();
    const from = since.toISOString().slice(0, 10);
    const to = this.now().toISOString().slice(0, 10);
    const out: SourceTransaction[] = [];

    for (const [accountId, kind] of this.kinds) {
      // Two reads, merged by id. The date window sees status changes of recent rows (pending to posted). The ingestion
      // window sees rows Pluggy adds late but backdates, such as card bill payments dated to the bill close or merchants
      // that settle weeks later, which the date window silently misses.
      const seen = new Set<string>();
      for (const query of [`dateFrom=${from}&dateTo=${to}`, `createdAtFrom=${encodeURIComponent(since.toISOString())}`]) {
        let path = `/v2/transactions?accountId=${accountId}&${query}`;
        for (let page = 1; ; page++) {
          if (page > MAX_PAGES) throw new SourceFormatError(`pluggy.transactions: more than ${MAX_PAGES} pages for one account`);
          const body = asRecord(await this.get(path), 'pluggy.transactions');
          for (const raw of asArray(body.results, 'pluggy.transactions.results')) {
            const transaction = normalizeTransaction(raw, kind);
            if (seen.has(transaction.externalId)) continue;
            seen.add(transaction.externalId);
            out.push(transaction);
          }
          const next = optString(body, 'next');
          if (next === null) break;
          path = `/v2/transactions${next}`;
        }
      }
    }
    return out;
  }

  async fetchBills(): Promise<SourceBill[]> {
    if (this.kinds.size === 0) await this.fetchAccounts();
    const out: SourceBill[] = [];

    for (const [accountId, kind] of this.kinds) {
      if (kind !== 'credit_card') continue;
      for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw new SourceFormatError(`pluggy.bills: more than ${MAX_PAGES} pages for one account`);
        const body = asRecord(await this.get(`/bills?accountId=${accountId}&page=${page}`), 'pluggy.bills');
        for (const raw of asArray(body.results, 'pluggy.bills.results')) {
          out.push(normalizeBill(raw, accountId));
        }
        if (page >= reqNumber(body, 'totalPages', 'pluggy.bills')) break;
      }
    }
    return out;
  }

  /** The key exchange is never sent to the sink, so credentials stay out of the snapshots. */
  private async authenticate(): Promise<string> {
    const response = await this.http.request('POST', `${this.baseUrl}/auth`, {
      body: { clientId: this.config.clientId, clientSecret: this.config.clientSecret },
    });
    if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, `${this.baseUrl}/auth`);
    const body = asRecord(response.body, 'pluggy.auth');
    const key = optString(body, 'apiKey');
    if (key === null) throw new SourceFormatError('pluggy.auth.apiKey: expected a non-empty string');
    this.apiKey = key;
    return key;
  }

  /** Asks Pluggy to sync every item with its bank. Sent once per item and never retried, because each sync uses bank read quota. */
  async requestRefresh(): Promise<RefreshHandle> {
    let accepted = 0;
    const refused: string[] = [];
    for (const item of this.config.items) {
      const response = await this.call('PATCH', `/items/${item.itemId}`, {}, false);
      if (response.status >= 200 && response.status < 300) accepted++;
      // Meu Pluggy items cannot always be updated through the API: the user refreshes them in the Meu Pluggy app, and the next read picks it up.
      else refused.push(item.label);
    }
    if (accepted === 0) throw new Error(`Pluggy did not accept the refresh for ${refused.join(', ')}. Refresh these connections in the Meu Pluggy app; the next read will pick it up.`);
    return { requestedAt: this.now().toISOString() };
  }

  private async get(path: string, record = true): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.call('GET', path, undefined, record);
    if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, url);
    return response.body;
  }

  /** One authenticated call. A rejected cached key is renewed once. The caller decides what a non-2xx status means. */
  private async call(method: string, path: string, body: unknown, record: boolean): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}${path}`;
    let usedCachedKey = this.apiKey !== null;
    let key = this.apiKey ?? (await this.authenticate());
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.http.request(method, url, { headers: { 'X-API-KEY': key }, ...(body !== undefined ? { body } : {}) });
      if ((response.status === 401 || response.status === 403) && usedCachedKey) {
        usedCachedKey = false;
        key = await this.authenticate();
        continue;
      }
      if (record) this.sink({ endpoint: path, httpStatus: response.status, body: response.body });
      return response;
    }
    return { status: 403, body: null };
  }
}
