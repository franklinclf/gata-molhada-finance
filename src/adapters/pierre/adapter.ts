import type { AdapterCapabilities, RefreshHandle, SourceAdapter } from '../../core/adapter.ts';
import { SourceFormatError, SourceHttpError, type HttpClient, type SnapshotSink } from '../../core/http.ts';
import type { Freshness, SourceAccount, SourceBill, SourceTransaction } from '../../core/types.ts';
import { asRecord, optString, reqIsoInstant, UnsupportedAccountError } from '../shape.ts';
import { dataArray, extractCardCredit, normalizeAccount, normalizeBill, normalizeTransaction } from './normalize.ts';

export interface PierreConfig {
  apiKey: string;
}

export interface PierreDeps {
  http: HttpClient;
  sink: SnapshotSink;
  now?: () => Date;
  baseUrl?: string;
}

/** Days of recent transactions read to learn each card's current limit. */
const CREDIT_LOOKBACK_DAYS = 90;

export class PierreAdapter implements SourceAdapter {
  readonly id = 'pierre';
  readonly capabilities: AdapterCapabilities = {
    refreshOnDemand: true,
    pendingTransactions: true,
    creditLimits: true,
    rawDescription: true,
    installments: true,
  };

  private readonly config: PierreConfig;
  private readonly http: HttpClient;
  private readonly sink: SnapshotSink;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private warnings: string[] = [];

  constructor(config: PierreConfig, deps: PierreDeps) {
    this.config = config;
    this.http = deps.http;
    this.sink = deps.sink;
    this.now = deps.now ?? (() => new Date());
    this.baseUrl = deps.baseUrl ?? 'https://www.pierre.finance/tools/api';
  }

  drainWarnings(): string[] {
    const out = this.warnings;
    this.warnings = [];
    return out;
  }

  async fetchAccounts(): Promise<{ accounts: SourceAccount[]; freshness: Freshness[] }> {
    const rawAccounts = dataArray(await this.get('get-accounts'), 'pierre.accounts');
    const since = new Date(this.now().getTime() - CREDIT_LOOKBACK_DAYS * 86_400_000);
    const credit = extractCardCredit(await this.rawTransactions(since));

    const accounts: SourceAccount[] = [];
    for (const raw of rawAccounts) {
      try {
        accounts.push(normalizeAccount(raw, credit.get(optString(asRecord(raw, 'pierre.account'), 'id') ?? '')));
      } catch (error) {
        if (!(error instanceof UnsupportedAccountError)) throw error;
        this.warnings.push(`skipped an account (${error.message})`);
      }
    }
    return { accounts, freshness: this.freshnessFrom(rawAccounts) };
  }

  /** One light read of the account list. Manual accounts have no connector and are left out. */
  async fetchFreshness(): Promise<Freshness[]> {
    return this.freshnessFrom(dataArray(await this.get('get-accounts', false), 'pierre.accounts'));
  }

  private freshnessFrom(rawAccounts: unknown[]): Freshness[] {
    const observedAt = this.now().toISOString();
    const byConnector = new Map<string, Freshness>();
    for (const raw of rawAccounts) {
      const record = asRecord(raw, 'pierre.account');
      const connector = optString(record, 'connectorName');
      if (connector === null || byConnector.has(connector)) continue;
      byConnector.set(connector, {
        sourceId: this.id,
        institution: connector,
        lastUpdatedAt: reqIsoInstant(record, 'itemLastUpdatedAt', 'pierre.account'),
        observedAt,
      });
    }
    return [...byConnector.values()];
  }

  async fetchTransactions(since: Date): Promise<SourceTransaction[]> {
    const out: SourceTransaction[] = [];
    for (const raw of await this.rawTransactions(since)) {
      try {
        out.push(normalizeTransaction(raw));
      } catch (error) {
        if (!(error instanceof UnsupportedAccountError)) throw error;
        this.warnings.push(`skipped a transaction (${error.message})`);
      }
    }
    return out;
  }

  async fetchBills(): Promise<SourceBill[]> {
    return dataArray(await this.get('get-bills'), 'pierre.bills').map(normalizeBill);
  }

  /** Starts a sync of every connected bank. It is sent once and never retried, because it uses bank request quota. */
  async requestRefresh(): Promise<RefreshHandle> {
    const url = `${this.baseUrl}/manual-update`;
    const response = await this.http.request('POST', url, { headers: this.headers() });
    this.sink({ endpoint: 'manual-update', httpStatus: response.status, body: response.body });
    if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, url);
    if (asRecord(response.body, 'pierre.manual-update').success !== true) {
      throw new SourceFormatError('pierre.manual-update.success: expected true');
    }
    return { requestedAt: this.now().toISOString() };
  }

  private rawTransactions(since: Date): Promise<unknown[]> {
    const start = since.toISOString().slice(0, 10);
    const end = this.now().toISOString().slice(0, 10);
    return this.get(`get-transactions?startDate=${start}&endDate=${end}&format=raw&includeStatus=POSTED,PENDING`).then(
      (body) => dataArray(body, 'pierre.transactions'),
    );
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` };
  }

  private async get(path: string, record = true): Promise<unknown> {
    const url = `${this.baseUrl}/${path}`;
    const response = await this.http.request('GET', url, { headers: this.headers() });
    if (record) this.sink({ endpoint: path, httpStatus: response.status, body: response.body });
    if (response.status < 200 || response.status >= 300) throw new SourceHttpError(response.status, url);
    return response.body;
  }
}
