import { dayNumber } from '../core/dates.ts';
import { localDay } from '../core/time.ts';
import { DEFAULT_DATA_START } from '../reconcile/run.ts';
import type { Loan, Store } from '../store/store.ts';
import { addMonthsToDay } from './cycles.ts';
import { deleteManual } from './manual.ts';
import { cleanCategoryName } from './mutations.ts';
import type { RecurringItem } from './recurring.ts';
import { effectiveTransactions, visibleAccounts, type EffectiveTransaction, type ViewOptions } from './scope.ts';
import { stamp, type Stamped } from './stamp.ts';

export type LoanResult<T = Record<string, never>> = { ok: true; value: T } | { ok: false; status: number; error: string };

export type InstallmentStatus = 'paid' | 'due' | 'late' | 'future';

export interface ScheduledInstallment {
  /** 1-based. */
  number: number;
  day: string;
  /** Cents. */
  amount: number;
}

export interface LoanInstallment extends ScheduledInstallment {
  status: InstallmentStatus;
  /** The debit that paid it, when matched. */
  transactionId: string | null;
}

export interface LoanView {
  id: number;
  name: string;
  accountId: string;
  accountName: string;
  principal: number;
  total: number;
  /** total - principal. */
  interest: number;
  installments: number;
  firstDue: string;
  takenOn: string;
  paidCount: number;
  /** Sum of the installments not matched yet. */
  remaining: number;
  next: { day: string; amount: number; late: boolean } | null;
  schedule: LoanInstallment[];
  /** The credit that was the loan, when the app found it. */
  proceeds: { transactionId: string; day: string } | null;
}

export interface LoansView extends Stamped {
  items: LoanView[];
}

const MAX_LOANS = 20;
const MAX_AMOUNT = 100_000_000_000;
const MAX_INSTALLMENTS = 120;
const LOAN_CATEGORY = 'Empréstimos e financiamentos';
/** Debits can post a few days before the due day (a bank moves it back) or after it (a weekend, a holiday). */
const WINDOW_BEFORE_DAYS = 3;
const WINDOW_AFTER_DAYS = 7;
const AMOUNT_TOLERANCE_CENTS = 2;
/** The cash can post a few days either side of the day the owner says it came in. */
const PROCEEDS_WINDOW_DAYS = 3;
/** An unmatched installment due more than this many days ago is late rather than just due. */
const LATE_AFTER_DAYS = 5;

export const manualIdOf = (n: number): string => `man_${n}`;

type LoanTerms = Pick<Loan, 'total' | 'installments' | 'firstDue'>;

/** The installments: `total` split in whole cents (the first ones take the extra cents), due monthly from `firstDue`. */
export function scheduleOf(loan: LoanTerms): ScheduledInstallment[] {
  const base = Math.floor(loan.total / loan.installments);
  const extra = loan.total - base * loan.installments;
  return Array.from({ length: loan.installments }, (_, i) => ({ number: i + 1, day: addMonthsToDay(loan.firstDue, i), amount: base + (i < extra ? 1 : 0) }));
}

type Candidate = Pick<EffectiveTransaction, 'id' | 'accountId' | 'amount' | 'occurredAt' | 'role' | 'excluded' | 'state'>;

/**
 * The debit that paid each installment: on the loan's account, with no role yet, an amount within 2 cents and a day from 3 days
 * before to 7 days after the due day. The closest day wins and a transaction pays one installment only (`used` carries that
 * across loans). Rows must have their role computed without this pass, or a matched row would no longer be a candidate.
 * Returns installment number -> transaction id.
 */
