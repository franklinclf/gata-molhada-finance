import type { CanonicalAccount } from '../core/canonical.ts';
import type { Cents } from '../core/money.ts';
import { addDays, dayNumber } from '../core/dates.ts';
import { normalizeName } from '../core/names.ts';
import { localDay } from '../core/time.ts';
import { sourcePriority } from '../reconcile/run.ts';
import type { Store, StoredSourceBill } from '../store/store.ts';
import type { EffectiveTransaction } from './scope.ts';

/** rolled: part of the bill was not paid and every later bill was paid in full, so the rest most likely rolled over into the next bill. */
export type CycleStatus = 'open' | 'paid' | 'rolled' | 'partial' | 'unpaid' | 'overdue' | 'empty' | 'unknown';

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
  /**
   * A leftover on a closed bill that is not counted as owed. `by: 'auto'`: the app guesses it rolled over into the next
   * bill (the bank adds the unpaid part to the following statement), so counting it again would be a double count; the
   * status is `rolled`, not `paid`. `by: 'manual'`: the owner called it settled, and the status is `paid`.
   */
  adjusted: { amount: Cents; by: 'auto' | 'manual' } | null;
}

export const isCardPayment = (t: { role: string | null }): boolean => t.role === 'card_payment';

const TOLERANCE: Cents = 100;

function parseDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export { addDays };

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
  const order = sourcePriority(store);
  const rank = (sourceId: string) => {
    const i = order.indexOf(sourceId);
    return i < 0 ? order.length : i;
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

const SAME_PAYMENT_DAYS = 3;
/** Days after an expected closing during which a missing bill is read as "not published yet", not as a closed month. */
const PUBLISH_GRACE_DAYS = 7;

/**
 * Payments of the card bill. The same payment reported twice on the same day counts once, and so does a pending copy
 * and a posted copy of one payment a few days apart (Meu Pluggy shows the bank's pending debit and the card's posted
 * credit, and they can fall on different days when the payment is made late on a Friday).
 */
function paymentsOf(transactions: EffectiveTransaction[]): Array<{ day: string; amount: Cents }> {
  const seen = new Map<string, Array<{ sources: string[]; status: string; text: string }>>();
  const out: Array<{ day: string; amount: Cents; status: string; merged: boolean }> = [];
  for (const t of transactions) {
    if (t.excluded || t.amount <= 0 || !isCardPayment(t)) continue;
    const day = localDay(t.occurredAt);
    const key = `${day}|${t.amount}`;
    // The same payment shows up again when another source, the pending copy, or the other leg (the bank's own text, "PAGTO. POR DEB
    // EM C/C", next to "Pagamento recebido") reports it. Two payments of one source with the same text, amount and day are two payments.
    const text = normalizeName(t.description);
    const earlier = seen.get(key) ?? [];
    if (earlier.some((e) => e.status !== t.status || e.text !== text || !e.sources.some((s) => t.sourceIds.includes(s)))) continue;
    seen.set(key, [...earlier, { sources: t.sourceIds, status: t.status, text }]);
    const twin = out.find((o) => !o.merged && o.amount === t.amount && o.status !== t.status && Math.abs(dayNumber(o.day) - dayNumber(day)) <= SAME_PAYMENT_DAYS);
    if (twin) {
      // Keep the posted copy's day, which is the one the card shows.
      if (t.status === 'posted') twin.day = day;
      twin.merged = true;
      continue;
    }
    out.push({ day, amount: t.amount, status: t.status, merged: false });
  }
  return out.map(({ day, amount }) => ({ day, amount }));
}

/**
 * Cycles of one card, oldest first. The last one is the open cycle: it starts after the last published closing and
 * has no bill yet. `today` is a local day (YYYY-MM-DD).
 */
export function cyclesFor(store: Store, account: CanonicalAccount, transactions: EffectiveTransaction[], today: string): Cycle[] {
  const bills = billsOf(store, account);
  if (bills.length === 0) return [];
  const own = transactions.filter((t) => t.accountId === account.id && !t.excluded);
  // Before the first transaction this card has, no payment can be seen, so a bill from that time is not judged. Another
  // account's history does not count: a card added later would otherwise have its older bills judged overdue.
  const coverageStart = own.reduce<string | null>((min, t) => {
    const day = localDay(t.occurredAt);
    return min === null || day < min ? day : min;
  }, null);
  const payments = paymentsOf(own);

  const windows: Array<{ from: string; to: string; due: string; total: Cents | null; open: boolean }> = [];
  bills.forEach((bill, i) => {
    const previous = bills[i - 1];
    // A month the issuer published no bill for (the list skips it, or the bill is not out yet) still closed on the same
    // day, so it gets its own window instead of being folded into the next cycle.
    if (previous) {
      const months = monthsBetween(previous.closing, bill.closing);
      for (let k = 1; k < months; k++) {
        const closing = addMonthsToDay(previous.closing, k);
        windows.push({ from: addDays(addMonthsToDay(previous.closing, k - 1), 1), to: closing, due: addMonthsToDay(previous.due, k), total: null, open: false });
      }
    }
    windows.push({ from: previous ? addDays(windows[windows.length - 1]!.to, 1) : addDays(addMonthsToDay(bill.closing, -1), 1), to: bill.closing, due: bill.due, total: bill.total, open: false });
  });
  const last = bills[bills.length - 1]!;
  let steps = 1;
  let closing = addMonthsToDay(last.closing, steps);
  // The bank publishes a bill a few days after it closes. Until then (or until the grace passes) that month stays the open cycle.
  while (addDays(closing, PUBLISH_GRACE_DAYS) < today) {
    windows.push({ from: addDays(windows[windows.length - 1]!.to, 1), to: closing, due: addMonthsToDay(last.due, steps), total: null, open: false });
    steps++;
    closing = addMonthsToDay(last.closing, steps);
  }
  // The estimate of the closing day can be off by a few days (banks move it to a business day). The issuer's own word about where the
  // newest charges go is better: when charges made by today already belong to the bill after this one, this one has closed.
  const placedOn = (due: string) => own.some((t) => t.billByBank && t.billCycle === due.slice(0, 7) && !isCardPayment(t) && localDay(t.occurredAt) <= today);
  while (placedOn(addMonthsToDay(last.due, steps + 1))) {
    windows.push({ from: addDays(windows[windows.length - 1]!.to, 1), to: closing, due: addMonthsToDay(last.due, steps), total: null, open: false });
    steps++;
    closing = addMonthsToDay(last.closing, steps);
  }
  windows.push({ from: addDays(windows[windows.length - 1]!.to, 1), to: closing < today ? today : closing, due: addMonthsToDay(last.due, steps), total: null, open: true });

  const cycles: Cycle[] = windows.map((w, i) => {
    let charges = 0;
    let credits = 0;
    for (const t of own) {
      const day = localDay(t.occurredAt);
      if (isCardPayment(t)) continue;
      // The owner can move a charge to another bill; otherwise it follows its date.
      if (t.billCycle ? t.billCycle !== w.due.slice(0, 7) : day < w.from || day > w.to) continue;
      if (t.amount < 0) charges += -t.amount;
      else credits += t.amount;
    }
    const next = windows[i + 1];
    const paid = w.open ? 0 : payments.filter((p) => p.day >= w.to && (next === undefined || p.day < next.to)).reduce((s, p) => s + p.amount, 0);
    let status: CycleStatus;
    let outstanding = 0;
    if (w.open) status = 'open';
    // A closed month with no published bill cannot be judged: the payments are shown, the amount owed is not guessed.
    else if (w.total === null || coverageStart === null || w.from < coverageStart) status = 'unknown';
    else {
      outstanding = Math.max(w.total - paid, 0);
      if (w.total === 0) status = 'empty';
      else if (outstanding <= TOLERANCE) status = 'paid';
      else status = w.due < today ? 'overdue' : paid > 0 ? 'partial' : 'unpaid';
      if (status === 'paid') outstanding = 0;
    }
    return { key: w.due.slice(0, 7), accountId: account.id, from: w.from, to: w.to, dueDate: w.due, billTotal: w.total, charges, credits, paid, outstanding, status, adjusted: null };
  });
  return settleLeftovers(store, account.id, cycles, today);
}

/** Whole months from one day to another. Closing days drift by a day or two (30/09 then 01/11 is one month), so this rounds by length. */
function monthsBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 / 30.4375);
}

