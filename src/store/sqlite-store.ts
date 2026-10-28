import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountRef, CanonicalAccount, CanonicalTransaction, Finding, LimitGroup, ManualMapping, RecordRef, TransactionLink, TransactionState } from '../core/canonical.ts';
import type { AccountKind, Freshness, SourceAccount, SourceBill, SourceId, SourceTransaction, TransactionStatus } from '../core/types.ts';
import { institutionKey } from '../core/names.ts';
import { localMonth } from '../core/time.ts';
import { currentVersion, migrate } from './migrations.ts';
import type {
  AiCategory,
  AiMatch,
  AiStatus,
  DeviceRecord,
  NewSnapshot,
  PasskeyRecord,
  SessionInfo,
  SessionStrength,
  Snapshot,
  SourceRegistration,
  Store,
  StoredSourceAccount,
  StoredSourceBill,
  RefreshLogEntry,
  RefreshStatus,
  StoredFinding,
  StoredSourceTransaction,
} from './store.ts';

interface SnapshotRow {
  id: number;
  source_id: string;
  endpoint: string;
  fetched_at: string;
  http_status: number;
  sha256: string;
  body: string;
}

interface FreshnessRow {
  source_id: string;
  institution: string;
  last_updated_at: string;
  observed_at: string;
  quota_exhausted: number;
}

interface RefreshRow {
  id: number;
  source_id: string;
  requested_at: string;
  finished_at: string | null;
  status: string;
  detail: string;
}

