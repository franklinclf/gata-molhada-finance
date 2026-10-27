import type { CanonicalAccount } from '../core/canonical.ts';
import type { Cents } from '../core/money.ts';
import { localDay } from '../core/time.ts';
import { DEFAULT_SOURCE_PRIORITY } from '../reconcile/run.ts';
import type { Store, StoredSourceBill } from '../store/store.ts';
import type { EffectiveTransaction } from './scope.ts';

export type CycleStatus = 'open' | 'paid' | 'partial' | 'unpaid' | 'overdue' | 'empty' | 'unknown';

/** One billing cycle of one card: from the day after the previous closing to the closing day. */
export interface Cycle {
  /** Month of the due date (YYYY-MM). Cards with different closing days line up on this key. */
  key: string;
  accountId: string;
  /** First and last local day of the cycle (the last one is the closing day). */
  from: string;
  to: string;
  dueDate: string;
  /** Total of the bill the issuer published, or null while the cycle is open. */
  billTotal: Cents | null;
  /** Purchases and fees posted in the cycle, and credits such as refunds. */
  charges: Cents;
  credits: Cents;
  /** Payments made from the closing day up to the day before the next closing. */
  paid: Cents;
  /** What is still owed on a closed cycle. */
  outstanding: Cents;
  status: CycleStatus;
}

const PAYMENT = /pagamento de cart|credit card payment|pagamento recebido/i;

export function isCardPayment(category: string | null): boolean {
  return category !== null && PAYMENT.test(category);
}

const TOLERANCE: Cents = 100;

function parseDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Same day of the month `n` months later, or the last day when the month is shorter. */
export function addMonthsToDay(day: string, n: number): string {
  const { y, m, d } = parseDay(day);
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return fmt(year, month, Math.min(d, last));
}

interface BillInfo {
  closing: string;
  due: string;
  total: Cents;
}

function billsOf(store: Store, account: CanonicalAccount): BillInfo[] {
  const rank = (sourceId: string) => {
    const i = DEFAULT_SOURCE_PRIORITY.indexOf(sourceId);
    return i < 0 ? DEFAULT_SOURCE_PRIORITY.length : i;
  };
  const byDueMonth = new Map<string, { bill: StoredSourceBill; rank: number }>();
  for (const sourceId of new Set(account.refs.map((r) => r.sourceId))) {
    const externalIds = new Set(account.refs.filter((r) => r.sourceId === sourceId).map((r) => r.externalId));
    for (const bill of store.listSourceBills(sourceId)) {
      if (!externalIds.has(bill.accountExternalId)) continue;
      const key = bill.dueDate.slice(0, 7);
      const current = byDueMonth.get(key);
      if (!current || rank(sourceId) < current.rank) byDueMonth.set(key, { bill, rank: rank(sourceId) });
    }
  }
  return [...byDueMonth.values()]
    .map(({ bill }) => ({ closing: bill.closingDate ?? addDays(bill.dueDate, -7), due: bill.dueDate, total: bill.total }))
    .sort((a, b) => a.closing.localeCompare(b.closing));
}

/** Payments of the card bill, with the same payment reported twice on the same day counted once. */
function paymentsOf(transactions: EffectiveTransaction[]): Array<{ day: string; amount: Cents }> {
  const seen = new Set<string>();
  const out: Array<{ day: string; amount: Cents }> = [];
  for (const t of transactions) {
    if (t.excluded || t.amount <= 0 || !isCardPayment(t.category)) continue;
    const day = localDay(t.occurredAt);
    const key = `${day}|${t.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, amount: t.amount });
  }
  return out;
}

/**
 * Cycles of one card, oldest first. The last one is the open cycle: it starts after the last published closing and
 * has no bill yet. `today` is a local day (YYYY-MM-DD).
 */
export function cyclesFor(store: Store, account: CanonicalAccount, transactions: EffectiveTransaction[], today: string): Cycle[] {
  const bills = billsOf(store, account);
  if (bills.length === 0) return [];
  const own = transactions.filter((t) => t.accountId === account.id && !t.excluded);
  // Before the first transaction we hold, no payment can be seen, so a bill from that time is not judged.
  const coverageStart = transactions.reduce<string | null>((min, t) => {
    const day = localDay(t.occurredAt);
    return min === null || day < min ? day : min;
  }, null);
  const payments = paymentsOf(own);

  const windows: Array<{ from: string; to: string; due: string; total: Cents | null }> = [];
  bills.forEach((bill, i) => {
    const previous = bills[i - 1];
    windows.push({ from: previous ? addDays(previous.closing, 1) : addDays(addMonthsToDay(bill.closing, -1), 1), to: bill.closing, due: bill.due, total: bill.total });
  });
  const last = bills[bills.length - 1]!;
  let openClosing = addMonthsToDay(last.closing, 1);
  let openDue = addMonthsToDay(last.due, 1);
  while (openClosing < today) {
    openClosing = addMonthsToDay(openClosing, 1);
    openDue = addMonthsToDay(openDue, 1);
  }
  windows.push({ from: addDays(last.closing, 1), to: openClosing, due: openDue, total: null });

  return windows.map((w, i) => {
    let charges = 0;
    let credits = 0;
    for (const t of own) {
      const day = localDay(t.occurredAt);
      if (day < w.from || day > w.to || isCardPayment(t.category)) continue;
      if (t.amount < 0) charges += -t.amount;
      else credits += t.amount;
    }
    const next = windows[i + 1];
    const paid = w.total === null ? 0 : payments.filter((p) => p.day >= w.to && (next === undefined || p.day < next.to)).reduce((s, p) => s + p.amount, 0);
    let status: CycleStatus;
    let outstanding = 0;
    if (w.total === null) status = 'open';
    else if (coverageStart === null || w.from < coverageStart) status = 'unknown';
    else {
      outstanding = Math.max(w.total - paid, 0);
      if (w.total === 0) status = 'empty';
      else if (outstanding <= TOLERANCE) status = 'paid';
      else status = w.due < today ? 'overdue' : paid > 0 ? 'partial' : 'unpaid';
      if (status === 'paid') outstanding = 0;
    }
    return { key: w.due.slice(0, 7), accountId: account.id, from: w.from, to: w.to, dueDate: w.due, billTotal: w.total, charges, credits, paid, outstanding, status };
  });
}