const WRITE_OFF_AFTER_DAYS = 30;
const WRITE_OFF_MAX_SHARE = 0.25;

/**
 * A small leftover on an old bill, with every later bill paid in full, was never charged: if the issuer still wanted
 * it, the later bills (or the balance) would carry it and the user would have been unable to pay them in full. So it is
 * written off automatically. The user can overrule this either way from the bill history.
 */
function settleLeftovers(store: Store, accountId: string, cycles: Cycle[], today: string): Cycle[] {
  const overrides = store.listCycleOverrides();
  for (let i = cycles.length - 1; i >= 0; i--) {
    const c = cycles[i]!;
    if (c.billTotal === null || c.outstanding <= 0 || (c.status !== 'overdue' && c.status !== 'unpaid' && c.status !== 'partial')) continue;
    const word = overrides.get(`${accountId}|${c.key}`);
    let by: 'auto' | 'manual' | null = null;
    if (word === true) by = 'manual';
    else if (word === undefined) {
      const later = cycles.slice(i + 1).filter((x) => x.billTotal !== null && x.status !== 'open' && x.status !== 'unknown' && x.status !== 'empty' && x.status !== 'rolled');
      if (c.dueDate < addDays(today, -WRITE_OFF_AFTER_DAYS) && c.outstanding <= c.billTotal * WRITE_OFF_MAX_SHARE && later.length >= 1 && later.every((x) => x.outstanding <= TOLERANCE)) by = 'auto';
    }
    if (by !== null) {
      c.adjusted = { amount: c.outstanding, by };
      c.outstanding = 0;
      // A guess is not a payment: the leftover most likely rolled into the next bill, and the screens say so.
      c.status = by === 'auto' ? 'rolled' : 'paid';
    }
  }
  return cycles;
}
