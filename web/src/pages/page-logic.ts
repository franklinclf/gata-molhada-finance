import { brl, brlShort, dayMonth, localDay, MASK, monthLong, monthName } from '../format.ts';

/** "1 vez", "3 vezes". */
export const times = (n: number): string => `${n} ${n === 1 ? 'vez' : 'vezes'}`;

/**
 * The list hides a refund under its purchase, so the number of rows is lower than the number of transactions in the sums.
 * The card shows the rows and says how many refunds are tucked under their purchases.
 */
export function countNote(shown: number, matching: number): string | null {
  const grouped = matching - shown;
  return grouped > 0 ? `${grouped} ${grouped === 1 ? 'estorno agrupado' : 'estornos agrupados'} com a compra` : null;
}

/** What the money in the totals is made of when part of it is not income or spending; null when all of it is. */
export function internalNote(internal: { count: number; income: number; expense: number }, hidden: boolean): string | null {
  if (internal.count === 0) return null;
  const money = (cents: number) => brl(cents, hidden);
  const parts = [internal.income > 0 ? `entraram ${money(internal.income)}` : '', internal.expense > 0 ? `saíram ${money(internal.expense)}` : ''].filter(Boolean);
  return `Nas somas há ${internal.count} ${internal.count === 1 ? 'movimento' : 'movimentos'} que não são renda nem gasto (pagamento de fatura, transferência entre suas contas, investimento): ${parts.join(' e ')}.`;
}

/** The totals include installments the bank bills but never listed; null when none is in the result. */
export function estimatedNote(estimated: { count: number; expense: number }, hidden: boolean): string | null {
  if (estimated.count === 0) return null;
  return `As somas incluem ${estimated.count} ${estimated.count === 1 ? 'parcela estimada' : 'parcelas estimadas'} (${brl(estimated.expense, hidden)}): o banco cobra na fatura, mas não listou. Elas já estão no total da fatura e não podem ser editadas.`;
}

/**
 * The totals of the tiles. Filtered to one bill, the payment of that bill is left out: it shows in the list but is money moving between
 * the account and the card, so counting it would make the purchases and the payment cancel each other out (income = expenses, result 0).
 */
export function tileSums(sums: { income: number; expense: number; net: number }, internal: { income: number; expense: number }, bill: boolean): { income: number; expense: number; net: number } {
  if (!bill) return sums;
  const income = sums.income - internal.income;
  const expense = sums.expense - internal.expense;
  return { income, expense, net: income - expense };
}

/** Says what a bill's totals leave out (see tileSums); null when the bill has no payment in the list. */
export function billPaymentNote(internal: { count: number; income: number; expense: number }, hidden: boolean): string | null {
  if (internal.count === 0) return null;
  const amount = brl(Math.max(internal.income, internal.expense), hidden);
  return internal.count === 1 ? `O pagamento da fatura (${amount}) aparece na lista, mas não entra nas somas.` : `${internal.count} pagamentos e movimentos ligados à fatura (${amount}) aparecem na lista, mas não entram nas somas.`;
}

/** A recurring item whose expected day is already past is not "next" any more: say it was expected then and has not come. */
export function recurringWhen(r: { dayOfMonth: number; occurrences: number; nextDay: string }, today: string): string {
  const base = `todo dia ${r.dayOfMonth} · ${times(r.occurrences)}`;
  return r.nextDay < today ? `${base} · esperada em ${dayMonth(r.nextDay)}, ainda não veio` : `${base} · próximo ${dayMonth(r.nextDay)}`;
}

/** A day total that fits a narrow calendar cell: thousands are cut to "3,8 mil". */
export function cellMoney(cents: number, hidden: boolean): { full: string; short: string } {
  if (hidden) return { full: '••', short: '••' };
  const full = brl(cents).replace(/\s?R\$\s?/, '');
  return { full, short: Math.abs(cents) >= 100_000 ? brlShort(cents) : full };
}

/** Bank accounts with nothing in them are listed apart so the rows that carry money stay visible. */
export function splitZero<T extends { kind: string; value: number; liability: boolean }>(items: T[]): { shown: T[]; zero: T[] } {
  const isZero = (i: T) => i.kind === 'bank' && !i.liability && i.value === 0;
  return { shown: items.filter((i) => !isZero(i)), zero: items.filter(isZero) };
}

