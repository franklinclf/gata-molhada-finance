import { createHash } from 'node:crypto';
import { dayNumber } from '../core/dates.ts';
import type { Cents } from '../core/money.ts';
import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { addMonthsToDay, cyclesFor, type Cycle } from './cycles.ts';
import { effectiveTransactions, visibleAccounts, type EffectiveTransaction, type ViewOptions } from './scope.ts';
import { stamp, type Stamped } from './stamp.ts';
import { namedTitle, titleOf } from '../core/title.ts';
import { groupSeries, seriesDescription, seriesText } from './series.ts';

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
  /** The bank text of the purchase, without the installment number. */
  description: string;
  /** The name the owner gave the purchase, shown instead of `description`; null when it has none. */
  customName: string | null;
  /** Ids of the charges seen for this purchase. */
  memberIds: string[];
  /** Category of the charges seen for this purchase (the most common one), which the estimated installments take. */
  category: string | null;
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

export { seriesDescription };

/** Days between an installment charge and the credit of the same amount that cancels it. */
const REFUND_DAYS = 3;
/** Days after a refunded installment with no later number charged that show the purchase was cancelled (two bills have closed since). */
const STOPPED_AFTER_DAYS = 75;

/** A refund text that holds the purchase text ("estorno magalu tv" for "magalu tv"), or the other way round. Very short texts say nothing. */
const namesSeries = (refund: string, series: string) => Math.min(refund.length, series.length) >= 4 && (refund.includes(series) || series.includes(refund));

/**
 * Installment charges cancelled by a credit of the same amount and text a few days later (a purchase refunded right away).
 * A cancelled purchase has no installments to come, so it must not plan any.
 */
