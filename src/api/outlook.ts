import { addDays, lastDayOf } from '../core/dates.ts';
import type { Cents } from '../core/money.ts';
import { localDay } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { cyclesFor } from './cycles.ts';
import { installments } from './installments.ts';
import { groupBill, incomeEvents, monthlyDays } from './projection.ts';
import { detectRecurring, isExpected, type RecurringItem } from './recurring.ts';
import { effectiveTransactions, visibleAccounts, type ViewOptions } from './scope.ts';
import { stamp, type Stamped } from './stamp.ts';
import { cards } from './views.ts';

/** One thing that moves money in the bank accounts, with `origin` saying in a short sentence where it comes from. */
export interface OutlookEvent {
  /** The day the money moves. A bill that is already overdue is placed today. */
  day: string;
  name: string;
  /** Positive amount in cents. */
  amount: Cents;
  direction: 'in' | 'out';
  kind: 'bill' | 'recurring' | 'income';
  origin: string;
  /** Why the day is not the plain day of the month, such as "antecipado: dia 10 cai no sábado" for a salary moved to the business day before. */
  note?: string;
  /** The due day passed and it did not show up (a late bill is still owed; an income expected yesterday that did not come yet is kept, one older than that is left out). */
  late: boolean;
  /** The amount is a guess: an open bill that can still grow, or a recurring item whose amount moves. */
  estimate: boolean;
  /** The bank balance projected just before this event and just after it. */
  balanceBefore: Cents;
  balanceAfter: Cents;
  /** An outflow that the projected balance covers. Always true for an inflow. */
  covered: boolean;
  /** How much is missing in the account to pay it (zero when covered). */
  shortfall: Cents;
  /** Everything that leaves the account up to and including this event. */
  cumulativeOut: Cents;
  /** Past the end of the month: shown so the owner sees what comes right after, but not part of "free to spend". */
  afterMonth: boolean;
}

export interface OutlookView extends Stamped {
  today: string;
  month: string;
  monthEnd: string;
  daysLeft: number;
  /** Money in the bank accounts now. */
  balance: Cents;
  /** Money still expected to arrive until the end of the month. */
  expectedIn: { total: Cents; items: OutlookEvent[]; source: 'registered' | 'recurring' | 'none'; explain: string };
  /** Card bills and recurring bank payments that fall until the end of the month. */
  dueOut: { total: Cents; bills: Cents; recurring: Cents; items: OutlookEvent[]; explain: string };
  /** Bills due after the month ends, so they are not in `free`. */
  afterMonth: { total: Cents; count: number; firstDay: string | null; explain: string };
  /** What is left in the account at the end of the month after the money coming and going above. Not a promise: new purchases are not counted. */
  free: { value: Cents; perDay: Cents | null; explain: string };
  /** Lowest projected balance over the whole timeline. */
  lowest: { day: string; value: Cents } | null;
  /** Every event in date order with the projected balance. */
  timeline: OutlookEvent[];
  /** The first outflow the projected balance does not cover. */
  firstUncovered: OutlookEvent | null;
  committed: {
    income: { amount: Cents | null; source: 'registered' | 'recurring' | null; explain: string };
    installments: Cents;
    installmentCount: number;
    subscriptions: Cents;
    subscriptionCount: number;
    fixed: Cents;
    fixedCount: number;
    total: Cents;
    /** Share of the monthly income, or null when there is no way to estimate the income. */
    share: number | null;
    explain: string;
  };
}

/** Never project further than this, so a card with a far due date does not stretch the list. */
const MAX_AHEAD_DAYS = 62;

/** 2026-10-28 as 28/10. */
const shortDay = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const cardLabel = (a: { institution: string; last4: string | null; name: string }) => `${a.institution}${a.last4 ? ` ${a.last4}` : ` ${a.name}`}`;

type Raw = Omit<OutlookEvent, 'balanceBefore' | 'balanceAfter' | 'covered' | 'shortfall' | 'cumulativeOut' | 'afterMonth'>;

/**
 * The month in one view: what is in the account, what is still expected to come in, what falls due (card bills by due
 * date, using the same "to pay" as the Faturas screen, and recurring bank payments), and what is left. Nothing here needs
 * a registered income or budget: income is the registered one when there is any, else the recurring credits found in
 * the bank accounts, else it is left unknown.
 */
