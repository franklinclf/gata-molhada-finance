import type { Cents } from '../core/money.ts';
import { DATA_START, localDay } from '../core/time.ts';
import type { Store, StoredFinding } from '../store/store.ts';
import { cyclesFor } from './cycles.ts';
import { detectRecurring, recurringKeyOf } from './recurring.ts';
import { seriesDescription } from './installments.ts';
import { effectiveTransactions, ruleKey, type EffectiveTransaction } from './scope.ts';

export interface SourceRecord {
  sourceId: string;
  externalId: string;
  matchPass: number;
  /** What this source reported for the transaction, or null if the record is no longer in its data. */
  record: {
    occurredAt: string;
    amount: Cents;
    description: string;
    descriptionRaw: string | null;
    status: string;
    category: string | null;
    installment: { number: number; total: number } | null;
    firstSeenAt: string;
    lastSeenAt: string;
  } | null;
}

export interface TransactionDetail {
  transaction: EffectiveTransaction;
  account: { id: string; institution: string; name: string; last4: string | null; kind: string; hidden: boolean };
  sources: SourceRecord[];
  /** Other installments of the same purchase on the same card. */
  installments: Array<{ id: string; day: string; number: number; total: number; amount: Cents }>;
  /** Everything with the same description, on any account. */
  merchant: { key: string; count: number; total: Cents; firstDay: string | null; lastDay: string | null; recent: Array<{ id: string; day: string; amount: Cents; category: string | null }> };
  /** Billing cycle the transaction falls in, for card transactions. */
  cycle: { key: string; from: string; to: string; dueDate: string; status: string } | null;
  /** What the app and the owner say about this merchant's charges coming back: its key, the owner's word, and whether the app detected it. */
  recurrence: { key: string; name: string; label: 'subscription' | 'recurring' | 'none' | null; detected: boolean; detectedLabel: 'subscription' | 'recurring' | null };
  /** The bills of this card the charge can be moved to, newest first. Empty for anything but a card charge. */
  cycleOptions: Array<{ key: string; from: string; to: string; dueDate: string; status: string }>;
  /** The owner moved the charge to this bill, or set its status by hand. */
  cycleByUser: boolean;
  /** The issuer placed the charge on this bill (its id, or the month it expects), so the date does not decide. */
  cycleByBank: boolean;
  /** The purchase or refund this one is paired with, and the opposite-sign transactions of the account it could be paired with instead. */
  reversal: { side: 'charge' | 'refund'; byUser: boolean; partial: boolean; amount: Cents; other: { id: string; day: string; title: string; amount: Cents } | null } | null;
  reversalCandidates: Array<{ id: string; day: string; title: string; amount: Cents }>;
  statusByUser: boolean;
  findings: StoredFinding[];
  /** The category rule that applies to this description, if there is one. */
  rule: { category: string } | null;
  /** True when the records of this transaction were joined by the user, so "separate" makes sense. */
  joinedByHand: boolean;
  /** Who made the join: the user, or the AI (which the user can undo). */
  joinedBy: 'user' | 'ai' | null;
  /** True when the installment shown was set by the user, not delivered by the source. */
  installmentByUser: boolean;
}