export function refundedCharges(transactions: EffectiveTransaction[], today?: string): Set<string> {
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
      // Or when the purchase stopped there: no later number of it was charged, although two bills have closed since.
      const later = transactions.some((o) => o.id !== t.id && o.accountId === t.accountId && !o.excluded && o.installment?.total === t.installment!.total && o.installment.number > t.installment!.number && Math.abs(o.amount - t.amount) <= t.installment!.total && namesSeries(seriesText(o.description), text));
      const stopped = today !== undefined && !later && dayNumber(today) - dayNumber(localDay(t.occurredAt)) >= STOPPED_AFTER_DAYS;
      if (t.reversal.byUser || named || stopped || (refund?.amount ?? 0) >= -t.amount * t.installment.total - t.installment.total) {
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

/** The category most of the charges have; the first one seen wins a tie. */
function commonCategory(list: EffectiveTransaction[]): string | null {
  const counts = new Map<string, number>();
  for (const t of list) if (t.category !== null) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  let best: string | null = null;
  for (const [name, n] of counts) if (best === null || n > counts.get(best)!) best = name;
  return best;
}

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
export function installments(store: Store, now: Date, opts: ViewOptions = {}, loaded?: EffectiveTransaction[]): InstallmentsView {
  const accounts = visibleAccounts(store, opts);
  const cardAccounts = accounts.filter((a) => a.kind === 'credit_card');
  // A caller that already holds the transactions (read with the same options, excluded ones left out) passes them, to read the store once.
  const transactions = loaded ?? effectiveTransactions(store, opts, accounts);
  const today = localDay(now.toISOString());

  const refunded = refundedCharges(transactions, today);
  const series = groupSeries(transactions, refunded);
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
        customName: list.find((t) => t.customName !== null)?.customName ?? null,
        memberIds: list.map((t) => t.id),
        category: commonCategory(list),
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

/** Id prefix of the synthetic transactions below. */
export const ESTIMATED_PREFIX = 'est_';

const estimatedId = (purchase: InstallmentPurchase, number: number) => `${ESTIMATED_PREFIX}${purchase.id}_${number}`;

/**
 * Installments the bank bills but never listed as a transaction (the `inferred` slots above) as read-only transactions, so analyses
 * by transaction do not miss them. Each one sits on the card, is a charge of the installment amount, has the category of the
 * purchase's seen charges and the date of the nearest seen charge moved by whole months into the bill of its slot.
 *
 * Bill totals already add these installments from the plan (`cards`, `cycles`, `bill-check`), so the rows are only for the screens
 * that list or add up transactions (Transações and the spending views) and must never be given to the bill arithmetic.
 * Future slots come with status `pending`; the caller decides whether to show them.
 */
export function estimatedTransactions(store: Store, now: Date, opts: ViewOptions = {}, loaded?: EffectiveTransaction[]): EffectiveTransaction[] {
  const accounts = visibleAccounts(store, opts);
  const transactions = loaded ?? effectiveTransactions(store, opts, accounts);
  const plan = installments(store, now, opts, transactions);
  const today = localDay(now.toISOString());
  const rows: EffectiveTransaction[] = [];
  for (const account of accounts.filter((a) => a.kind === 'credit_card')) {
    const purchases = plan.purchases.filter((p) => p.accountId === account.id && p.slots.some((s) => s.inferred));
    if (purchases.length === 0) continue;
    const cycles = cyclesFor(store, account, transactions, today);
    // A card with no bill at all has no cycles to place a slot in, so the plan cannot tell paid from to come: nothing is estimated.
    if (cycles.length === 0) continue;
    const byKey = new Map(cycles.map((c) => [c.key, c]));
    const live = transactions.filter((t) => t.accountId === account.id && !t.excluded && t.amount < 0);
    const billOf = (t: EffectiveTransaction) => t.billCycle ?? cycles.find((c) => localDay(t.occurredAt) >= c.from && localDay(t.occurredAt) <= c.to)?.key;
    for (const p of purchases) {
      const text = seriesText(p.description);
      // The slots with a day are the charges we saw (or a plain charge that is that installment): the dates count from the nearest one.
      const seen = p.slots.filter((s) => s.day !== null);
      if (seen.length === 0) continue;
      for (const slot of p.slots) {
        if (!slot.inferred) continue;
        // A charge of this purchase already in that bill (a plain one the plan did not match) is the installment: never list it twice.
        if (live.some((t) => Math.abs(-t.amount - p.amount) <= p.total && seriesText(t.description).startsWith(text) && billOf(t) === slot.cycle)) continue;
        const base = seen.reduce((best, s) => (Math.abs(s.number - slot.number) < Math.abs(best.number - slot.number) ? s : best), seen[0]!);
        let day = addMonthsToDay(base.day!, monthIndex(slot.cycle) - monthIndex(base.cycle));
        const cycle = byKey.get(slot.cycle);
        if (cycle) day = day < cycle.from ? cycle.from : day > cycle.to ? cycle.to : day;
        // A slot of a bill already open or closed has been charged, so it is not dated ahead of today.
        if (slot.status !== 'future' && day > today) day = today;
        const description = `${p.description} ${slot.number}/${p.total}`;
        rows.push({
          id: estimatedId(p, slot.number),
          accountId: account.id,
          occurredAt: `${day}T15:00:00Z`,
          amount: -p.amount,
          description,
          descriptionRaw: null,
          status: slot.status === 'future' ? 'pending' : 'posted',
          installment: { number: slot.number, total: p.total },
          category: p.category,
          state: 'single_source',
          sourceIds: [],
          excluded: false,
          categoryOrigin: 'source',
          sourceCategory: null,
          sourceLabels: [],
          role: null,
          counterparty: null,
          mcc: null,
          operation: null,
          foreign: null,
          // The owner's name of the purchase or its standard one, with the number kept so the list tells the installments apart.
          title: p.customName !== null ? namedTitle(p.customName, { number: slot.number, total: p.total }) : `${titleOf({ description: p.description, amount: -p.amount, role: null, operation: null, counterparty: null })} ${slot.number}/${p.total}`,
          customName: p.customName,
          billCycle: slot.cycle,
          reversal: null,
          billByBank: false,
          statusByUser: false,
          statusByBill: false,
          estimated: true,
        });
      }
    }
  }
  return rows;
}

/** The purchase an estimated transaction (by its id) is an installment of, or null when there is none. */
export function purchaseOfEstimated(store: Store, id: string, now: Date): InstallmentPurchase | null {
  if (!id.startsWith(ESTIMATED_PREFIX)) return null;
  return installments(store, now, { includeHidden: true }).purchases.find((p) => id.startsWith(`${ESTIMATED_PREFIX}${p.id}_`)) ?? null;
}

/** What the screen says about one estimated transaction (opened from the list): the row, its purchase and where it falls. */
export interface EstimatedDetail {
  transaction: EffectiveTransaction;
  account: { id: string; institution: string; name: string; last4: string | null };
  purchase: { description: string; customName: string | null; total: number; amount: Cents; slots: InstallmentSlot[] };
  /** Number of this installment among the purchase's installments. */
  number: number;
  /** The bill it is charged in. */
  cycle: { key: string; dueDate: string; status: string } | null;
}

export function estimatedDetail(store: Store, id: string, now: Date): EstimatedDetail | null {
  if (!id.startsWith(ESTIMATED_PREFIX)) return null;
  const opts = { includeHidden: true };
  const transaction = estimatedTransactions(store, now, opts).find((t) => t.id === id);
  if (!transaction) return null;
  const purchase = installments(store, now, opts).purchases.find((p) => estimatedId(p, transaction.installment!.number) === id);
  const account = store.listCanonicalAccounts().find((a) => a.id === transaction.accountId);
  if (!purchase || !account) return null;
  const cycle = cyclesFor(store, account, effectiveTransactions(store, opts), localDay(now.toISOString())).find((c) => c.key === transaction.billCycle);
  return {
    transaction,
    account: { id: account.id, institution: account.institution, name: account.name, last4: account.last4 },
    purchase: { description: purchase.description, customName: purchase.customName, total: purchase.total, amount: purchase.amount, slots: purchase.slots },
    number: transaction.installment!.number,
    cycle: cycle ? { key: cycle.key, dueDate: cycle.dueDate, status: cycle.status } : null,
  };
}
