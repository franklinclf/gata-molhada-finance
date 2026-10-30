import { createHash } from 'node:crypto';
import type {
  CanonicalAccount,
  CanonicalTransaction,
  Finding,
  FindingKind,
  FindingSeverity,
  ManualMapping,
  RecordRef,
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
   * A pending entry that only one source reports, and is older than this many days, is set aside: what is left is
   * a source that never updated or an authorization that never settled. Defaults to 7.
   */
  staleDays?: number;
  /** Local day (YYYY-MM-DD). Records dated before it are not used at all. */
  dataStart?: string;
  manual?: ManualMapping;
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
const SUPERSEDED_WINDOW_DAYS = 5;
const POSSIBLE_MATCH_DAYS = 5;
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
  const staleDays = input.staleDays ?? 7;
  const refKey = (sourceId: string, externalId: string) => `${sourceId}|${externalId}`;
  const ignored = new Set((input.manual?.ignored ?? []).map((r) => refKey(r.sourceId, r.externalId)));
  const sources = [...input.sources].sort((a, b) => a.priority - b.priority || a.sourceId.localeCompare(b.sourceId));
  const byId = new Map(sources.map((s) => [s.sourceId, s]));

  const transactions: CanonicalTransaction[] = [];
  const links: TransactionLink[] = [];
  const findings: Finding[] = [];
  const stats: TransactionStats = {
    groups: 0,
    byState: { confirmed: 0, single_source: 0, conflict: 0, stale_pending: 0, billed: 0, ignored: 0 },
    byPass: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };

  const addFinding = (kind: FindingKind, severity: FindingSeverity, account: CanonicalAccount, transactionId: string, summary: string, details: Record<string, unknown>) => {
    findings.push({ id: `fd_${hash(`${kind}|${transactionId}|${String(details.otherTransactionId ?? '')}`)}`, kind, severity, accountId: account.id, transactionId, summary, details });
  };

  for (const account of [...input.accounts].sort((a, b) => a.id.localeCompare(b.id))) {
    const memberRefs = account.refs.filter((r) => r.role === 'member');
    const present = sources.filter((s) => memberRefs.some((r) => r.sourceId === s.sourceId));
    if (present.length === 0) continue;

    const groups: Group[] = [];
    for (const source of present) {
      const externalIds = new Set(memberRefs.filter((r) => r.sourceId === source.sourceId).map((r) => r.externalId));
      const txs = source.transactions.filter((t) => externalIds.has(t.accountExternalId) && (input.dataStart === undefined || localDay(t.occurredAt) >= input.dataStart));
      if (groups.length === 0) {
        for (const tx of txs) groups.push({ records: [{ sourceId: source.sourceId, priority: source.priority, tx, pass: 0 }] });
      } else {
        joinSource(groups, source, txs);
      }
    }

    // Records the user joined by hand. A group never holds two records from the same source.
    for (const [a, b] of input.manual?.pairs ?? []) {
      const find = (ref: RecordRef) => groups.find((g) => g.records.some((r) => r.sourceId === ref.sourceId && r.tx.externalId === ref.externalId));
      const ga = find(a);
      const gb = find(b);
      if (!ga || !gb || ga === gb || ga.records.some((r) => gb.records.some((q) => q.sourceId === r.sourceId))) continue;
      ga.records.push(...gb.records.map((r) => ({ ...r, pass: 9 })));
      groups.splice(groups.indexOf(gb), 1);
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

      // A source rarely says "posted" unless the bank did, and Pierre often keeps things pending long after the bank
      // posted them. So one posted report is enough, and sources are never in conflict over the status.
      let state: TransactionState;
      if (records.some((r) => ignored.has(refKey(r.sourceId, r.tx.externalId)))) state = 'ignored';
      // When both sources say pending, the bank itself does (card purchases stay pending until the statement closes).
      // A card is the exception for a lone source: Meu Pluggy keeps every purchase of the open statement pending until it
      // closes, so a pending card charge is real however old it looks. Only bank accounts set old pending entries aside.
      else if (status === 'pending' && records.length === 1 && account.kind !== 'credit_card' && input.now.getTime() - time(primary) > staleDays * DAY_MS) state = 'stale_pending';
      else state = records.length > 1 ? 'confirmed' : 'single_source';

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
        excluded: state === 'stale_pending' || state === 'ignored',
      });
      for (const r of records) {
        links.push({ sourceId: r.sourceId, externalId: r.tx.externalId, transactionId: id, matchPass: r.pass });
        stats.byPass[r.pass] = (stats.byPass[r.pass] ?? 0) + 1;
      }
    }

    const mine = transactions.filter((t) => t.accountId === account.id);

    // A pending entry whose posted twin is already there (same amount, a few days apart) is the authorization that
    // settled, seen separately because the sources never joined them. It is not a second charge.
    // Each posted twin settles at most one pending entry, and only one that another source reported.
    const settled = new Set<string>();
    for (const t of mine) {
      if (t.status !== 'pending' || t.sourceIds.length > 1 || t.state === 'ignored' || t.state === 'stale_pending') continue;
      const twin = mine.find(
        (o) => o !== t && o.status === 'posted' && o.state !== 'ignored' && !settled.has(o.id) && o.amount === t.amount && !o.sourceIds.includes(t.sourceIds[0] ?? '') && Math.abs(new Date(o.occurredAt).getTime() - new Date(t.occurredAt).getTime()) <= SUPERSEDED_WINDOW_DAYS * DAY_MS,
      );
      if (twin) {
        settled.add(twin.id);
        t.state = 'stale_pending';
        t.excluded = true;
      }
    }

    // Records that look like the same transaction in two sources but were too far apart to join on their own.
    const loose = mine.filter((t) => t.state === 'single_source').sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    const used = new Set<string>();
    for (const t of loose) {
      if (used.has(t.id)) continue;
      let best: CanonicalTransaction | null = null;
      let bestGap = Infinity;
      for (const o of loose) {
        if (o === t || used.has(o.id) || o.sourceIds[0] === t.sourceIds[0] || o.amount !== t.amount) continue;
        const gap = Math.abs(new Date(o.occurredAt).getTime() - new Date(t.occurredAt).getTime());
        if (gap <= POSSIBLE_MATCH_DAYS * DAY_MS && gap < bestGap) {
          best = o;
          bestGap = gap;
        }
      }
      if (!best) continue;
      used.add(t.id);
      used.add(best.id);
      const rank = (x: CanonicalTransaction) => byId.get(x.sourceIds[0] ?? '')?.priority ?? 99;
      const [first, second] = rank(t) <= rank(best) ? [t, best] : [best, t];
      addFinding(
        'possible_match',
        'info',
        account,
        first.id,
        `${account.institution} / ${account.name}: ${formatBRL(first.amount)} "${first.description}" in ${first.sourceIds[0]} on ${localDay(first.occurredAt)} may be the same as "${second.description}" in ${second.sourceIds[0]} on ${localDay(second.occurredAt)}`,
        { occurredAt: first.occurredAt, amount: first.amount, sources: [first.sourceIds[0], second.sourceIds[0]], otherTransactionId: second.id },
      );
    }
  }

  for (const key of Object.keys(stats.byState) as TransactionState[]) stats.byState[key] = 0;
  stats.groups = transactions.length;
  for (const t of transactions) stats.byState[t.state]++;

  transactions.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return { transactions, links, findings, stats };
}