export function transactionDetail(store: Store, id: string, now: Date): TransactionDetail | null {
  const accounts = store.listCanonicalAccounts();
  const all = effectiveTransactions(store, { includeHidden: true, includeExcluded: true }, accounts);
  const brief = (t: EffectiveTransaction | undefined) => (t ? { id: t.id, day: localDay(t.occurredAt), title: t.title, amount: t.amount } : null);
  const transaction = all.find((t) => t.id === id);
  if (!transaction) return null;
  if (localDay(transaction.occurredAt) < DATA_START && !(transaction.billCycle && transaction.billCycle >= DATA_START.slice(0, 7))) return null;
  const account = accounts.find((a) => a.id === transaction.accountId);
  if (!account) return null;

  const sources: SourceRecord[] = store.listTransactionLinks(id).map((link) => {
    const found = store.listSourceTransactions(link.sourceId).find((t) => t.externalId === link.externalId);
    return {
      sourceId: link.sourceId,
      externalId: link.externalId,
      matchPass: link.matchPass,
      record: found
        ? {
            occurredAt: found.occurredAt,
            amount: found.amount,
            description: found.description,
            descriptionRaw: found.descriptionRaw,
            status: found.status,
            category: found.category,
            installment: found.installment,
            firstSeenAt: found.firstSeenAt,
            lastSeenAt: found.lastSeenAt,
          }
        : null,
    };
  });

  const installments = transaction.installment
    ? all
        .filter((t) => t.accountId === transaction.accountId && !t.excluded && t.installment?.total === transaction.installment!.total && seriesDescription(t.description) === seriesDescription(transaction.description) && t.amount === transaction.amount)
        .map((t) => ({ id: t.id, day: localDay(t.occurredAt), number: t.installment!.number, total: t.installment!.total, amount: -t.amount }))
        .sort((a, b) => a.number - b.number)
    : [];

  const key = ruleKey(transaction.description);
  const same = all.filter((t) => !t.excluded && ruleKey(t.description) === key).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const days = same.map((t) => localDay(t.occurredAt));

  let cycle: TransactionDetail['cycle'] = null;
  let cycleOptions: TransactionDetail['cycleOptions'] = [];
  if (account.kind === 'credit_card') {
    const day = localDay(transaction.occurredAt);
    const cycles = cyclesFor(store, account, all, localDay(now.toISOString()));
    const found = transaction.billCycle ? cycles.find((c) => c.key === transaction.billCycle) : cycles.find((c) => day >= c.from && day <= c.to);
    if (found) cycle = { key: found.key, from: found.from, to: found.to, dueDate: found.dueDate, status: found.status };
    cycleOptions = [...cycles].reverse().slice(0, 12).map((c) => ({ key: c.key, from: c.from, to: c.to, dueDate: c.dueDate, status: c.status }));
  }

  const rule = store.listCategoryRules().get(key);
  const manual = store.listManualMapping();
  const joinedByHand = sources.some((s) => manual.pairs.some(([a, b]) => (a.sourceId === s.sourceId && a.externalId === s.externalId) || (b.sourceId === s.sourceId && b.externalId === s.externalId)));
  return {
    transaction,
    account: { id: account.id, institution: account.institution, name: account.name, last4: account.last4, kind: account.kind, hidden: store.listHiddenAccountIds().has(account.id) },
    sources,
    installments,
    merchant: {
      key,
      count: same.length,
      total: same.reduce((s, t) => s - t.amount, 0),
      firstDay: days[days.length - 1] ?? null,
      lastDay: days[0] ?? null,
      recent: same.slice(0, 6).map((t) => ({ id: t.id, day: localDay(t.occurredAt), amount: t.amount, category: t.category })),
    },
    cycle,
    recurrence: recurrenceOf(store, transaction, now),
    cycleOptions,
    cycleByUser: transaction.billCycle !== null && !transaction.billByBank,
    cycleByBank: transaction.billByBank,
    reversal: transaction.reversal
      ? { side: transaction.reversal.side, byUser: transaction.reversal.byUser, partial: transaction.reversal.partial, amount: transaction.reversal.amount, other: brief(all.find((t) => t.id === transaction.reversal!.otherId)) }
      : null,
    reversalCandidates: all
      .filter((t) => t.accountId === transaction.accountId && t.id !== transaction.id && t.amount !== 0 && t.amount > 0 !== transaction.amount > 0 && !t.excluded && t.role === null && Math.abs(Date.parse(t.occurredAt) - Date.parse(transaction.occurredAt)) <= 180 * 86_400_000 && (transaction.amount < 0 ? t.occurredAt >= transaction.occurredAt : t.occurredAt <= transaction.occurredAt))
      .sort((a, b) => Math.abs(Date.parse(a.occurredAt) - Date.parse(transaction.occurredAt)) - Math.abs(Date.parse(b.occurredAt) - Date.parse(transaction.occurredAt)))
      .slice(0, 25)
      .map((t) => brief(t)!),
    statusByUser: transaction.statusByUser,
    findings: store.listFindings({ includeResolved: false }).filter((f) => f.transactionId === id),
    rule: rule !== undefined ? { category: rule } : null,
    joinedByHand,
    joinedBy: store.manualLinkMadeBy(id),
    installmentByUser: store.listInstallmentOverrides().has(id),
  };
}

function recurrenceOf(store: Store, t: Parameters<typeof recurringKeyOf>[0], now: Date): TransactionDetail['recurrence'] {
  const key = recurringKeyOf(t);
  const mark = store.listRecurringMarks().get(key) ?? null;
  const ignored = store.listRecurringIgnored().has(key);
  const found = detectRecurring(store, now, { includeHidden: true }).find((i) => i.key === key);
  return { key, name: key.slice(key.indexOf('|') + 1), label: mark ?? (ignored ? 'none' : null), detected: found !== undefined && !found.manual, detectedLabel: found && !found.manual ? found.label : null };
}