export function matchInstallments(loan: Loan, transactions: Candidate[], used: Set<string> = new Set()): Map<number, string> {
  const own = loan.interestManualId === null ? null : manualIdOf(loan.interestManualId);
  const pool = transactions
    .filter((t) => t.amount < 0 && t.accountId === loan.accountId && (t.role === null || t.role === 'loan_payment') && !t.excluded && t.state !== 'stale_pending' && t.id !== own)
    .map((t) => ({ id: t.id, cents: -t.amount, day: dayNumber(localDay(t.occurredAt)) }));
  const matched = new Map<number, string>();
  for (const installment of scheduleOf(loan)) {
    const due = dayNumber(installment.day);
    let best: (typeof pool)[number] | null = null;
    for (const t of pool) {
      if (used.has(t.id) || Math.abs(t.cents - installment.amount) > AMOUNT_TOLERANCE_CENTS || t.day < due - WINDOW_BEFORE_DAYS || t.day > due + WINDOW_AFTER_DAYS) continue;
      if (best === null || Math.abs(t.day - due) < Math.abs(best.day - due) || (Math.abs(t.day - due) === Math.abs(best.day - due) && (t.day < best.day || (t.day === best.day && t.id < best.id)))) best = t;
    }
    if (best === null) continue;
    used.add(best.id);
    matched.set(installment.number, best.id);
  }
  return matched;
}

/** The credit that was the loan itself: on the loan's account, exactly the amount received, within 3 days of the day it came in. */
export function matchProceeds(loan: Loan, transactions: Candidate[], used: Set<string> = new Set()): string | null {
  const taken = dayNumber(loan.takenOn);
  let best: { id: string; gap: number } | null = null;
  for (const t of transactions) {
    if (t.amount !== loan.principal || t.accountId !== loan.accountId || t.role !== null || t.excluded || t.state === 'stale_pending' || used.has(t.id)) continue;
    const gap = Math.abs(dayNumber(localDay(t.occurredAt)) - taken);
    if (gap > PROCEEDS_WINDOW_DAYS || (best !== null && (gap > best.gap || (gap === best.gap && t.id > best.id)))) continue;
    best = { id: t.id, gap };
  }
  if (best !== null) used.add(best.id);
  return best?.id ?? null;
}

/** Every loan's matches, over rows whose role was computed without the loan pass. */
export function matchAllLoans(loans: Loan[], transactions: Candidate[]): Map<number, Map<number, string>> {
  const used = new Set<string>();
  return new Map(loans.map((l) => [l.id, matchInstallments(l, transactions, used)]));
}

function statusOf(day: string, paid: boolean, today: string): InstallmentStatus {
  if (paid) return 'paid';
  if (day > today) return 'future';
  return dayNumber(today) - dayNumber(day) > LATE_AFTER_DAYS ? 'late' : 'due';
}

function viewOf(loan: Loan, matched: Map<number, string>, today: string, accountName: string, proceeds: LoanView['proceeds']): LoanView {
  const schedule: LoanInstallment[] = scheduleOf(loan).map((s) => ({ ...s, status: statusOf(s.day, matched.has(s.number), today), transactionId: matched.get(s.number) ?? null }));
  const open = schedule.filter((s) => s.status !== 'paid');
  const first = open[0];
  return {
    id: loan.id,
    name: loan.name,
    accountId: loan.accountId,
    accountName,
    principal: loan.principal,
    total: loan.total,
    interest: loan.total - loan.principal,
    installments: loan.installments,
    firstDue: loan.firstDue,
    takenOn: loan.takenOn,
    paidCount: schedule.length - open.length,
    remaining: open.reduce((s, i) => s + i.amount, 0),
    next: first ? { day: first.day, amount: first.amount, late: first.status === 'late' } : null,
    schedule,
    proceeds,
  };
}

