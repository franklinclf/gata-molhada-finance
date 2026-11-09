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

/** dd/mm of the local day, for texts the owner reads. */
const dayMonth = (instant: string): string => {
  const day = localDay(instant);
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
};

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
  /** Ids of bills due on or after `dataStart`. A card charge older than the start that sits on one of them is still used. */
  billsAfterStart?: Set<string>;
  /**
   * Due month (YYYY-MM) of every published bill, keyed `sourceId|billId`. Two sources' charges of the same amount on the
   * same statement are then joined whatever their dates and texts (a PDF of the bill prints the purchase day and the
   * city; the aggregator may print another day and text).
   */
  billMonths?: Map<string, string>;
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

/** The statement (due month) a record sits on, and whether that comes from a published bill (true) or only from the issuer's forecast. */
type StatementOf = (sourceId: SourceId, tx: SourceTransaction) => { month: string; published: boolean } | null;

/** Pass number of the statement join, which runs between passes 3 and 4. */
const BILL_PASS = 5;

const PASSES: Array<{ pass: number; matches: Predicate; nearest?: boolean; bill?: true }> = [
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
  // The same statement seen by two sources: an equal amount on the same bill is the same charge, whatever the day or text.
  { pass: BILL_PASS, matches: (g, t) => g.amount === t.amount, bill: true },
  {
    pass: 4,
    matches: (g, t) => g.amount === t.amount && Math.abs(time(g) - time(t)) <= FUZZY_WINDOW_MS,
    nearest: true,
  },
];

/**
 * Two records that name different published bills, or different installment numbers, are different charges, however
 * alike their day, amount and text: the installments of one purchase repeat the purchase day and the text on every bill.
 */
function compatible(group: Group, sourceId: SourceId, tx: SourceTransaction, statementOf: StatementOf): boolean {
  const mine = statementOf(sourceId, tx);
  return group.records.every((r) => {
    if (r.tx.installment && tx.installment && r.tx.installment.number !== tx.installment.number) return false;
    if (!mine?.published) return true;
    const theirs = statementOf(r.sourceId, r.tx);
    return !theirs?.published || theirs.month === mine.month;
  });
}

