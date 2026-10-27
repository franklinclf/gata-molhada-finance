import { createHash } from 'node:crypto';
import type {
  CanonicalAccount,
  CanonicalTransaction,
  Finding,
  FindingKind,
  FindingSeverity,
  TransactionLink,
  TransactionState,
} from '../core/canonical.ts';
import { formatBRL } from '../core/money.ts';
import type { Freshness, SourceId, SourceTransaction, TransactionStatus } from '../core/types.ts';
import { localDay } from '../core/time.ts';
import { institutionKey, normalizeName } from './names.ts';

export { localDay };

export interface TransactionSource {
  sourceId: SourceId;
  /** A lower number wins when two sources describe the same transaction. */
  priority: number;
  transactions: SourceTransaction[];
  freshness: Freshness[];
}

export interface TransactionInput {
  accounts: CanonicalAccount[];
  sources: TransactionSource[];
  now: Date;
  /**
   * Pending entries seen by only one source and older than this many days are set aside. A card purchase stays
   * pending until its statement closes, so cards get a longer limit. Defaults to 7 for bank accounts, 30 for cards.
   */
  staleDays?: { bank?: number; card?: number };
}

export interface TransactionStats {
  groups: number;
  byState: Record<TransactionState, number>;
  /** How many records were joined to an earlier source's record by each pass (index = pass number). */
  byPass: number[];
}

export interface TransactionReconciliation {
  transactions: CanonicalTransaction[];
  links: TransactionLink[];
  findings: Finding[];
  stats: TransactionStats;
}

interface Record_ {
  sourceId: SourceId;
  priority: number;
  tx: SourceTransaction;
  pass: number;
}

interface Group {
  records: Record_[];
}

const FUZZY_WINDOW_MS = 36 * 3_600_000;
const DAY_MS = 86_400_000;
const INSTALLMENT_SUFFIX = /\d{1,2}\s*\/\s*\d{1,2}\s*$/;

const descOf = (tx: SourceTransaction) => normalizeName(tx.descriptionRaw ?? tx.description);
const time = (tx: SourceTransaction) => new Date(tx.occurredAt).getTime();
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function primaryOf(group: Group): Record_ {
  return [...group.records].sort((a, b) => a.priority - b.priority)[0] as Record_;
}

type Predicate = (candidate: SourceTransaction, incoming: SourceTransaction) => boolean;

const PASSES: Array<{ pass: number; matches: Predicate; nearest?: boolean }> = [
  { pass: 1, matches: (g, t) => g.occurredAt === t.occurredAt && g.amount === t.amount && descOf(g) === descOf(t) },
  { pass: 2, matches: (g, t) => localDay(g.occurredAt) === localDay(t.occurredAt) && g.amount === t.amount && descOf(g) === descOf(t) },
  {
    // Installment purchases are dated by purchase in one source and by charge in the other.
    pass: 3,
    matches: (g, t) => {
      if (g.amount !== t.amount || descOf(g) !== descOf(t)) return false;
      const looksInstallment = (x: SourceTransaction) => x.installment !== null || INSTALLMENT_SUFFIX.test(x.descriptionRaw ?? x.description);
      if (!looksInstallment(g) && !looksInstallment(t)) return false;
      return g.installment === null || t.installment === null || g.installment.number === t.installment.number;
    },
  },
  {
    pass: 4,
    matches: (g, t) => g.amount === t.amount && Math.abs(time(g) - time(t)) <= FUZZY_WINDOW_MS,
    nearest: true,
  },
];

function joinSource(groups: Group[], source: TransactionSource, txs: SourceTransaction[]): void {
  let pending = [...txs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.externalId.localeCompare(b.externalId));
  const open = (g: Group) => !g.records.some((r) => r.sourceId === source.sourceId);

  for (const { pass, matches, nearest } of PASSES) {
    const rest: SourceTransaction[] = [];
    for (const tx of pending) {
      let best: Group | null = null;
      let bestGap = Infinity;
      for (const g of groups) {
        if (!open(g) || !matches(primaryOf(g).tx, tx)) continue;
        const gap = Math.abs(time(primaryOf(g).tx) - time(tx));
        if (!nearest) {
          best = g;
          break;
        }
        if (gap < bestGap) {
          best = g;
          bestGap = gap;
        }
      }
      if (best) best.records.push({ sourceId: source.sourceId, priority: source.priority, tx, pass });
      else rest.push(tx);
    }
    pending = rest;
  }
  for (const tx of pending) groups.push({ records: [{ sourceId: source.sourceId, priority: source.priority, tx, pass: 0 }] });
}

function freshnessOf(source: TransactionSource | undefined, institution: string): string | null {
  const wanted = institutionKey(institution);
  return source?.freshness.find((f) => institutionKey(f.institution) === wanted)?.lastUpdatedAt ?? null;
}

