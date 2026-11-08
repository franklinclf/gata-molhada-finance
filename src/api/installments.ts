import { createHash } from 'node:crypto';
import { dayNumber } from '../core/dates.ts';
import type { Cents } from '../core/money.ts';
import { normalizeName } from '../core/names.ts';
import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { addMonthsToDay, cyclesFor, type Cycle } from './cycles.ts';
import { effectiveTransactions, visibleAccounts, type EffectiveTransaction, type ViewOptions } from './scope.ts';
import { stamp, type Stamped } from './stamp.ts';

/**
 * paid: its bill was paid (or it is older than the data we hold). billed: the bill closed and is not paid yet.
 * open: charged in the cycle that is still open. future: not charged yet, planned for a later bill.
 */
export type InstallmentStatus = 'paid' | 'billed' | 'open' | 'future';

export interface InstallmentSlot {
  number: number;
  /** Due month (YYYY-MM) of the bill this installment is, or will be, charged in. */
  cycle: string;
  status: InstallmentStatus;
  /** True when no charge for this number was seen, so the month is worked out from the neighbours. */
  inferred: boolean;
  /** Local day of the charge, when it was seen. */
  day: string | null;
}

export interface InstallmentPurchase {
  id: string;
  accountId: string;
  card: string;
  description: string;
  total: number;
  amount: Cents;
  slots: InstallmentSlot[];
  paid: number;
  billed: number;
  open: number;
  future: number;
  /** Still to come or to pay: billed, open and future installments. */
  remaining: Cents;
  finished: boolean;
  /** Due month of the last installment. */
  lastCycle: string;
}

export interface MonthLoad {
  cycle: string;
  paid: Cents;
  billed: Cents;
  open: Cents;
  future: Cents;
  count: number;
}

export interface InstallmentsView extends Stamped {
  /** What the installments add to the open cycle, and to the next one. */
  thisCycle: Cents;
  nextCycle: Cents;
  /** Everything still to be paid, over all purchases. */
  remainingTotal: Cents;
  /** Per due month, from three months back to the last installment. */
  months: MonthLoad[];
  purchases: InstallmentPurchase[];
}

/** Some issuers write the installment into the description ("Store 5/6"), which would make every installment look like another purchase. */
export function seriesDescription(description: string): string {
  return description.replace(/\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/, '').trim();
}

/** Texts shorter than this are too generic to say that a longer one is the same purchase. */
const MIN_PREFIX = 8;
/** Days between an installment charge and the credit of the same amount that cancels it. */
const REFUND_DAYS = 3;

const seriesText = (description: string) => normalizeName(seriesDescription(description));

/** A refund text that holds the purchase text ("estorno magalu tv" for "magalu tv"), or the other way round. Very short texts say nothing. */
const namesSeries = (refund: string, series: string) => Math.min(refund.length, series.length) >= 4 && (refund.includes(series) || series.includes(refund));

/**
 * Installment charges cancelled by a credit of the same amount and text a few days later (a purchase refunded right away).
 * A cancelled purchase has no installments to come, so it must not plan any.
 */
export function refundedCharges(transactions: EffectiveTransaction[]): Set<string> {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const credits = transactions.filter((t) => !t.excluded && t.amount > 0 && t.role === null);
  const used = new Set<string>();
  const out = new Set<string>();
  for (const t of transactions) {
    if (!t.installment || t.excluded || t.amount >= 0) continue;
    const text = seriesText(t.description);
    // A refund the app already paired with this charge (an "estorno" can come days later, with another text) cancels it too. The
    // pairing of an "estorno" with the nearest purchase of the same amount is a guess, so it cancels the plan only when the owner
    // linked them, the refund names the purchase, or it returns the whole purchase (every installment).
    if (t.reversal?.side === 'charge' && t.reversal.amount >= -t.amount) {
      const refund = byId.get(t.reversal.otherId);
      const named = refund !== undefined && namesSeries(seriesText(refund.description), text);
      if (t.reversal.byUser || named || (refund?.amount ?? 0) >= -t.amount * t.installment.total - t.installment.total) {
        out.add(t.id);
        continue;
      }
    }
    const day = dayNumber(localDay(t.occurredAt));
    const credit = credits.find((c) => !used.has(c.id) && c.accountId === t.accountId && c.amount === -t.amount && Math.abs(dayNumber(localDay(c.occurredAt)) - day) <= REFUND_DAYS && (seriesText(c.description).startsWith(text) || text.startsWith(seriesText(c.description))));
    if (!credit) continue;
    used.add(credit.id);
    out.add(t.id);
  }
  return out;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function addMonthsToKey(key: string, n: number): string {
  return addMonthsToDay(`${key}-01`, n).slice(0, 7);
}

const monthIndex = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7));