export function outlook(store: Store, now: Date, opts: ViewOptions = {}): OutlookView {
  const today = localDay(now.toISOString());
  const month = today.slice(0, 7);
  const monthEnd = lastDayOf(month);
  const accounts = visibleAccounts(store, opts);
  const bankAccounts = accounts.filter((a) => a.kind !== 'credit_card');
  const cardAccounts = accounts.filter((a) => a.kind === 'credit_card');
  const balance = bankAccounts.reduce((s, a) => s + a.balance, 0);
  // A marked item with no monthly rhythm, or one that stopped, is listed on its screen but not expected here.
  const recurring = detectRecurring(store, now, opts).filter(isExpected);

  // Card bills: closed ones still owed, and the open one. A bill already overdue is due today.
  const raw: Raw[] = [];
  const transactions = effectiveTransactions(store, opts, accounts);
  const view = cards(store, now, opts, 'open');
  const countedGroups = new Set<string>();
  for (const account of cardAccounts) {
    const label = `Fatura ${cardLabel(account)}`;
    for (const cycle of cyclesFor(store, account, transactions, today)) {
      if (cycle.status === 'open') {
        const row = view.cards.find((c) => c.id === account.id);
        let total = row?.total ?? 0;
        // Cards that share a limit report one open estimate for the group: count it once.
        const group = account.limitGroupId !== null && cycle.billTotal === null ? view.limitGroups.find((g) => g.id === account.limitGroupId) : undefined;
        let name = label;
        let dueDate = cycle.dueDate;
        let closing = cycle.to;
        if (group) {
          total = countedGroups.has(group.id) ? 0 : group.openEstimate;
          countedGroups.add(group.id);
          // One bill for the whole group, named by its cards and dated by the earliest due date among them.
          const shared = total > 0 ? groupBill(store, group, cardAccounts, transactions, today) : null;
          if (shared) ({ label: name, dueDate, closing } = shared);
        }
        if (total <= 0) continue;
        raw.push({ day: dueDate < today ? today : dueDate, name, amount: total, direction: 'out', kind: 'bill', origin: `fatura aberta, fecha em ${shortDay(closing)}; compras novas ainda somam`, late: dueDate < today, estimate: true });
      } else if (cycle.outstanding > 0) {
        raw.push({ day: cycle.dueDate < today ? today : cycle.dueDate, name: label, amount: cycle.outstanding, direction: 'out', kind: 'bill', origin: cycle.dueDate < today ? `fatura fechada vencida em ${shortDay(cycle.dueDate)} e ainda não paga` : 'fatura fechada ainda não paga', late: cycle.dueDate < today, estimate: false });
      }
    }
  }

  const lastBill = raw.reduce((max, e) => (e.day > max ? e.day : max), monthEnd);
  const cap = addDays(today, MAX_AHEAD_DAYS);
  const until = lastBill < cap ? lastBill : cap;
  const billsInWindow = raw.filter((e) => e.day <= until);

  // Recurring payments from the bank. A card item is already inside its bill. One that is late is still owed today.
  const events: Raw[] = [...billsInWindow];
  for (const r of recurring) {
    if (r.account === 'card' || r.direction !== 'out') continue;
    const days = monthlyDays(r.nextDay, r.dayOfMonth, today, until);
    if (r.nextDay < today) days.unshift(today);
    for (const day of days) {
      const isLate = r.nextDay < today && day === today;
      // Rent paid in parts: this month's event is what is still due, the ones after it are the whole.
      const first = day === days[0];
      events.push({ day, name: r.name, amount: first && r.rest !== null ? r.rest : r.amount, direction: 'out', kind: 'recurring', origin: r.kind === 'fixed' ? `repete todo mês, dia ${r.dayOfMonth}` : `repete todo mês, dia ${r.dayOfMonth}, valor varia (usado o valor típico)`, late: isLate && r.late, estimate: r.kind === 'variable' });
    }
  }

  // Income: what the owner registered, else the credits that come back every month. A late credit is not counted.
  const registered = store.listIncome();
  const income = incomeEvents(store, recurring, today, until, transactions);
  const incomeSource = income.source;
  for (const e of income.events) events.push({ ...e, direction: 'in', kind: 'income' });

  // Walk the days. On the same day the money that arrives is placed first, then the payments, larger ones first.
  events.sort((a, b) => a.day.localeCompare(b.day) || (a.direction === b.direction ? b.amount - a.amount : a.direction === 'in' ? -1 : 1) || a.name.localeCompare(b.name));
  let running = balance;
  let outTotal = 0;
  const timeline: OutlookEvent[] = events.map((e) => {
    const balanceBefore = running;
    running += e.direction === 'in' ? e.amount : -e.amount;
    if (e.direction === 'out') outTotal += e.amount;
    const covered = e.direction === 'in' || running >= 0;
    return { ...e, balanceBefore, balanceAfter: running, covered, shortfall: covered ? 0 : Math.min(-running, e.amount), cumulativeOut: outTotal, afterMonth: e.day > monthEnd };
  });

  const lowest = timeline.reduce<OutlookView['lowest']>((low, e) => (low === null || e.balanceAfter < low.value ? { day: e.day, value: e.balanceAfter } : low), null);
  const inMonth = timeline.filter((e) => !e.afterMonth);
  const sum = (list: OutlookEvent[]) => list.reduce((s, e) => s + e.amount, 0);
  const incoming = inMonth.filter((e) => e.direction === 'in');
  const outgoing = inMonth.filter((e) => e.direction === 'out');
  const bills = outgoing.filter((e) => e.kind === 'bill');
  const fixedOut = outgoing.filter((e) => e.kind === 'recurring');
  const after = timeline.filter((e) => e.afterMonth && e.kind === 'bill');
  const freeValue = balance + sum(incoming) - sum(outgoing);
  const daysLeft = Math.max(1, Math.round((Date.parse(`${monthEnd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 1);

  // Committed share of the monthly income. Card recurring items count here (it is a monthly weight, not cash timing).
  const load = installments(store, now, opts).months.find((m) => m.cycle === month);
  const installmentsMonth = load ? load.paid + load.billed + load.open + load.future : 0;
  const outItems = recurring.filter((r) => r.direction === 'out');
  const subs = outItems.filter((r) => r.label === 'subscription');
  const fixed = outItems.filter((r) => r.label !== 'subscription' && (r.label === 'recurring' || r.kind === 'fixed'));
  const total = (list: RecurringItem[]) => list.reduce((s, r) => s + r.amount, 0);
  const incomeAmount = incomeSource === 'registered' ? registered.filter((i) => (i.fromMonth === null || i.fromMonth <= month) && (i.untilMonth === null || i.untilMonth >= month)).reduce((s, i) => s + i.amount, 0) : incomeSource === 'recurring' ? total(recurring.filter((r) => r.direction === 'in' && r.account === 'bank')) : null;
  const committedTotal = installmentsMonth + total(subs) + total(fixed);

  return {
    ...stamp(bankAccounts, now),
    today,
    month,
    monthEnd,
    daysLeft,
    balance,
    expectedIn: {
      total: sum(incoming),
      items: incoming,
      source: incomeSource,
      explain: incomeSource === 'registered' ? 'Renda cadastrada com dia de pagamento de hoje em diante (já ajustado para dia útil) e que ainda não chegou na conta.' : incomeSource === 'recurring' ? 'Entradas que se repetem todo mês nas contas (no dia útil anterior quando o dia cai em fim de semana ou feriado) e ainda não chegaram neste mês.' : 'Nenhuma renda cadastrada nem entrada recorrente encontrada: nada foi somado.',
    },
    dueOut: {
      total: sum(outgoing),
      bills: sum(bills),
      recurring: sum(fixedOut),
      items: outgoing,
      explain: 'Faturas ainda não pagas (mesma conta da tela de Faturas) que vencem até o fim do mês, mais pagamentos recorrentes das contas. Fatura vencida entra hoje.',
    },
    afterMonth: {
      total: sum(after),
      count: after.length,
      firstDay: after[0]?.day ?? null,
      explain: 'Faturas que vencem depois do fim do mês. Não entram no livre para gastar, mas aparecem na linha do tempo.',
    },
    free: {
      value: freeValue,
      perDay: freeValue > 0 ? Math.floor(freeValue / daysLeft) : null,
      explain: 'Saldo das contas, mais o que ainda deve entrar, menos o que vence até o fim do mês. Compras novas no cartão e gastos do dia a dia não estão descontados.',
    },
    lowest,
    timeline,
    firstUncovered: timeline.find((e) => !e.covered) ?? null,
    committed: {
      income: {
        amount: incomeAmount,
        source: incomeSource === 'none' ? null : incomeSource,
        explain: incomeSource === 'registered' ? 'Soma da renda cadastrada para este mês.' : incomeSource === 'recurring' ? 'Soma das entradas que se repetem todo mês nas contas (estimativa).' : 'Sem renda cadastrada e sem entrada recorrente: não dá para estimar.',
      },
      installments: installmentsMonth,
      installmentCount: load?.count ?? 0,
      subscriptions: total(subs),
      subscriptionCount: subs.length,
      fixed: total(fixed),
      fixedCount: fixed.length,
      total: committedTotal,
      share: incomeAmount !== null && incomeAmount > 0 ? committedTotal / incomeAmount : null,
      explain: 'Parcelas do mês, assinaturas e outros itens fixos que se repetem (aluguel, contas), contados uma vez. Gastos variáveis ficam de fora.',
    },
  };
}