/** An instant as "dd/mm hh:mm" in Brazil time (UTC-3, as everywhere in the app). */
export function localStamp(iso: string): string {
  const shifted = new Date(Date.parse(iso) - 3 * 3_600_000).toISOString();
  return `${dayMonth(shifted.slice(0, 10))} ${shifted.slice(11, 16)}`;
}

/** "amanhã 00:40", "hoje 19:10" or "09/11 00:40", for a moment ahead. */
export function whenAhead(iso: string, now: Date): string {
  const day = localDay(iso);
  const today = localDay(now.toISOString());
  const time = localStamp(iso).slice(6);
  if (day === today) return `hoje ${time}`;
  if (day === localDay(new Date(now.getTime() + 86_400_000).toISOString())) return `amanhã ${time}`;
  return localStamp(iso);
}

/** First and last point of a series, for the labels a chart without axes needs. */
export function endpoints(days: string[], values: number[], hidden: boolean): { from: string; to: string } | null {
  if (days.length < 2 || values.length !== days.length) return null;
  const at = (i: number) => `${dayMonth(days[i]!)}/${days[i]!.slice(0, 4)}: ${hidden ? MASK : brl(values[i]!)}`;
  return { from: at(0), to: at(days.length - 1) };
}

/**
 * How the month in progress stands against the whole month before, in a few characters.
 * The month is not over, so a fall says little: only a rise is flagged. Null when there is no month before to compare with.
 */
export function trendChange(current: number, previous: number | null, hidden: boolean): { text: string; rising: boolean } | null {
  if (previous === null) return null;
  if (previous === 0) return current > 0 ? { text: 'nada no mês passado', rising: false } : null;
  const delta = current - previous;
  if (delta === 0) return { text: 'igual', rising: false };
  return { text: `${delta > 0 ? '+' : '−'}${brl(Math.abs(delta), hidden)}`, rising: delta > 0 };
}

// ---------- which card bills the Faturas widget and the Cartões page show ----------

/**
 * `current`: the bills that fall due in the current month (the bar /api/cards/bills flags as current). `open`: everything still unpaid,
 * closed bills and the open ones of any due month. Any other value is one due month (YYYY-MM).
 */
export const CURRENT_CYCLE = 'current';

/**
 * The cycle to ask /api/cards for. Undefined while the bars are not loaded, so no request is made for a month not known yet.
 * With no open bar at all (no card has a bill) the current cycle falls back to everything unpaid.
 */
export function resolveCycle(choice: string, bars: ReadonlyArray<{ key: string; current: boolean }> | undefined): string | undefined {
  if (choice !== CURRENT_CYCLE) return choice;
  if (bars === undefined) return undefined;
  return bars.find((b) => b.current)?.key ?? 'open';
}

/** The choice a month stands for: the current bill is the "current" button, not a month of the list. */
export function choiceOf(key: string, currentKey: string | undefined): string {
  return key === currentKey ? CURRENT_CYCLE : key;
}

/** Label of the "current cycle" button: the short name of the month the bill falls due in ("Ciclo atual (nov)"). */
export function currentLabel(currentKey: string | undefined): string {
  return currentKey !== undefined && currentKey !== 'open' ? `Ciclo atual (${monthName(currentKey).slice(0, 3)})` : 'Ciclo atual';
}

/** The due months of the dropdown: every cycle but the current one, which has its button; the month picked stays listed. Newest first. */
export function otherCycles(cycles: readonly string[], currentKey: string | undefined, picked: string): string[] {
  const months = new Set(cycles);
  if (/^\d{4}-\d{2}$/.test(picked)) months.add(picked);
  months.delete(currentKey ?? '');
  return [...months].sort().reverse();
}

/** One line that says what the numbers on show count. `today` is a local day. */
export function cycleCaption(cycle: string, today: string): string {
  return cycle === 'open' ? 'Tudo que falta pagar nos cartões' : `Faturas que vencem em ${monthLong(cycle, today)}`;
}