function statusOf(cycle: Cycle | undefined): InstallmentStatus {
  if (!cycle) return 'paid';
  if (cycle.status === 'open') return 'open';
  if (cycle.status === 'paid' || cycle.status === 'rolled' || cycle.status === 'unknown' || cycle.status === 'empty') return 'paid';
  return 'billed';
}

/**
 * Installment purchases on the cards, one entry per purchase with every installment placed in the bill it belongs to.
 * The installments charged so far come from the transactions; the ones not charged yet are planned one month after
 * the other from the latest charge. Numbers that should exist between two charges but were not seen are placed by
 * counting months from their neighbours.
 */
export function installments(store: Store, now: Date, opts: ViewOptions = {}): InstallmentsView {
  const accounts = visibleAccounts(store, opts);
  const cardAccounts = accounts.filter((a) => a.kind === 'credit_card');
  const transactions = effectiveTransactions(store, opts, accounts);
  const today = localDay(now.toISOString());

  const refunded = refundedCharges(transactions);
  const series = new Map<string, EffectiveTransaction[]>();
  const shapes = new Map<string, { accountId: string; text: string; total: number; amount: Cents }>();
  for (const t of transactions) {
    if (!t.installment || t.excluded || t.installment.total < 2 || t.amount >= 0 || refunded.has(t.id)) continue;
    // 3 x 100,00 can be billed 33,34 / 33,33 / 33,33: amounts within one cent per instalment are the same purchase.
    const tolerance = t.installment.total;
    const text = seriesText(t.description);
    const same = (s: { accountId: string; total: number; amount: Cents }) => s.accountId === t.accountId && s.total === tolerance && Math.abs(s.amount - -t.amount) <= tolerance;
    let key: string | undefined;
    for (const [k, s] of shapes) if (same(s) && s.text === text) key = k;
    // A bank can change the text halfway (Nubank adds the store name to "Parcelamento de Compra"): a series whose text starts
    // like this one, with the same count and amount and without this number yet, is the same purchase.
    if (key === undefined) {
      for (const [k, s] of shapes) {
        const prefix = s.text.length >= MIN_PREFIX && text.length >= MIN_PREFIX && (s.text.startsWith(text) || text.startsWith(s.text));
        if (same(s) && prefix && !series.get(k)!.some((o) => o.installment!.number === t.installment!.number)) key = k;
      }
    }
    if (key === undefined) {
      key = `${t.accountId}|${seriesDescription(t.description)}|${tolerance}|${-t.amount}`;
      shapes.set(key, { accountId: t.accountId, text, total: tolerance, amount: -t.amount });
    }
    series.set(key, [...(series.get(key) ?? []), t]);
  }
  // The first installment sometimes comes as a plain charge, with no "1/3" on it: a charge with the series' text and amount
  // in the bill where a missing number falls is that installment, not something else to plan.
  const plain = transactions.filter((t) => !t.installment && !t.excluded && t.amount < 0 && t.role === null && !refunded.has(t.id));
  const usedPlain = new Set<string>();

  const purchases: InstallmentPurchase[] = [];
  for (const account of cardAccounts) {
    const cycles = cyclesFor(store, account, transactions, today);
    const byKey = new Map(cycles.map((c) => [c.key, c]));
    const openCycle = cycles.find((c) => c.status === 'open');
    const openKey = openCycle?.key;
    const cycleOfDay = (day: string) => cycles.find((c) => day >= c.from && day <= c.to);

    for (const [key, list] of series) {
      if (!key.startsWith(`${account.id}|`)) continue;
      const first = list[0]!;
      const total = first.installment!.total;
      const amount = -first.amount;

      // One charge per number; if a number repeats, the latest wins.
      // Meu Pluggy lists the installments still to come as pending charges dated in the future. They are in no bill yet,
      // so they are future installments, not paid ones: `ahead` is how many bills after the open one they fall.
      const seen = new Map<number, { cycle: Cycle | undefined; day: string; ahead: number }>();
      for (const t of [...list].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
        const day = localDay(t.occurredAt);
        const cycle = t.billCycle ? byKey.get(t.billCycle) : cycleOfDay(day);
        const ahead = !cycle && openCycle && day > openCycle.to ? Math.max(1, Math.ceil((dayNumber(day) - dayNumber(openCycle.to)) / 30.4375)) : 0;
        seen.set(t.installment!.number, { cycle, day, ahead });
      }
      const numbers = [...seen.keys()].sort((a, b) => a - b);
      // Month of a seen charge: its bill, or the month of its date when it falls before the first bill we know.
      const keyOf = (n: number) => {
        const s = seen.get(n)!;
        return s.cycle?.key ?? (s.ahead > 0 && openKey ? addMonthsToKey(openKey, s.ahead) : s.day.slice(0, 7));
      };
      // The seen charge nearest to a number (the earlier one on a tie) is the base to count months from.
      const nearest = (n: number) => numbers.reduce((best, m) => (Math.abs(m - n) < Math.abs(best - n) || (Math.abs(m - n) === Math.abs(best - n) && m < best) ? m : best), numbers[0]!);

      const slots: InstallmentSlot[] = [];
      for (let n = 1; n <= total; n++) {
        const s = seen.get(n);
        // Every installment is one bill after the previous one, so the month follows from the anchor.
        const base = nearest(n);
        const cycleKey = s ? keyOf(n) : addMonthsToKey(keyOf(base), n - base);
        if (s) {
          slots.push({ number: n, cycle: cycleKey, status: s.ahead > 0 ? 'future' : s.cycle ? statusOf(s.cycle) : 'paid', inferred: false, day: s.day });
        } else {
          const cycle = byKey.get(cycleKey);
          const text = seriesText(first.description);
          const twin = plain.find((p) => !usedPlain.has(p.id) && p.accountId === account.id && Math.abs(-p.amount - amount) <= total && seriesText(p.description).startsWith(text) && (p.billCycle ?? cycleOfDay(localDay(p.occurredAt))?.key) === cycleKey);
          if (twin) {
            usedPlain.add(twin.id);
            slots.push({ number: n, cycle: cycleKey, status: cycle ? statusOf(cycle) : 'paid', inferred: false, day: localDay(twin.occurredAt) });
            continue;
          }
          let status: InstallmentStatus;
          if (n < numbers[0]!) status = 'paid';
          else if (cycle) status = statusOf(cycle);
          else status = openKey !== undefined && monthIndex(cycleKey) > monthIndex(openKey) ? 'future' : 'paid';
          slots.push({ number: n, cycle: cycleKey, status, inferred: true, day: null });
        }
      }

      const count = (status: InstallmentStatus) => slots.filter((s) => s.status === status).length;
      const paid = count('paid');
      const billed = count('billed');
      const open = count('open');
      const future = count('future');
      purchases.push({
        id: `ip_${hash(key)}`,
        accountId: account.id,
        card: `${account.institution}${account.last4 ? ` •••• ${account.last4}` : ` ${account.name}`}`,
        description: seriesDescription(first.description),
        total,
        amount,
        slots,
        paid,
        billed,
        open,
        future,
        remaining: (billed + open + future) * amount,
        finished: billed + open + future === 0,
        lastCycle: slots[slots.length - 1]!.cycle,
      });
    }
  }
  purchases.sort((a, b) => Number(a.finished) - Number(b.finished) || b.remaining - a.remaining || a.description.localeCompare(b.description));

  const load = new Map<string, MonthLoad>();
  const minKey = addMonthsToKey(today.slice(0, 7), -3);
  for (const p of purchases) {
    for (const s of p.slots) {
      if (s.cycle < minKey) continue;
      const row = load.get(s.cycle) ?? { cycle: s.cycle, paid: 0, billed: 0, open: 0, future: 0, count: 0 };
      row[s.status] += p.amount;
      row.count += 1;
      load.set(s.cycle, row);
    }
  }
  const months = [...load.values()].sort((a, b) => a.cycle.localeCompare(b.cycle));

  const openCycleKeys = new Set<string>();
  for (const p of purchases) for (const s of p.slots) if (s.status === 'open') openCycleKeys.add(s.cycle);
  const thisKey = [...openCycleKeys].sort()[0] ?? today.slice(0, 7);
  const thisCycle = purchases.reduce((sum, p) => sum + p.slots.filter((s) => s.cycle === thisKey && s.status !== 'paid').length * p.amount, 0);
  const nextCycle = purchases.reduce((sum, p) => sum + p.slots.filter((s) => s.cycle === addMonthsToKey(thisKey, 1)).length * p.amount, 0);

  return { ...stamp(cardAccounts, now), thisCycle, nextCycle, remainingTotal: purchases.reduce((s, p) => s + p.remaining, 0), months, purchases };
}