interface SourceAccountRow {
  source_id: string;
  external_id: string;
  external_item_id: string | null;
  institution: string;
  kind: string;
  name: string;
  last4: string | null;
  balance: number;
  credit_limit: number | null;
  available_limit: number | null;
  minimum_payment: number | null;
  due_date: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface SourceTransactionRow {
  source_id: string;
  external_id: string;
  account_external_id: string;
  occurred_at: string;
  amount: number;
  description: string;
  description_raw: string | null;
  status: string;
  installment_number: number | null;
  installment_total: number | null;
  category: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface SourceBillRow {
  source_id: string;
  external_id: string;
  account_external_id: string;
  due_date: string;
  closing_date: string | null;
  total: number;
  minimum_payment: number | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface CanonicalAccountRow {
  id: string;
  institution: string;
  kind: string;
  name: string;
  last4: string | null;
  balance: number;
  balance_source_id: string | null;
  balance_as_of: string | null;
  credit_limit: number | null;
  available_limit: number | null;
  minimum_payment: number | null;
  due_date: string | null;
  limit_group_id: string | null;
}

interface RefRow {
  source_id: string;
  external_id: string;
  account_id: string;
  role: string;
}

interface LimitGroupRow {
  id: string;
  institution: string;
  credit_limit: number;
}

interface TransactionRow {
  id: string;
  account_id: string;
  occurred_at: string;
  amount: number;
  description: string;
  description_raw: string | null;
  status: string;
  installment_number: number | null;
  installment_total: number | null;
  category: string | null;
  state: string;
  excluded: number;
}

interface FindingRow {
  id: string;
  kind: string;
  severity: string;
  account_id: string | null;
  transaction_id: string | null;
  summary: string;
  details: string;
  opened_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export function openSqliteStore(path: string, migrationsDir: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db, migrationsDir);

  function inTransaction(work: () => void): void {
    db.exec('BEGIN');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    schemaVersion: () => currentVersion(db),

    registerSource(source: SourceRegistration, now: string): void {
      db.prepare(
        `INSERT INTO sources (id, kind, active, capabilities, added_at) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, capabilities = excluded.capabilities`,
      ).run(source.id, source.kind, JSON.stringify(source.capabilities), now);
    },

    saveSnapshot(snapshot: NewSnapshot): number {
      const body = JSON.stringify(snapshot.body);
      const sha256 = createHash('sha256').update(body).digest('hex');
      const result = db
        .prepare(
          `INSERT INTO raw_snapshots (source_id, endpoint, fetched_at, http_status, sha256, body)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(snapshot.sourceId, snapshot.endpoint, snapshot.fetchedAt, snapshot.httpStatus, sha256, body);
      return Number(result.lastInsertRowid);
    },

    latestSnapshot(sourceId: SourceId, endpoint: string): Snapshot | null {
      const row = db
        .prepare(
          `SELECT * FROM raw_snapshots WHERE source_id = ? AND endpoint = ?
           ORDER BY fetched_at DESC, id DESC LIMIT 1`,
        )
        .get(sourceId, endpoint) as SnapshotRow | undefined;
      if (!row) return null;
      return {
        id: row.id,
        sourceId: row.source_id,
        endpoint: row.endpoint,
        fetchedAt: row.fetched_at,
        httpStatus: row.http_status,
        sha256: row.sha256,
        body: JSON.parse(row.body),
      };
    },

    upsertFreshness(f: Freshness): { changed: boolean; previous: string | null } {
      const row = db.prepare('SELECT last_updated_at FROM freshness WHERE source_id = ? AND institution = ?').get(f.sourceId, f.institution) as { last_updated_at: string } | undefined;
      const previous = row?.last_updated_at ?? null;
      inTransaction(() => {
        db.prepare(
          `INSERT INTO freshness (source_id, institution, last_updated_at, observed_at, quota_exhausted) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (source_id, institution) DO UPDATE SET
             last_updated_at = excluded.last_updated_at, observed_at = excluded.observed_at, quota_exhausted = excluded.quota_exhausted`,
        ).run(f.sourceId, f.institution, f.lastUpdatedAt, f.observedAt, f.quotaExhausted ? 1 : 0);
        db.prepare(
          `INSERT OR IGNORE INTO quota_events (source_id, institution_key, last_updated_at, observed_at, month) VALUES (?, ?, ?, ?, ?)`,
        ).run(f.sourceId, institutionKey(f.institution), f.lastUpdatedAt, f.observedAt, localMonth(f.lastUpdatedAt));
      });
      return { changed: previous !== f.lastUpdatedAt, previous };
    },

    quotaUsage(month: string): Array<{ institutionKey: string; events: number }> {
      const rows = db.prepare('SELECT institution_key, COUNT(*) AS events FROM quota_events WHERE month = ? GROUP BY institution_key ORDER BY institution_key').all(month) as unknown as Array<{ institution_key: string; events: number }>;
      return rows.map((r) => ({ institutionKey: r.institution_key, events: r.events }));
    },

    startRefresh(sourceId: SourceId, requestedAt: string): number {
      const result = db.prepare("INSERT INTO refresh_log (source_id, requested_at, status) VALUES (?, ?, 'requested')").run(sourceId, requestedAt);
      return Number(result.lastInsertRowid);
    },

    finishRefresh(id: number, finishedAt: string, status: RefreshStatus, detail: Record<string, unknown>): void {
      db.prepare('UPDATE refresh_log SET finished_at = ?, status = ?, detail = ? WHERE id = ?').run(finishedAt, status, JSON.stringify(detail), id);
    },

    lastRefresh(sourceId: SourceId): RefreshLogEntry | null {
      const r = db.prepare('SELECT * FROM refresh_log WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId) as RefreshRow | undefined;
      if (!r) return null;
      return {
        id: r.id,
        sourceId: r.source_id,
        requestedAt: r.requested_at,
        finishedAt: r.finished_at,
        status: r.status as RefreshStatus,
        detail: JSON.parse(r.detail) as Record<string, unknown>,
      };
    },

    listFreshness(): Freshness[] {
      const rows = db.prepare('SELECT * FROM freshness ORDER BY source_id, institution').all() as unknown as FreshnessRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        institution: r.institution,
        lastUpdatedAt: r.last_updated_at,
        observedAt: r.observed_at,
        ...(r.quota_exhausted === 1 ? { quotaExhausted: true } : {}),
      }));
    },

    upsertSourceAccounts(sourceId: SourceId, accounts: SourceAccount[], seenAt: string): void {
      const statement = db.prepare(
        `INSERT INTO source_accounts (source_id, external_id, external_item_id, institution, kind, name, last4, balance,
           credit_limit, available_limit, minimum_payment, due_date, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           external_item_id = excluded.external_item_id, institution = excluded.institution, kind = excluded.kind,
           name = excluded.name, last4 = excluded.last4, balance = excluded.balance, credit_limit = excluded.credit_limit,
           available_limit = excluded.available_limit, minimum_payment = excluded.minimum_payment,
           due_date = excluded.due_date, last_seen_at = excluded.last_seen_at`,
      );
      inTransaction(() => {
        for (const a of accounts) {
          statement.run(sourceId, a.externalId, a.externalItemId, a.institution, a.kind, a.name, a.last4, a.balance,
            a.creditLimit, a.availableLimit, a.minimumPayment, a.dueDate, seenAt, seenAt);
        }
      });
    },

    upsertSourceTransactions(sourceId: SourceId, transactions: SourceTransaction[], seenAt: string): void {
      const statement = db.prepare(
        `INSERT INTO source_transactions (source_id, external_id, account_external_id, occurred_at, amount, description,
           description_raw, status, installment_number, installment_total, category, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           account_external_id = excluded.account_external_id, occurred_at = excluded.occurred_at,
           amount = excluded.amount, description = excluded.description, description_raw = excluded.description_raw,
           status = excluded.status, installment_number = excluded.installment_number,
           installment_total = excluded.installment_total, category = excluded.category,
           last_seen_at = excluded.last_seen_at`,
      );
      inTransaction(() => {
        for (const t of transactions) {
          statement.run(sourceId, t.externalId, t.accountExternalId, t.occurredAt, t.amount, t.description,
            t.descriptionRaw, t.status, t.installment?.number ?? null, t.installment?.total ?? null, t.category,
            seenAt, seenAt);
        }
      });
    },

    upsertSourceBills(sourceId: SourceId, bills: SourceBill[], seenAt: string): void {
      const statement = db.prepare(
        `INSERT INTO source_bills (source_id, external_id, account_external_id, due_date, closing_date, total,
           minimum_payment, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           account_external_id = excluded.account_external_id, due_date = excluded.due_date,
           closing_date = excluded.closing_date, total = excluded.total, minimum_payment = excluded.minimum_payment,
           last_seen_at = excluded.last_seen_at`,
      );
      inTransaction(() => {
        for (const b of bills) {
          statement.run(sourceId, b.externalId, b.accountExternalId, b.dueDate, b.closingDate, b.total,
            b.minimumPayment, seenAt, seenAt);
        }
      });
    },

    listSourceAccounts(sourceId: SourceId): StoredSourceAccount[] {
      const rows = db.prepare('SELECT * FROM source_accounts WHERE source_id = ? ORDER BY external_id').all(sourceId) as unknown as SourceAccountRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        externalId: r.external_id,
        externalItemId: r.external_item_id,
        institution: r.institution,
        kind: r.kind as AccountKind,
        name: r.name,
        last4: r.last4,
        balance: r.balance,
        creditLimit: r.credit_limit,
        availableLimit: r.available_limit,
        minimumPayment: r.minimum_payment,
        dueDate: r.due_date,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
      }));
    },

    listSourceTransactions(sourceId: SourceId): StoredSourceTransaction[] {
      const rows = db.prepare('SELECT * FROM source_transactions WHERE source_id = ? ORDER BY occurred_at, external_id').all(sourceId) as unknown as SourceTransactionRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        externalId: r.external_id,
        accountExternalId: r.account_external_id,
        occurredAt: r.occurred_at,
        amount: r.amount,
        description: r.description,
        descriptionRaw: r.description_raw,
        status: r.status as TransactionStatus,
        installment: r.installment_number !== null && r.installment_total !== null
          ? { number: r.installment_number, total: r.installment_total }
          : null,
        category: r.category,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
      }));
    },

    listSourceBills(sourceId: SourceId): StoredSourceBill[] {
      const rows = db.prepare('SELECT * FROM source_bills WHERE source_id = ? ORDER BY due_date, external_id').all(sourceId) as unknown as SourceBillRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        externalId: r.external_id,
        accountExternalId: r.account_external_id,
        dueDate: r.due_date,
        closingDate: r.closing_date,
        total: r.total,
        minimumPayment: r.minimum_payment,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
      }));
    },

    replaceCanonicalAccounts(accounts: CanonicalAccount[], groups: LimitGroup[], builtAt: string): void {
      inTransaction(() => {
        db.exec('DELETE FROM account_source_refs');
        db.exec('DELETE FROM accounts');
        db.exec('DELETE FROM limit_groups');
        const insertGroup = db.prepare('INSERT INTO limit_groups (id, institution, credit_limit) VALUES (?, ?, ?)');
        for (const g of groups) insertGroup.run(g.id, g.institution, g.creditLimit);
        const insertAccount = db.prepare(
          `INSERT INTO accounts (id, institution, kind, name, last4, balance, balance_source_id, balance_as_of,
             credit_limit, available_limit, minimum_payment, due_date, limit_group_id, built_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertRef = db.prepare('INSERT INTO account_source_refs (source_id, external_id, account_id, role) VALUES (?, ?, ?, ?)');
        for (const a of accounts) {
          insertAccount.run(a.id, a.institution, a.kind, a.name, a.last4, a.balance, a.balanceSourceId, a.balanceAsOf,
            a.creditLimit, a.availableLimit, a.minimumPayment, a.dueDate, a.limitGroupId, builtAt);
          for (const r of a.refs) insertRef.run(r.sourceId, r.externalId, a.id, r.role);
        }
      });
    },

    listCanonicalAccounts(): CanonicalAccount[] {
      const rows = db.prepare('SELECT * FROM accounts ORDER BY institution, kind, name').all() as unknown as CanonicalAccountRow[];
      const refRows = db.prepare("SELECT * FROM account_source_refs ORDER BY account_id, CASE role WHEN 'member' THEN 0 ELSE 1 END, source_id, external_id").all() as unknown as RefRow[];
      const refsByAccount = new Map<string, AccountRef[]>();
      for (const r of refRows) {
        const list = refsByAccount.get(r.account_id) ?? [];
        list.push({ sourceId: r.source_id, externalId: r.external_id, role: r.role as AccountRef['role'] });
        refsByAccount.set(r.account_id, list);
      }
      return rows.map((r) => ({
        id: r.id,
        institution: r.institution,
        kind: r.kind as AccountKind,
        name: r.name,
        last4: r.last4,
        balance: r.balance,
        balanceSourceId: r.balance_source_id,
        balanceAsOf: r.balance_as_of,
        creditLimit: r.credit_limit,
        availableLimit: r.available_limit,
        minimumPayment: r.minimum_payment,
        dueDate: r.due_date,
        limitGroupId: r.limit_group_id,
        refs: refsByAccount.get(r.id) ?? [],
      }));
    },

    listLimitGroups(): LimitGroup[] {
      const rows = db.prepare('SELECT * FROM limit_groups ORDER BY id').all() as unknown as LimitGroupRow[];
      const members = db.prepare('SELECT id, limit_group_id FROM accounts WHERE limit_group_id IS NOT NULL ORDER BY id').all() as unknown as Array<{ id: string; limit_group_id: string }>;
      return rows.map((g) => ({
        id: g.id,
        institution: g.institution,
        creditLimit: g.credit_limit,
        memberIds: members.filter((m) => m.limit_group_id === g.id).map((m) => m.id),
      }));
    },

    replaceCanonicalTransactions(transactions: CanonicalTransaction[], links: TransactionLink[], builtAt: string): void {
      inTransaction(() => {
        db.exec('DELETE FROM transaction_links');
        db.exec('DELETE FROM transactions');
        const insertTx = db.prepare(
          `INSERT INTO transactions (id, account_id, occurred_at, amount, description, description_raw, status,
             installment_number, installment_total, category, state, excluded, built_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const t of transactions) {
          insertTx.run(t.id, t.accountId, t.occurredAt, t.amount, t.description, t.descriptionRaw, t.status,
            t.installment?.number ?? null, t.installment?.total ?? null, t.category, t.state, t.excluded ? 1 : 0, builtAt);
        }
        const insertLink = db.prepare('INSERT INTO transaction_links (source_id, external_id, transaction_id, match_pass) VALUES (?, ?, ?, ?)');
        for (const l of links) insertLink.run(l.sourceId, l.externalId, l.transactionId, l.matchPass);
      });
    },

    listCanonicalTransactions(options: { accountId?: string; includeExcluded?: boolean } = {}): CanonicalTransaction[] {
      const where: string[] = [];
      const params: string[] = [];
      if (options.accountId !== undefined) {
        where.push('account_id = ?');
        params.push(options.accountId);
      }
      if (!options.includeExcluded) where.push('excluded = 0');
      const sql = `SELECT * FROM transactions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC, id`;
      const rows = db.prepare(sql).all(...params) as unknown as TransactionRow[];
      const linkRows = db.prepare('SELECT source_id, transaction_id FROM transaction_links ORDER BY match_pass, source_id').all() as unknown as Array<{ source_id: string; transaction_id: string }>;
      const sourcesByTx = new Map<string, string[]>();
      for (const l of linkRows) sourcesByTx.set(l.transaction_id, [...(sourcesByTx.get(l.transaction_id) ?? []), l.source_id]);
      return rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        occurredAt: r.occurred_at,
        amount: r.amount,
        description: r.description,
        descriptionRaw: r.description_raw,
        status: r.status as TransactionStatus,
        installment: r.installment_number !== null && r.installment_total !== null ? { number: r.installment_number, total: r.installment_total } : null,
        category: r.category,
        state: r.state as TransactionState,
        sourceIds: sourcesByTx.get(r.id) ?? [],
        excluded: r.excluded === 1,
      }));
    },

    syncFindings(findings: Finding[], now: string): void {
      inTransaction(() => {
        const upsert = db.prepare(
          `INSERT INTO reconciliation_findings (id, kind, severity, account_id, transaction_id, summary, details, opened_at, last_seen_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (id) DO UPDATE SET
             severity = excluded.severity, summary = excluded.summary, details = excluded.details,
             last_seen_at = excluded.last_seen_at,
             opened_at = CASE WHEN reconciliation_findings.resolved_at IS NULL THEN reconciliation_findings.opened_at ELSE excluded.opened_at END,
             resolved_at = NULL`,
        );
        for (const f of findings) upsert.run(f.id, f.kind, f.severity, f.accountId, f.transactionId, f.summary, JSON.stringify(f.details), now, now);
        db.prepare('UPDATE reconciliation_findings SET resolved_at = ? WHERE resolved_at IS NULL AND last_seen_at <> ?').run(now, now);
      });
    },

    listFindings(options: { includeResolved?: boolean } = {}): StoredFinding[] {
      const sql = `SELECT * FROM reconciliation_findings${options.includeResolved ? '' : ' WHERE resolved_at IS NULL'} ORDER BY severity DESC, kind, id`;
      const rows = db.prepare(sql).all() as unknown as FindingRow[];
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind as Finding['kind'],
        severity: r.severity as Finding['severity'],
        accountId: r.account_id ?? '',
        transactionId: r.transaction_id ?? '',
        summary: r.summary,
        details: JSON.parse(r.details) as Record<string, unknown>,
        openedAt: r.opened_at,
        lastSeenAt: r.last_seen_at,
        resolvedAt: r.resolved_at,
      }));
    },

    createSession(tokenHash: string, createdAt: string, expiresAt: string, strength: SessionStrength = 'password', deviceId: string | null = null): void {
      db.prepare('INSERT INTO auth_sessions (token_hash, created_at, expires_at, strength, device_id) VALUES (?, ?, ?, ?, ?)').run(tokenHash, createdAt, expiresAt, strength, deviceId);
    },

    getSession(tokenHash: string, now: string): SessionInfo | null {
      const row = db.prepare('SELECT strength, device_id, created_at FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now) as { strength: string; device_id: string | null; created_at: string } | undefined;
      return row ? { strength: row.strength as SessionStrength, deviceId: row.device_id, createdAt: row.created_at } : null;
    },

    listPasskeys(): PasskeyRecord[] {
      const rows = db.prepare('SELECT * FROM auth_passkeys ORDER BY created_at').all() as Array<{ credential_id: string; name: string; public_key: string; alg: number; sign_count: number; transports: string; created_at: string; last_used_at: string | null }>;
      return rows.map((r) => ({ credentialId: r.credential_id, name: r.name, publicKey: r.public_key, alg: r.alg, signCount: r.sign_count, transports: JSON.parse(r.transports) as string[], createdAt: r.created_at, lastUsedAt: r.last_used_at }));
    },

    addPasskey(p: PasskeyRecord): void {
      db.prepare('INSERT INTO auth_passkeys (credential_id, name, public_key, alg, sign_count, transports, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(p.credentialId, p.name, p.publicKey, p.alg, p.signCount, JSON.stringify(p.transports), p.createdAt, p.lastUsedAt);
    },

    updatePasskeyUse(credentialId: string, signCount: number, usedAt: string): void {
      db.prepare('UPDATE auth_passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?').run(signCount, usedAt, credentialId);
    },

    deletePasskey(credentialId: string): boolean {
      return Number(db.prepare('DELETE FROM auth_passkeys WHERE credential_id = ?').run(credentialId).changes) === 1;
    },

    addDevice(d: DeviceRecord): void {
      db.prepare('INSERT INTO auth_devices (id, token_hash, name, created_at, last_used_at, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(d.id, d.tokenHash, d.name, d.createdAt, d.lastUsedAt, d.expiresAt, d.absoluteExpiresAt);
    },

    findDevice(tokenHash: string, now: string) {
      const r = db.prepare('SELECT * FROM auth_devices WHERE (token_hash = ? OR prev_token_hash = ?) AND expires_at > ? AND absolute_expires_at > ?').get(tokenHash, tokenHash, now, now) as { id: string; token_hash: string; name: string; created_at: string; last_used_at: string; expires_at: string; absolute_expires_at: string; rotated_at: string | null } | undefined;
      return r
        ? { id: r.id, tokenHash: r.token_hash, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at, absoluteExpiresAt: r.absolute_expires_at, via: r.token_hash === tokenHash ? ('current' as const) : ('previous' as const), rotatedAt: r.rotated_at }
        : null;
    },

    replaceDeviceToken(id: string, tokenHash: string, usedAt: string, expiresAt: string): void {
      db.prepare('UPDATE auth_devices SET prev_token_hash = token_hash, rotated_at = ?, token_hash = ?, last_used_at = ?, expires_at = ? WHERE id = ?').run(usedAt, tokenHash, usedAt, expiresAt, id);
    },

    setSessionDevice(sessionTokenHash: string, deviceId: string): void {
      db.prepare('UPDATE auth_sessions SET device_id = ? WHERE token_hash = ?').run(deviceId, sessionTokenHash);
    },

    listDevices(now: string): DeviceRecord[] {
      const rows = db.prepare('SELECT * FROM auth_devices WHERE expires_at > ? AND absolute_expires_at > ? ORDER BY created_at').all(now, now) as Array<{ id: string; token_hash: string; name: string; created_at: string; last_used_at: string; expires_at: string; absolute_expires_at: string }>;
      return rows.map((r) => ({ id: r.id, tokenHash: r.token_hash, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at, absoluteExpiresAt: r.absolute_expires_at }));
    },

    deleteDevice(id: string): boolean {
      return Number(db.prepare('DELETE FROM auth_devices WHERE id = ?').run(id).changes) === 1;
    },

    deleteSessionsOfDevice(deviceId: string): void {
      db.prepare('DELETE FROM auth_sessions WHERE device_id = ?').run(deviceId);
    },

    hasValidSession(tokenHash: string, now: string): boolean {
      return db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now) !== undefined;
    },

    deleteSession(tokenHash: string): void {
      db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
    },

    purgeExpiredSessions(now: string): void {
      db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    },

    isRecoveryCodeUsed(codeHash: string): boolean {
      return db.prepare('SELECT 1 FROM auth_used_recovery WHERE code_hash = ?').get(codeHash) !== undefined;
    },

    useRecoveryCode(codeHash: string, usedAt: string): boolean {
      const result = db.prepare('INSERT OR IGNORE INTO auth_used_recovery (code_hash, used_at) VALUES (?, ?)').run(codeHash, usedAt);
      return Number(result.changes) === 1;
    },

    getAuthState(key: string): string | null {
      const row = db.prepare('SELECT value FROM auth_state WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },

    setAuthState(key: string, value: string): void {
      db.prepare('INSERT INTO auth_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },

    listHiddenAccountIds(): Set<string> {
      const rows = db.prepare('SELECT account_id FROM account_prefs WHERE hidden = 1').all() as Array<{ account_id: string }>;
      return new Set(rows.map((r) => r.account_id));
    },

    setAccountHidden(accountId: string, hidden: boolean, now: string): void {
      db.prepare('INSERT INTO account_prefs (account_id, hidden, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET hidden = excluded.hidden, updated_at = excluded.updated_at').run(accountId, hidden ? 1 : 0, now);
    },

    listTransactionLinks(transactionId: string): Array<{ sourceId: SourceId; externalId: string; matchPass: number }> {
      const rows = db.prepare('SELECT source_id, external_id, match_pass FROM transaction_links WHERE transaction_id = ? ORDER BY match_pass, source_id').all(transactionId) as Array<{ source_id: string; external_id: string; match_pass: number }>;
      return rows.map((r) => ({ sourceId: r.source_id, externalId: r.external_id, matchPass: r.match_pass }));
    },

    listCategoryOverrides(): Map<string, string> {
      const rows = db
        .prepare('SELECT l.transaction_id AS id, o.category AS category FROM transaction_links l JOIN category_overrides o ON o.source_id = l.source_id AND o.external_id = l.external_id ORDER BY o.updated_at')
        .all() as Array<{ id: string; category: string }>;
      return new Map(rows.map((r) => [r.id, r.category]));
    },

    setCategoryOverride(transactionId: string, category: string | null, now: string): void {
      inTransaction(() => {
        const links = db.prepare('SELECT source_id, external_id FROM transaction_links WHERE transaction_id = ?').all(transactionId) as Array<{ source_id: string; external_id: string }>;
        for (const l of links) {
          if (category === null) db.prepare('DELETE FROM category_overrides WHERE source_id = ? AND external_id = ?').run(l.source_id, l.external_id);
          else db.prepare('INSERT INTO category_overrides (source_id, external_id, category, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(source_id, external_id) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at').run(l.source_id, l.external_id, category, now);
        }
      });
    },

    listCategoryRules(): Map<string, string> {
      const rows = db.prepare('SELECT match_key, category FROM category_rules').all() as Array<{ match_key: string; category: string }>;
      return new Map(rows.map((r) => [r.match_key, r.category]));
    },

    setCategoryRule(matchKey: string, category: string | null, now: string): void {
      if (category === null) db.prepare('DELETE FROM category_rules WHERE match_key = ?').run(matchKey);
      else db.prepare('INSERT INTO category_rules (match_key, category, updated_at) VALUES (?, ?, ?) ON CONFLICT(match_key) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at').run(matchKey, category, now);
    },

    listCustomCategories(): string[] {
      return (db.prepare('SELECT name FROM custom_categories ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name);
    },

    addCustomCategory(name: string, now: string): void {
      db.prepare('INSERT OR IGNORE INTO custom_categories (name, created_at) VALUES (?, ?)').run(name, now);
    },

    deleteCustomCategory(name: string): void {
      inTransaction(() => {
        db.prepare('DELETE FROM custom_categories WHERE name = ?').run(name);
        db.prepare('DELETE FROM category_overrides WHERE category = ?').run(name);
        db.prepare('DELETE FROM category_rules WHERE category = ?').run(name);
      });
    },

    listManualMapping(): ManualMapping {
      const pairs = (db.prepare('SELECT source_a, external_a, source_b, external_b FROM manual_links').all() as Array<{ source_a: string; external_a: string; source_b: string; external_b: string }>).map(
        (r): [RecordRef, RecordRef] => [{ sourceId: r.source_a, externalId: r.external_a }, { sourceId: r.source_b, externalId: r.external_b }],
      );
      const ignored = (db.prepare('SELECT source_id, external_id FROM ignored_records').all() as Array<{ source_id: string; external_id: string }>).map((r) => ({ sourceId: r.source_id, externalId: r.external_id }));
      return { pairs, ignored };
    },

    addManualLink(transactionA: string, transactionB: string, now: string, madeBy: 'user' | 'ai' = 'user'): boolean {
      const a = this.listTransactionLinks(transactionA);
      const b = this.listTransactionLinks(transactionB);
      if (a.length === 0 || b.length === 0 || a.some((x) => b.some((y) => y.sourceId === x.sourceId))) return false;
      inTransaction(() => {
        for (const x of a) {
          for (const y of b) {
            db.prepare('INSERT OR IGNORE INTO manual_links (source_a, external_a, source_b, external_b, created_at, made_by) VALUES (?, ?, ?, ?, ?, ?)').run(x.sourceId, x.externalId, y.sourceId, y.externalId, now, madeBy);
          }
        }
      });
      return true;
    },

    manualLinkMadeBy(transactionId: string): 'user' | 'ai' | null {
      const made = new Set<string>();
      for (const l of this.listTransactionLinks(transactionId)) {
        const rows = db.prepare('SELECT made_by FROM manual_links WHERE (source_a = ? AND external_a = ?) OR (source_b = ? AND external_b = ?)').all(l.sourceId, l.externalId, l.sourceId, l.externalId) as Array<{ made_by: string }>;
        for (const r of rows) made.add(r.made_by);
      }
      return made.has('user') ? 'user' : made.has('ai') ? 'ai' : null;
    },

    transactionOfRecord(sourceId: string, externalId: string): string | null {
      const row = db.prepare('SELECT transaction_id FROM transaction_links WHERE source_id = ? AND external_id = ?').get(sourceId, externalId) as { transaction_id: string } | undefined;
      return row ? row.transaction_id : null;
    },

    listAiMatches(): Map<string, AiMatch> {
      const rows = db.prepare('SELECT * FROM ai_matches').all() as Array<{ finding_id: string; verdict: string; confidence: string; action: string; model: string; sample_a: string; sample_b: string; source_a: string; external_a: string; decided_at: string }>;
      return new Map(rows.map((r) => [r.finding_id, { findingId: r.finding_id, verdict: r.verdict as AiMatch['verdict'], confidence: r.confidence as AiMatch['confidence'], action: r.action as AiMatch['action'], model: r.model, sampleA: r.sample_a, sampleB: r.sample_b, sourceA: r.source_a, externalA: r.external_a, decidedAt: r.decided_at }]));
    },

    saveAiMatch(m: AiMatch): void {
      db.prepare('INSERT INTO ai_matches (finding_id, verdict, confidence, action, model, sample_a, sample_b, source_a, external_a, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(finding_id) DO UPDATE SET verdict = excluded.verdict, confidence = excluded.confidence, action = excluded.action, model = excluded.model, decided_at = excluded.decided_at').run(
        m.findingId, m.verdict, m.confidence, m.action, m.model, m.sampleA, m.sampleB, m.sourceA, m.externalA, m.decidedAt,
      );
    },

    removeManualLinks(transactionId: string): void {
      inTransaction(() => {
        for (const l of this.listTransactionLinks(transactionId)) {
          db.prepare('DELETE FROM manual_links WHERE (source_a = ? AND external_a = ?) OR (source_b = ? AND external_b = ?)').run(l.sourceId, l.externalId, l.sourceId, l.externalId);
        }
      });
    },

    setTransactionIgnored(transactionId: string, ignored: boolean, now: string): void {
      inTransaction(() => {
        for (const l of this.listTransactionLinks(transactionId)) {
          if (ignored) db.prepare('INSERT OR IGNORE INTO ignored_records (source_id, external_id, ignored_at) VALUES (?, ?, ?)').run(l.sourceId, l.externalId, now);
          else db.prepare('DELETE FROM ignored_records WHERE source_id = ? AND external_id = ?').run(l.sourceId, l.externalId);
        }
      });
    },

    dismissFinding(findingId: string, now: string): void {
      db.prepare('INSERT OR IGNORE INTO dismissed_findings (finding_id, dismissed_at) VALUES (?, ?)').run(findingId, now);
    },

    listDismissedFindingIds(): Set<string> {
      return new Set((db.prepare('SELECT finding_id FROM dismissed_findings').all() as Array<{ finding_id: string }>).map((r) => r.finding_id));
    },

    deleteSourceTransactionsBefore(instant: string): number {
      return Number(db.prepare('DELETE FROM source_transactions WHERE occurred_at < ?').run(instant).changes);
    },

    listCycleOverrides(): Map<string, boolean> {
      const rows = db.prepare('SELECT account_id, cycle_key, settled FROM cycle_overrides').all() as Array<{ account_id: string; cycle_key: string; settled: number }>;
      return new Map(rows.map((r) => [`${r.account_id}|${r.cycle_key}`, r.settled === 1]));
    },

    setCycleOverride(accountId: string, cycleKey: string, settled: boolean | null, now: string): void {
      if (settled === null) db.prepare('DELETE FROM cycle_overrides WHERE account_id = ? AND cycle_key = ?').run(accountId, cycleKey);
      else db.prepare('INSERT INTO cycle_overrides (account_id, cycle_key, settled, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, cycle_key) DO UPDATE SET settled = excluded.settled, updated_at = excluded.updated_at').run(accountId, cycleKey, settled ? 1 : 0, now);
    },

    listAiCategories(): Map<string, AiCategory> {
      const rows = db.prepare('SELECT * FROM ai_categories').all() as Array<{ match_key: string; sample: string; category: string; confidence: string; status: string; model: string; taxonomy: string; decided_at: string }>;
      return new Map(rows.map((r) => [r.match_key, { matchKey: r.match_key, sample: r.sample, category: r.category, confidence: r.confidence as AiCategory['confidence'], status: r.status as AiStatus, model: r.model, taxonomy: r.taxonomy, decidedAt: r.decided_at }]));
    },

    saveAiCategory(entry: AiCategory): void {
      db.prepare('INSERT INTO ai_categories (match_key, sample, category, confidence, status, model, taxonomy, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(match_key) DO UPDATE SET sample = excluded.sample, category = excluded.category, confidence = excluded.confidence, status = excluded.status, model = excluded.model, taxonomy = excluded.taxonomy, decided_at = excluded.decided_at').run(
        entry.matchKey, entry.sample, entry.category, entry.confidence, entry.status, entry.model, entry.taxonomy, entry.decidedAt,
      );
    },

    setAiCategoryStatus(matchKey: string, status: AiStatus): void {
      db.prepare('UPDATE ai_categories SET status = ? WHERE match_key = ?').run(status, matchKey);
    },

    recordAiUsage(entry: { kind: string; model: string; items: number; costUsd: number; at: string }): void {
      db.prepare('INSERT INTO ai_usage (kind, model, items, cost_usd, at, month) VALUES (?, ?, ?, ?, ?, ?)').run(entry.kind, entry.model, entry.items, entry.costUsd, entry.at, localMonth(entry.at));
    },

    aiSpent(month: string): number {
      const row = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage WHERE month = ?').get(month) as { total: number };
      return row.total;
    },

    getSetting(key: string): string | null {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },

    setSetting(key: string, value: string, updatedAt: string): void {
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, value, updatedAt);
    },

    close(): void {
      db.close();
    },
  };
}
