import type { AdapterCapabilities, SourceAdapter } from '../../core/adapter.ts';
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

export class PluggyAdapter implements SourceAdapter {
  readonly id = 'pluggy';
  readonly capabilities: AdapterCapabilities = {
    refreshOnDemand: false,
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
      const itemBody = asRecord(await this.get(`/items/${item.itemId}`), 'pluggy.item');
      freshness.push({
        sourceId: this.id,
        institution: item.label,
        lastUpdatedAt: reqIsoInstant(itemBody, 'lastUpdatedAt', 'pluggy.item'),
        observedAt,
      });

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

  async fetchTransactions(since: Date): Promise<SourceTransaction[]> {
    if (this.kinds.size === 0) await this.fetchAccounts();
    const from = since.toISOString().slice(0, 10);
    const to = this.now().toISOString().slice(0, 10);
    const out: SourceTransaction[] = [];

    for (const [accountId, kind] of this.kinds) {
      let path = `/v2/transactions?accountId=${accountId}&dateFrom=${from}&dateTo=${to}`;
      for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw new SourceFormatError(`pluggy.transactions: more than ${MAX_PAGES} pages for one account`);
        const body = asRecord(await this.get(path), 'pluggy.transactions');
        for (const raw of asArray(body.results, 'pluggy.transactions.results')) {
          out.push(normalizeTransaction(raw, kind));
        }
        const next = optString(body, 'next');
        if (next === null) break;
        path = `/v2/transactions${next}`;
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

  private async get(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let usedCachedKey = this.apiKey !== null;
    let key = this.apiKey ?? (await this.authenticate());
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.http.request('GET', url, { headers: { 'X-API-KEY': key } });
      if ((response.status === 401 || response.status === 403) && usedCachedKey) {
        usedCachedKey = false;
        key = await this.authenticate();
        continue;
      }
      this.sink({ endpoint: path, httpStatus: response.status, body: response.body });
      if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, url);
      return response.body;
    }
    throw new SourceHttpError(403, url);
  }
}