/** The loans with their schedule and what each installment is: paid (a debit matched), due, late or still ahead. */
export function loansView(store: Store, now: Date): LoansView {
  const loans = store.listLoans();
  const today = localDay(now.toISOString());
  const accounts = store.listCanonicalAccounts();
  if (loans.length === 0) return { ...stamp(accounts, now), items: [] };
  const rows = effectiveTransactions(store, { includeHidden: true, withoutLoans: true });
  const matches = matchAllLoans(loans, rows);
  const taken = new Set([...matches.values()].flatMap((m) => [...m.values()]));
  const dayOf = new Map(rows.map((t) => [t.id, localDay(t.occurredAt)]));
  const label = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.institution} · ${a.name}` : id;
  };
  return { ...stamp(accounts, now), items: loans.map((l) => {
      const id = matchProceeds(l, rows, taken);
      return viewOf(l, matches.get(l.id)!, today, label(l.accountId), id === null ? null : { transactionId: id, day: dayOf.get(id)! });
    }) };
}

/** Loans with installments still to match, as recurring bank payments. Only loans on accounts the view shows. */
export function loanRecurring(store: Store, now: Date, opts: ViewOptions = {}): RecurringItem[] {
  if (store.listLoans().length === 0) return [];
  const visible = new Set(visibleAccounts(store, opts).map((a) => a.id));
  const items: RecurringItem[] = [];
  for (const loan of loansView(store, now).items) {
    const open = loan.schedule.filter((s) => s.status !== 'paid');
    const next = open[0];
    if (!next || !visible.has(loan.accountId)) continue;
    const paid = loan.schedule.filter((s) => s.status === 'paid');
    items.push({
      key: `loan:${loan.id}`,
      name: `Empréstimo ${loan.name}`,
      direction: 'out',
      amount: next.amount,
      kind: 'fixed',
      dayOfMonth: Number(next.day.slice(8, 10)),
      occurrences: paid.length,
      lastDay: paid.at(-1)?.day ?? loan.takenOn,
      nextDay: next.day,
      late: next.status === 'late',
      category: LOAN_CATEGORY,
      account: 'bank',
      label: 'recurring',
      edited: false,
      manual: true,
      regular: true,
      rest: null,
      stale: false,
      endsOn: loan.schedule.at(-1)!.day,
      remaining: open.map((s) => ({ day: s.day, amount: s.amount })),
    });
  }
  return items;
}

function realDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

const cents = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function createLoan(store: Store, body: Record<string, unknown>, now: Date): LoanResult<{ id: number }> {
  const bad = (error: string): LoanResult<{ id: number }> => ({ ok: false, status: 400, error });
  const name = cleanCategoryName(body.name);
  if (name === null) return bad('name must be text of 1 to 60 characters');
  const account = typeof body.accountId === 'string' ? store.listCanonicalAccounts().find((a) => a.id === body.accountId) : undefined;
  if (!account || account.kind === 'credit_card') return bad('accountId must be one of your bank accounts');
  const { principal, total, installments } = body;
  if (!cents(principal) || principal <= 0 || principal > MAX_AMOUNT) return bad('principal must be a whole number of cents above zero');
  if (!cents(total) || total < principal || total > MAX_AMOUNT) return bad('total must be a whole number of cents, not less than principal');
  if (!cents(installments) || installments < 1 || installments > MAX_INSTALLMENTS) return bad(`installments must be a whole number from 1 to ${MAX_INSTALLMENTS}`);
  if (!realDay(body.firstDue)) return bad('firstDue must look like 2026-10-28');
  if (!realDay(body.takenOn)) return bad('takenOn must look like 2026-10-28');
  if (body.takenOn > localDay(now.toISOString())) return bad('takenOn cannot be in the future');
  if (body.takenOn < DEFAULT_DATA_START) return bad(`the app only keeps data from ${DEFAULT_DATA_START}`);
  if (store.listLoans().length >= MAX_LOANS) return bad(`at most ${MAX_LOANS} loans`);
  const saved = store.saveLoan({ name, accountId: account.id, principal, total, installments, firstDue: body.firstDue, takenOn: body.takenOn, interestManualId: null }, now.toISOString());
  return { ok: true, value: { id: saved.id } };
}

export function deleteLoan(store: Store, id: number, now: Date): LoanResult {
  const loan = store.listLoans().find((l) => l.id === id);
  if (!loan) return { ok: false, status: 404, error: 'not_found' };
  store.deleteLoan(id);
  // Loans made before the interest stopped being posted by hand may still own such a transaction.
  if (loan.interestManualId !== null) deleteManual(store, manualIdOf(loan.interestManualId), now);
  return { ok: true, value: {} };
}