export function reconcileTransactions(input: TransactionInput): TransactionReconciliation {
  const staleDaysFor = (kind: CanonicalAccount['kind']) =>
    kind === 'credit_card' ? (input.staleDays?.card ?? 30) : (input.staleDays?.bank ?? 7);
  const sources = [...input.sources].sort((a, b) => a.priority - b.priority || a.sourceId.localeCompare(b.sourceId));
  const byId = new Map(sources.map((s) => [s.sourceId, s]));
  const coverageStart = new Map<SourceId, string | null>(
    sources.map((s) => [s.sourceId, s.transactions.reduce<string | null>((min, t) => (min === null || t.occurredAt < min ? t.occurredAt : min), null)]),
  );

  const transactions: CanonicalTransaction[] = [];
  const links: TransactionLink[] = [];
  const findings: Finding[] = [];
  const stats: TransactionStats = {
    groups: 0,
    byState: { confirmed: 0, single_source: 0, conflict: 0, stale_pending: 0 },
    byPass: [0, 0, 0, 0, 0],
  };

  const addFinding = (kind: FindingKind, severity: FindingSeverity, account: CanonicalAccount, transactionId: string, summary: string, details: Record<string, unknown>) => {
    findings.push({ id: `fd_${hash(`${kind}|${transactionId}`)}`, kind, severity, accountId: account.id, transactionId, summary, details });
  };

  for (const account of [...input.accounts].sort((a, b) => a.id.localeCompare(b.id))) {
    const memberRefs = account.refs.filter((r) => r.role === 'member');
    const present = sources.filter((s) => memberRefs.some((r) => r.sourceId === s.sourceId));
    if (present.length === 0) continue;

    const groups: Group[] = [];
    for (const source of present) {
      const externalIds = new Set(memberRefs.filter((r) => r.sourceId === source.sourceId).map((r) => r.externalId));
      const txs = source.transactions.filter((t) => externalIds.has(t.accountExternalId));
      if (groups.length === 0) {
        for (const tx of txs) groups.push({ records: [{ sourceId: source.sourceId, priority: source.priority, tx, pass: 0 }] });
      } else {
        joinSource(groups, source, txs);
      }
    }

    const keyed = groups.map((group) => {
      const primary = primaryOf(group).tx;
      return { group, primary, key: `${account.id}|${localDay(primary.occurredAt)}|${primary.amount}|${descOf(primary)}` };
    });
    keyed.sort((a, b) => a.key.localeCompare(b.key) || a.primary.occurredAt.localeCompare(b.primary.occurredAt) || a.primary.externalId.localeCompare(b.primary.externalId));
    const seen = new Map<string, number>();

    for (const { group, primary, key } of keyed) {
      const ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      const id = `tx_${hash(`${key}|${ordinal}`)}`;
      const records = [...group.records].sort((a, b) => a.priority - b.priority);
      const statuses = new Set(records.map((r) => r.tx.status));
      const status: TransactionStatus = statuses.has('posted') ? 'posted' : 'pending';
      const sourceIds = records.map((r) => r.sourceId);
      const firstNonNull = <T>(read: (t: SourceTransaction) => T | null): T | null => {
        for (const r of records) {
          const v = read(r.tx);
          if (v !== null) return v;
        }
        return null;
      };

      let state: TransactionState;
      if (records.length > 1) state = statuses.size > 1 ? 'conflict' : 'confirmed';
      else if (status === 'pending' && input.now.getTime() - time(primary) > staleDaysFor(account.kind) * DAY_MS) state = 'stale_pending';
      else state = 'single_source';

      transactions.push({
        id,
        accountId: account.id,
        occurredAt: primary.occurredAt,
        amount: primary.amount,
        description: primary.description,
        descriptionRaw: firstNonNull((t) => t.descriptionRaw),
        status,
        installment: firstNonNull((t) => t.installment),
        category: firstNonNull((t) => t.category),
        state,
        sourceIds,
        excluded: state === 'stale_pending',
      });
      stats.groups++;
      stats.byState[state]++;
      for (const r of records) {
        links.push({ sourceId: r.sourceId, externalId: r.tx.externalId, transactionId: id, matchPass: r.pass });
        stats.byPass[r.pass] = (stats.byPass[r.pass] ?? 0) + 1;
      }

      const label = `${account.institution} / ${account.name}: ${formatBRL(primary.amount)} on ${localDay(primary.occurredAt)} "${primary.descriptionRaw ?? primary.description}"`;
      const base = { occurredAt: primary.occurredAt, amount: primary.amount, sources: sourceIds };

      if (state === 'stale_pending') {
        addFinding('stale_pending', 'warning', account, id, `${label} is still pending after ${staleDaysFor(account.kind)} days and only ${sourceIds[0]} reports it`, base);
      } else if (state === 'conflict') {
        const lagging = records.find((r) => r.tx.status === 'pending') as Record_;
        const postedSource = records.find((r) => r.tx.status === 'posted') as Record_;
        const laggingAt = freshnessOf(byId.get(lagging.sourceId), account.institution);
        const postedAt = freshnessOf(byId.get(postedSource.sourceId), account.institution);
        const explained = laggingAt !== null && postedAt !== null && laggingAt < postedAt;
        addFinding('status_conflict', explained ? 'info' : 'warning', account, id,
          `${label} is pending in ${lagging.sourceId} and posted in ${postedSource.sourceId}${explained ? ` (${lagging.sourceId} synced earlier)` : ''}`,
          { ...base, pendingIn: lagging.sourceId, postedIn: postedSource.sourceId });
      } else if (state === 'single_source') {
        for (const other of present) {
          if (sourceIds.includes(other.sourceId)) continue;
          const start = coverageStart.get(other.sourceId) ?? null;
          if (start !== null && primary.occurredAt < start) continue;
          const syncedAt = freshnessOf(other, account.institution);
          if (syncedAt !== null && syncedAt < primary.occurredAt) {
            addFinding('not_yet_synced', 'info', account, id, `${label} is not in ${other.sourceId} yet (last sync ${syncedAt})`, { ...base, missingIn: other.sourceId, lastSyncAt: syncedAt });
          } else {
            addFinding('missing_in_source', 'warning', account, id, `${label} is in ${sourceIds[0]} but missing in ${other.sourceId}`, { ...base, missingIn: other.sourceId, lastSyncAt: syncedAt });
          }
        }
      }
    }
  }

  transactions.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return { transactions, links, findings, stats };
}
