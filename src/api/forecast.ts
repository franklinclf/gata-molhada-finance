import type { Cents } from '../core/money.ts';
import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { addMonthsToDay, cyclesFor } from './cycles.ts';
import { installments } from './installments.ts';
import { effectiveTransactions, ruleKey, visibleAccounts, type EffectiveTransaction, type ViewOptions } from './scope.ts';
import { stamp, type Stamped } from './stamp.ts';
import { cards } from './views.ts';

export interface ForecastCard {
  id: string;
  label: string;
  /** Installments of purchases already made that fall in this bill. Known. */
  installments: Cents;
  /** Charges that come back every month (subscriptions, bills), at their latest amount. Likely. */
  recurring: Cents;
  /** Everything else, as the average of the last closed bills. A guess. */
  variable: Cents;
  total: Cents;
}

export interface ForecastMonth {
  /** Due month (YYYY-MM). */
  key: string;
  /** True for the bill still open, which already has some of its charges. */
  open: boolean;
  installments: Cents;
  recurring: Cents;
  variable: Cents;
  /** For the open bill: what is already counted. For later ones: the same as `total`. */
  known: Cents;
  total: Cents;
  cards: ForecastCard[];
}

export interface RecurringCharge {
  card: string;
  description: string;
  amount: Cents;
  months: number;
}

export interface ForecastView extends Stamped {
  months: ForecastMonth[];
  recurring: RecurringCharge[];
  /** How the variable part was worked out: the number of closed bills averaged, per card. */
  basis: Array<{ card: string; bills: number; average: Cents }>;
}

const MIN_MONTHS = 3;
const AVERAGE_OVER = 3;

/**
 * Estimates the bills still to come. Three parts, from most to least certain: installments of purchases already
 * made (the plan knows each one), charges that repeat every month with a stable amount, and the usual spending,
 * taken as the average of what the last closed bills held besides those two. The open bill's total is shown with
 * what it already has, and its estimate is never below that.
 */
export function forecast(store: Store, now: Date, opts: ViewOptions = {}, horizon = 6): ForecastView {
  const accounts = visibleAccounts(store, opts);
  const cardAccounts = accounts.filter((a) => a.kind === 'credit_card');
  const transactions = effectiveTransactions(store, opts, accounts);
  const today = localDay(now.toISOString());
  const plan = installments(store, now, opts);
  const open = cards(store, now, opts, 'open');

  const label = (id: string) => {
    const a = cardAccounts.find((x) => x.id === id)!;
    return `${a.institution}${a.last4 ? ` ${a.last4}` : ` ${a.name}`}`;
  };

  // Keys of the months to forecast, starting with the open bill.
  const firstKey = open.cards.map((c) => c.cycle?.key).filter((k): k is string => !!k).sort()[0] ?? today.slice(0, 7);
  const keys = Array.from({ length: horizon }, (_, i) => addMonthsToDay(`${firstKey}-01`, i).slice(0, 7));

  const recurring: RecurringCharge[] = [];
  const months: ForecastMonth[] = keys.map((key, i) => ({ key, open: i === 0, installments: 0, recurring: 0, variable: 0, known: 0, total: 0, cards: [] }));
  const basis: ForecastView['basis'] = [];

  for (const account of cardAccounts) {
    const cycles = cyclesFor(store, account, transactions, today).filter((c) => c.status !== 'unknown');
    const own = transactions.filter((t) => t.accountId === account.id && !t.excluded && t.role === null);

    // Charges that come back: same text, a stable amount, in at least three different months of the last six bills.
    const recent = cycles.filter((c) => c.status !== 'open').slice(-6);
    const byKey = new Map<string, EffectiveTransaction[]>();
    for (const t of own) {
      if (t.amount >= 0 || t.installment) continue;
      const day = localDay(t.occurredAt);
      if (!recent.some((c) => day >= c.from && day <= c.to)) continue;
      byKey.set(ruleKey(t.description), [...(byKey.get(ruleKey(t.description)) ?? []), t]);
    }
    const repeating = new Map<string, number>();
    for (const [key, list] of byKey) {
      const months = new Set(list.map((t) => t.occurredAt.slice(0, 7)));
      const amounts = list.map((t) => -t.amount);
      if (months.size < MIN_MONTHS || Math.max(...amounts) > Math.min(...amounts) * 1.1) continue;
      const latest = [...list].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]!;
      repeating.set(key, -latest.amount);
      recurring.push({ card: label(account.id), description: latest.description, amount: -latest.amount, months: months.size });
    }
    const recurringMonthly = [...repeating.values()].reduce((s, v) => s + v, 0);

    // The usual spending: what the last closed bills held besides installments and repeating charges.
    const closed = recent.filter((c) => c.billTotal !== null).slice(-AVERAGE_OVER);
    const variableOf = (c: (typeof closed)[number]) => {
      const inBill = plan.purchases.filter((p) => p.accountId === account.id).reduce((s, p) => s + p.slots.filter((x) => x.cycle === c.key).length * p.amount, 0);
      const repeated = own.filter((t) => repeating.has(ruleKey(t.description)) && localDay(t.occurredAt) >= c.from && localDay(t.occurredAt) <= c.to).reduce((s, t) => s - t.amount, 0);
      return Math.max((c.billTotal ?? 0) - inBill - repeated, 0);
    };
    const average = closed.length > 0 ? Math.round(closed.reduce((s, c) => s + variableOf(c), 0) / closed.length) : 0;
    basis.push({ card: label(account.id), bills: closed.length, average });

    const row = open.cards.find((c) => c.id === account.id);
    months.forEach((m, i) => {
      const inst = plan.purchases.filter((p) => p.accountId === account.id).reduce((s, p) => s + p.slots.filter((x) => x.cycle === m.key && x.status !== 'paid').length * p.amount, 0);
      const known = i === 0 ? (row?.total ?? 0) : 0;
      const total = i === 0 ? Math.max(known, inst + recurringMonthly + average) : inst + recurringMonthly + average;
      m.cards.push({ id: account.id, label: label(account.id), installments: inst, recurring: recurringMonthly, variable: average, total });
      m.installments += inst;
      m.recurring += recurringMonthly;
      m.variable += average;
      m.known += known;
      m.total += total;
    });
  }

  return { ...stamp(cardAccounts, now), months, recurring: recurring.sort((a, b) => b.amount - a.amount), basis };
}