function joinSource(groups: Group[], source: TransactionSource, txs: SourceTransaction[], statementOf: StatementOf): void {
  let pending = [...txs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.externalId.localeCompare(b.externalId));
  const open = (g: Group) => !g.records.some((r) => r.sourceId === source.sourceId);
  const fits = (g: Group, tx: SourceTransaction) => open(g) && compatible(g, source.sourceId, tx, statementOf);

  for (const { pass, matches, nearest, bill } of PASSES) {
    if (bill) {
      pending = joinByStatement(groups, source, pending, statementOf, fits);
      continue;
    }
    const rest: SourceTransaction[] = [];
    for (const tx of pending) {
      let best: Group | null = null;
      let bestGap = Infinity;
      for (const g of groups) {
        if (!matches(primaryOf(g).tx, tx) || !fits(g, tx)) continue;
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

/**
 * Joins records that sit on the same statement with the same amount. At least one side must name a published bill (a
 * forecast on both sides proves nothing). The pairs closest in time are taken first over all records at once, so a
 * charge the other source lacks does not take the twin of a later one of the same amount.
 */
function joinByStatement(groups: Group[], source: TransactionSource, txs: SourceTransaction[], statementOf: StatementOf, fits: (g: Group, tx: SourceTransaction) => boolean): SourceTransaction[] {
  const pairs: Array<{ tx: SourceTransaction; group: Group; gap: number; order: string }> = [];
  for (const tx of txs) {
    const mine = statementOf(source.sourceId, tx);
    if (mine === null) continue;
    for (const group of groups) {
      const primary = primaryOf(group);
      if (primary.tx.amount !== tx.amount || !fits(group, tx)) continue;
      const same = group.records.some((r) => {
        const theirs = statementOf(r.sourceId, r.tx);
        return theirs !== null && theirs.month === mine.month && (theirs.published || mine.published);
      });
      if (same) pairs.push({ tx, group, gap: Math.abs(time(primary.tx) - time(tx)), order: `${primary.tx.occurredAt}|${primary.tx.externalId}` });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.tx.occurredAt.localeCompare(b.tx.occurredAt) || a.tx.externalId.localeCompare(b.tx.externalId) || a.order.localeCompare(b.order));
  const joined = new Set<SourceTransaction>();
  const taken = new Set<Group>();
  for (const { tx, group } of pairs) {
    if (joined.has(tx) || taken.has(group)) continue;
    group.records.push({ sourceId: source.sourceId, priority: source.priority, tx, pass: BILL_PASS });
    joined.add(tx);
    taken.add(group);
  }
  return txs.filter((t) => !joined.has(t));
}

function freshnessOf(source: TransactionSource | undefined, institution: string): string | null {
  const wanted = institutionKey(institution);
  return source?.freshness.find((f) => institutionKey(f.institution) === wanted)?.lastUpdatedAt ?? null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * The text a record that only a later source has should show. Where both sources have a charge, the later source's
 * text is known to stand for the first source's (a PDF statement writes the merchant one way, Pluggy another). A lone
 * record of the later source takes that text when the pairing is unambiguous on this card, so the installments of one
 * purchase, its rules and its merchant read as one whichever source brought each month. The id still comes from the
 * record's own text, so it does not move.
 */
function textAdopter(groups: Group[], firstSourceId: SourceId | undefined): (r: Record_) => string {
  const learned = new Map<string, Set<string>>();
  const suffixed = new Map<string, boolean>();
  for (const g of groups) {
    if (g.records.length < 2) continue;
    const primary = primaryOf(g);
    const base = primary.tx.description.replace(INSTALLMENT_SUFFIX, '').trim();
    if (base === '') continue;
    for (const r of g.records) {
      if (r === primary) continue;
      const key = `${r.sourceId}|${descOf(r.tx)}`;
      learned.set(key, (learned.get(key) ?? new Set()).add(base));
      suffixed.set(`${key}|${base}`, INSTALLMENT_SUFFIX.test(primary.tx.description));
    }
  }
  return (r) => {
    if (r.sourceId === firstSourceId) return r.tx.description;
    const key = `${r.sourceId}|${descOf(r.tx)}`;
    const texts = learned.get(key);
    if (!texts || texts.size !== 1) return r.tx.description;
    const base = [...texts][0] as string;
    const n = r.tx.installment;
    return suffixed.get(`${key}|${base}`) && n ? `${base} ${pad2(n.number)}/${pad2(n.total)}` : base;
  };
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
  const statementOf: StatementOf = (sourceId, tx) => {
    const billId = tx.parties?.billId;
    const month = billId ? input.billMonths?.get(`${sourceId}|${billId}`) : undefined;
    if (month !== undefined) return { month, published: true };
    return tx.parties?.billForecast ? { month: tx.parties.billForecast, published: false } : null;
  };

  for (const account of [...input.accounts].sort((a, b) => a.id.localeCompare(b.id))) {
    const memberRefs = account.refs.filter((r) => r.role === 'member');
    const present = sources.filter((s) => memberRefs.some((r) => r.sourceId === s.sourceId));
    if (present.length === 0) continue;

    const groups: Group[] = [];
    for (const source of present) {
      const externalIds = new Set(memberRefs.filter((r) => r.sourceId === source.sourceId).map((r) => r.externalId));
      const txs = source.transactions.filter((t) => externalIds.has(t.accountExternalId) && (input.dataStart === undefined || localDay(t.occurredAt) >= input.dataStart || (t.parties?.billId != null && input.billsAfterStart?.has(t.parties.billId) === true)));
      if (groups.length === 0) {
        for (const tx of txs) groups.push({ records: [{ sourceId: source.sourceId, priority: source.priority, tx, pass: 0 }] });
      } else {
        joinSource(groups, source, txs, statementOf);
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

    const adopt = textAdopter(groups, present[0]?.sourceId);
    const keyed = groups.map((group) => {
      const primary = primaryOf(group).tx;
      return { group, primary, key: `${account.id}|${localDay(primary.occurredAt)}|${primary.amount}|${descOf(primary)}` };
    });
    keyed.sort((a, b) => a.key.localeCompare(b.key) || a.primary.occurredAt.localeCompare(b.primary.occurredAt) || a.primary.externalId.localeCompare(b.primary.externalId));
    const seen = new Map<string, number>();
    // The published bill each row sits on, so a pair the bills tell apart is never offered as the same transaction.
    const billOf = new Map<string, string>();

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

      // A source rarely says "posted" unless the bank did, and one source can keep things pending long after the bank
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
        description: records.length === 1 ? adopt(records[0] as Record_) : primary.description,
        descriptionRaw: firstNonNull((t) => t.descriptionRaw),
        status,
        installment: firstNonNull((t) => t.installment),
        category: firstNonNull((t) => t.category),
        state,
        sourceIds,
        excluded: state === 'stale_pending' || state === 'ignored',
      });
      const bill = records.map((r) => statementOf(r.sourceId, r.tx)).find((b) => b?.published);
      if (bill) billOf.set(id, bill.month);
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
        if (billOf.has(o.id) && billOf.has(t.id) && billOf.get(o.id) !== billOf.get(t.id)) continue;
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
        `${account.institution} / ${account.name}: ${formatBRL(first.amount)} "${first.description}" (${first.sourceIds[0]}, ${dayMonth(first.occurredAt)}) pode ser o mesmo lançamento que "${second.description}" (${second.sourceIds[0]}, ${dayMonth(second.occurredAt)})`,
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
