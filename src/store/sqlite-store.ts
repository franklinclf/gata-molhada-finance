import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountRef, CanonicalAccount, LimitGroup } from '../core/canonical.ts';
import type { AccountKind, Freshness, SourceAccount, SourceBill, SourceId, SourceTransaction, TransactionStatus } from '../core/types.ts';
import { currentVersion, migrate } from './migrations.ts';
import type {
  NewSnapshot,
  Snapshot,
  SourceRegistration,
  Store,
  StoredSourceAccount,
  StoredSourceBill,
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

    upsertFreshness(f: Freshness): void {
      db.prepare(
        `INSERT INTO freshness (source_id, institution, last_updated_at, observed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source_id, institution) DO UPDATE SET
           last_updated_at = excluded.last_updated_at, observed_at = excluded.observed_at`,
      ).run(f.sourceId, f.institution, f.lastUpdatedAt, f.observedAt);
    },

    listFreshness(): Freshness[] {
      const rows = db.prepare('SELECT * FROM freshness ORDER BY source_id, institution').all() as unknown as FreshnessRow[];
      return rows.map((r) => ({
        sourceId: r.source_id,
        institution: r.institution,
        lastUpdatedAt: r.last_updated_at,
        observedAt: r.observed_at,
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

    close(): void {
      db.close();
    },
  };
}
