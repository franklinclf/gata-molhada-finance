/**
 * Reads a credit card statement out of the text positions a PDF reader gives: Bradescard ("Fatura mensal") and Bradesco
 * ("Fatura Mensal"). Rows are found by their position (date at the left margin, amount at the right edge of the left
 * table) and labels, not by text columns, and the sum of the lines is checked against the printed total. Nothing but
 * the card finals of the personal data on the page is kept.
 */
import { addDays } from '../core/dates.ts';
import { groupLines, joinItems } from './reader.ts';
import type { PdfDocument, PdfLine, PdfPage, PdfTextItem } from './reader.ts';

export class StatementError extends Error {
  readonly code: 'no_text' | 'unknown_layout' | 'incomplete';
  constructor(code: StatementError['code'], message: string) {
    super(message);
    this.name = 'StatementError';
    this.code = code;
  }
}

export interface StatementLine {
  /** Last 4 digits of the card section the line is in. */
  cardFinal: string | null;
  /** Purchase or posting day as printed, with the year inferred (YYYY-MM-DD). */
  day: string;
  description: string;
  city: string | null;
  /** Cents in reais with the app's sign: a charge is negative, a refund or credit positive (same as source_transactions). */
  amount: number;
  installment: { number: number; total: number } | null;
  /** The purchase in its own currency: `amount` is what was charged in reais, this is what the shop asked. `usd` and `rate` are the dollar value and quote the bank printed. */
  foreign: { currency: string; amount: number; usd?: number; rate?: number } | null;
  kind: 'purchase' | 'installment' | 'fee' | 'credit' | 'payment';
}

export interface ParsedStatement {
  issuer: 'bradescard' | 'bradesco' | 'nubank' | 'itau';
  /** Card product as printed, for example a co-branded Mastercard name. */
  product: string;
  /** Card the bill is issued to (header), and every card section found. */
  headerCardFinal: string | null;
  cardFinals: string[];
  dueDate: string;
  closingDate: string | null;
  /** Statement total in cents (positive = owed). */
  total: number;
  previousBalance: number | null;
  /** Payments and credits from the summary, positive cents. */
  paymentsAndCredits: number | null;
  /** Lines that belong to this statement. Payments of the previous bill are kind 'payment'. */
  lines: StatementLine[];
  /**
   * Sum of the charge and credit lines (not payments) against the total minus the previous balance net of payments.
   * Both numbers count what is owed (positive), `difference` is `sum - expected`. `ok` is true when it is zero or when `note` explains it.
   */
  tieOut: { expected: number; sum: number; difference: number; ok: boolean; note: string | null };
  warnings: string[];
  /** Provisional credits the bill lists under "Transações em Análise". They are not in `lines` because the bank replaces them with a final credit on a later bill. */
  inAnalysis?: StatementLine[];
}

// --- text and numbers ----------------------------------------------------------------------------------------------

const MONEY = '\\d{1,3}(?:\\.\\d{3})*,\\d{2}';
const MONEY_ONLY = new RegExp(`^(${MONEY})$`);
// The lookbehind keeps a long chain such as "1.000.000.000..." from being tried from every digit.
const MONEY_AT_END = new RegExp(`(?<![\\d.,])(${MONEY})\\s*$`);
const RATE = /^\d{1,3},\d{4}$/;
const MINUS = /^[-−–]$/;
const FEE = /\b(IOF|JUROS|MULTA|ENCARGOS?|ANUIDADE|TARIFA|MORA)\b|CUSTO TRANS/i;

/** "1.234,56" to 123456. */
function cents(text: string): number {
  return Number(text.replace(/\./g, '').replace(',', '.').replace('.', '')) || 0;
}

function dmyToIso(text: string): string {
  const [d, m, y] = text.split('/') as [string, string, string];
  return `${y}-${m}-${d}`;
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

function isoIfValid(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * The year of a DD/MM the bill prints without one: the latest date with that DD/MM that is not after the reference day.
 * A plan beyond 12 installments goes back more years until the months since the purchase fit the installment number.
 */
function inferDay(dd: number, mm: number, reference: string, installment: { number: number; total: number } | null): string | null {
  let year = Number(reference.slice(0, 4));
  const refMonths = year * 12 + Number(reference.slice(5, 7));
  for (let guard = 0; guard < 12; guard++, year--) {
    const iso = isoIfValid(year, mm, dd);
    if (!iso || iso > reference) continue;
    if (installment && installment.number > 12 && installment.number - 1 - (refMonths - (year * 12 + mm)) > 1) continue;
    return iso;
  }
  return null;
}

function leftItems(line: PdfLine, cut: number): PdfTextItem[] {
  return line.items.filter((i) => i.x < cut && i.size >= 3 && i.text.trim() !== '');
}

// --- rows ----------------------------------------------------------------------------------------------------------

interface Row {
  day: number;
  month: number;
  /** Absolute cents. */
  amount: number;
  credit: boolean;
  /** Items between the date and the amount. */
  mid: PdfTextItem[];
}

/** A table row: a date at the left margin, then cells, then an amount (with a minus sign after it for a credit). */
function splitRow(items: PdfTextItem[], maxDateX: number): Row | null {
  const first = items[0];
  if (!first || first.x > maxDateX) return null;
  let acc = '';
  let used = 0;
  for (const it of items.slice(0, 5)) {
    acc += it.text.trim();
    used++;
    if (/^\d{2}\/\d{2}$/.test(acc)) break;
    if (acc.length > 5) return null;
  }
  const m = /^(\d{2})\/(\d{2})$/.exec(acc);
  if (!m) return null;
  const rest = items.slice(used);
  let credit = false;
  while (rest.length > 0 && MINUS.test((rest[rest.length - 1] as PdfTextItem).text.trim())) {
    credit = true;
    rest.pop();
  }
  const last = rest.pop();
  if (!last) return null;
  const am = new RegExp(`^(${MONEY})\\s*(-)?$`).exec(last.text.trim());
  if (!am) return null;
  if (am[2]) credit = true;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month, amount: cents(am[1] as string), credit, mid: rest };
}

/** "NAME 12/12" or "NAME(03/10)" at the end of a description. */
function takeInstallment(text: string, parens: boolean): { text: string; installment: { number: number; total: number } | null } {
  // The marker is found from the end, with no pattern in front of it, so a long run of spaces is not tried at every position.
  const tail = text.trimEnd();
  const m = (parens ? /\((\d{2})\/(\d{2})\)$/ : /(\d{2})\/(\d{2})$/).exec(tail);
  if (!m) return { text, installment: null };
  const number = Number(m[1]);
  const total = Number(m[2]);
  if (number < 1 || total < 2 || number > total) return { text, installment: null };
  const before = tail.slice(0, m.index).trimEnd();
  // "NAME 12/12" needs a name that does not end in a digit or a slash, or the match is part of a longer number
  if (!parens && !/[^\d\s/]$/.test(before)) return { text, installment: null };
  return { text: before.trim(), installment: { number, total } };
}

interface RawLine {
  cardFinal: string | null;
  day: number;
  month: number;
  description: string;
  city: string | null;
  amount: number;
  installment: { number: number; total: number } | null;
  foreign: StatementLine['foreign'];
  kind: StatementLine['kind'];
  /** The day is when the bank charged the line (not the purchase), so an installment number says nothing about the year. */
  chargeDate?: boolean;
}

function kindOf(credit: boolean, installment: unknown, description: string): StatementLine['kind'] {
  if (credit) return 'credit';
  if (installment) return 'installment';
  if (FEE.test(description)) return 'fee';
  return 'purchase';
}

// --- shared page facts ---------------------------------------------------------------------------------------------

function allItems(page: PdfPage): PdfTextItem[] {
  return page.lines.flatMap((l) => l.items);
}

/** The first line after the one holding `label` (at most `span` lines) whose text, taken from `minX` on, matches `rx`. */
function readBelow(page: PdfPage, label: RegExp, minX: number, rx: RegExp, span = 6): RegExpExecArray | null {
  const at = page.lines.findIndex((l) => l.items.some((i) => i.x >= minX && label.test(i.text.trim())));
  if (at < 0) return null;
  for (const line of page.lines.slice(at + 1, at + 1 + span)) {
    const m = rx.exec(joinItems(line.items.filter((i) => i.x >= minX - 5)));
    if (m) return m;
  }
  return null;
}

/** The closing date: the date printed right under "Disponível em" in the limits box. */
function closingDate(doc: PdfDocument): string | null {
  for (const page of doc.pages) {
    const items = allItems(page);
    // a bill prints the label once; a page that repeats it thousands of times is not a bill
    for (const label of items.filter((i) => /^Dispon[ií]vel em/.test(i.text.trim())).slice(0, 20)) {
      const near = items.filter((i) => i.x >= label.x - 10 && i.y < label.y && i.y >= label.y - 13);
      for (const line of groupLines(near)) {
        const m = /(\d{2}\/\d{2}\/\d{4})/.exec(line.text);
        if (m) return dmyToIso(m[1] as string);
      }
    }
  }
  return null;
}

interface Summary {
  previous: number | null;
  credits: number | null;
  debits: number | null;
  total: number | null;
}

/** "Resumo da fatura": previous balance, credits and payments, purchases and total. */
function readSummary(page: PdfPage): Summary {
  const out: Summary = { previous: null, credits: null, debits: null, total: null };
  const rx = (label: string): RegExp => new RegExp(`${label}[.\\s]*R\\$\\s*(${MONEY})`);
  const rules: [keyof Summary, RegExp][] = [
    ['previous', rx('Saldo anterior')],
    ['credits', rx('Cr[ée]ditos\\/Pagamentos')],
    ['debits', rx('Compras\\/D[ée]bitos')],
    ['total', rx('\\(=\\)\\s*Total')],
  ];
  for (const line of page.lines) {
    const text = joinItems(line.items.filter((i) => i.x < page.width * 0.33));
    for (const [key, re] of rules) {
      const m = re.exec(text);
      if (m && out[key] === null) out[key] = cents(m[1] as string);
    }
  }
  return out;
}

// --- layouts -------------------------------------------------------------------------------------------------------

interface Parsed {
  issuer: ParsedStatement['issuer'];
  product: string;
  headerCardFinal: string | null;
  cardFinals: string[];
  due: string;
  total: number;
  summary: Summary;
  lines: RawLine[];
  analysis: RawLine[];
  subtotals: number[];
  warnings: string[];
  /** Closing day when the layout prints it (null: not printed). Left out, the Bradesco 'Disponível em' box is searched. */
  closing?: string | null;
  /** Day the years of the lines are counted back from. */
  reference?: string;
  /** Debt carried in from earlier bills, when the layout prints it (Itaú 'Saldo financiado'). Left out: previous balance minus payments. */
  carry?: number;
}

const MASK = /(\d{4})\.\d{2}\*{2}\.\*{4}\.(\d{4})\s*$/;

function parseBradescard(doc: PdfDocument): Parsed {
  const warnings: string[] = [];
  const first = doc.pages[0] as PdfPage;
  const cut = first.width * 0.5;
  const head = readBelow(first, /^Total da fatura/, 0, new RegExp(`R\\$\\s*(${MONEY})\\s+(\\d{2}/\\d{2}/\\d{4})`));
  if (!head) throw new StatementError('incomplete', 'Total e vencimento da fatura não encontrados');

  let product = '';
  let headerCardFinal: string | null = null;
  for (const line of first.lines) {
    const m = /\s\d{4}\.\d{2}\*{2}\.\*{4}\.(\d{4})$/.exec(line.text.trim());
    if (m && m.index > 0) {
      product = clean(line.text.trim().slice(0, m.index));
      headerCardFinal = m[1] as string;
      break;
    }
  }

  const lines: RawLine[] = [];
  const analysis: RawLine[] = [];
  const cardFinals: string[] = [];
  let card: string | null = null;
  let inAnalysis = false;
  let started = false;
  let international = false;
  for (const page of doc.pages) {
    for (const line of page.lines) {
      const items = leftItems(line, cut);
      if (items.length === 0) continue;
      const text = joinItems(items);
      if (!started) {
        if (/^Data\b.*Valor R\$/.test(text)) started = true;
        continue;
      }
      if (/^Transa[çc][õo]es em An[áa]lise/.test(text)) inAnalysis = true;
      else if (/^Nacionais/.test(text)) inAnalysis = false;
      else if (/^Internacionais/.test(text)) {
        inAnalysis = false;
        international = true;
      }
      const mask = MASK.exec(text);
      if (mask) {
        card = mask[2] as string;
        if (!cardFinals.includes(card)) cardFinals.push(card);
        continue;
      }
      const row = splitRow(items, page.width * 0.15);
      if (!row) continue;
      const { text: noMarker, installment } = takeInstallment(joinItems(row.mid), true);
      // The merchant, the city and the country code are padded with spaces. A single space between merchant and city cannot be told apart, so the city stays in the description then.
      const parts = noMarker.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1 && /^[A-Z]{3}$/.test(parts[parts.length - 1] as string)) parts.pop();
      const description = clean(parts[0] ?? noMarker);
      const city = parts.length > 1 ? clean(parts.slice(1).join(' ')) : null;
      const payment = row.credit && /PAGAMENTO RECEBIDO/i.test(description);
      const raw: RawLine = {
        cardFinal: card,
        day: row.day,
        month: row.month,
        description,
        city,
        amount: row.credit ? row.amount : -row.amount,
        installment,
        foreign: null,
        kind: payment ? 'payment' : kindOf(row.credit, installment, description),
      };
      (inAnalysis ? analysis : lines).push(raw);
    }
  }
  if (international) warnings.push('A fatura tem lançamentos internacionais, que ainda não têm leitura própria.');
  if (cardFinals.length === 0 && headerCardFinal) cardFinals.push(headerCardFinal);
  return {
    issuer: 'bradescard',
    product,
    headerCardFinal,
    cardFinals,
    due: dmyToIso(head[2] as string),
    total: cents(head[1] as string),
    summary: readSummary(first),
    lines,
    analysis,
    subtotals: [],
    warnings,
  };
}

const BRADESCO_CARD = /Cart[ãa]o\s+\d{4}\s+X{4}\s+X{4}\s+(\d{4})\s*$/;

function parseBradesco(doc: PdfDocument): Parsed {
  const warnings: string[] = [];
  const first = doc.pages[0] as PdfPage;
  const panelX = first.width * 0.67;
  const head = readBelow(first, /^Total da fatura$/, panelX, new RegExp(`R\\$\\s*(${MONEY})\\s+(\\d{2}/\\d{2}/\\d{4})`));
  if (!head) throw new StatementError('incomplete', 'Total e vencimento da fatura não encontrados');

  // The product is the capitals line right above the "Total da fatura" label, in the header column.
  let product = '';
  const labelAt = first.lines.findIndex((l) => l.items.some((i) => i.x >= panelX && /^Total da fatura$/.test(i.text.trim())));
  for (let i = labelAt - 1; i >= 0 && !product; i--) {
    const text = joinItems((first.lines[i] as PdfLine).items.filter((it) => it.x >= panelX - 20));
    if (/^[A-Z][A-Z0-9 ]+$/.test(text)) product = clean(text);
  }

  const lines: RawLine[] = [];
  const cardFinals: string[] = [];
  const subtotals: number[] = [];
  let headerCardFinal: string | null = null;
  let card: string | null = null;
  let started = false;
  let ended = false;
  let pendingSubtotal = false;
  let cityX = first.width * 0.34;
  let previous: { y: number; line: RawLine } | null = null;
  const cut = first.width * 0.6;
  for (const page of doc.pages) {
    for (const line of page.lines) {
      const items = leftItems(line, cut);
      if (items.length === 0) continue;
      const text = joinItems(items);
      if (!started) {
        const header = new RegExp('N[úu]mero do Cart[ãa]o\\s+\\d{4}\\s+X{4}\\s+X{4}\\s+(\\d{4})').exec(text);
        if (header && headerCardFinal === null) headerCardFinal = header[1] as string;
        if (/Hist[óo]rico de Lan[çc]amentos/.test(text)) {
          started = true;
          const cidade = items.find((i) => i.text.trim() === 'Cidade');
          if (cidade) cityX = cidade.x;
        }
        continue;
      }
      if (ended) continue;
      if (/^Total da fatura em real/.test(text)) {
        ended = true;
        continue;
      }
      const section = BRADESCO_CARD.exec(text);
      if (section && !/^N[úu]mero do/.test(text)) {
        card = section[1] as string;
        if (!cardFinals.includes(card)) cardFinals.push(card);
        previous = null;
        continue;
      }
      if (/^Total para\b/.test(text)) {
        const m = MONEY_AT_END.exec(text);
        if (m) subtotals.push(cents(m[1] as string));
        else pendingSubtotal = true;
        card = null;
        previous = null;
        continue;
      }
      if (pendingSubtotal) {
        pendingSubtotal = false;
        const m = MONEY_AT_END.exec(text);
        if (m) {
          subtotals.push(cents(m[1] as string));
          continue;
        }
      }
      const row = splitRow(items, page.width * 0.15);
      if (!row) {
        // A long city wraps onto a row without a date, in the city column.
        const cell = items[0] as PdfTextItem;
        if (previous && items.length === 1 && Math.abs(cell.x - cityX) < 12 && previous.y - line.y < 14 && /^[A-Za-zÀ-ÿ .'-]+$/.test(cell.text.trim())) {
          previous.line.city = (previous.line.city ?? '') + cell.text.trim();
        }
        continue;
      }
      let description: string;
      let city: string | null = null;
      let foreign: StatementLine['foreign'] = null;
      const rate = row.mid.findIndex((i) => RATE.test(i.text.trim()));
      const textOf = (xs: PdfTextItem[]): string => clean(joinItems(xs));
      const isMoney = (i: PdfTextItem): boolean => MONEY_ONLY.test(i.text.trim());
      if (rate >= 0) {
        // Purchase in another currency: shop text, currency code, original amount, city, dollar amount, quote.
        const moneyAt = row.mid.map((i, k) => (isMoney(i) && k < rate ? k : -1)).filter((k) => k >= 0);
        const firstMoney = moneyAt[0] ?? rate;
        let cur = -1;
        for (let k = firstMoney - 1; k >= 0; k--) {
          if (/^[A-Z]{3}$/.test((row.mid[k] as PdfTextItem).text.trim())) {
            cur = k;
            break;
          }
        }
        description = textOf(row.mid.slice(0, cur >= 0 ? cur : firstMoney));
        const between = row.mid.slice(firstMoney + 1, moneyAt[1] ?? rate).filter((i) => !isMoney(i));
        city = textOf(between) || null;
        if (cur >= 0 && moneyAt[0] !== undefined) {
          foreign = {
            currency: (row.mid[cur] as PdfTextItem).text.trim(),
            amount: cents((row.mid[moneyAt[0]] as PdfTextItem).text.trim()),
            ...(moneyAt[1] !== undefined ? { usd: cents((row.mid[moneyAt[1]] as PdfTextItem).text.trim()) } : {}),
            rate: Math.round(Number((row.mid[rate] as PdfTextItem).text.trim().replace(',', '.')) * 10_000),
          };
        }
      } else {
        const inCity = (i: PdfTextItem): boolean => i.x >= cityX - 6;
        description = textOf(row.mid.filter((i) => !inCity(i)));
        city = textOf(row.mid.filter(inCity)) || null;
      }
      let installment: { number: number; total: number } | null = null;
      const split = takeInstallment(description, false);
      if (split.installment) {
        description = split.text;
        installment = split.installment;
      }
      // the installment can also be a cell of its own, in the city column
      const cell = city ? /^(\d{2})\/(\d{2})$/.exec(city) : null;
      if (cell && Number(cell[2]) >= Number(cell[1]) && Number(cell[2]) > 1) {
        installment = { number: Number(cell[1]), total: Number(cell[2]) };
        city = null;
      }
      // Without a card section a credit is the payment of the previous bill.
      const payment = row.credit && card === null;
      const raw: RawLine = {
        cardFinal: card,
        day: row.day,
        month: row.month,
        description,
        city,
        amount: row.credit ? row.amount : -row.amount,
        installment,
        foreign,
        kind: payment ? 'payment' : kindOf(row.credit, installment, description),
      };
      lines.push(raw);
      previous = { y: line.y, line: raw };
    }
  }
  if (cardFinals.length === 0 && headerCardFinal) cardFinals.push(headerCardFinal);
  return {
    issuer: 'bradesco',
    product,
    headerCardFinal,
    cardFinals,
    due: dmyToIso(head[2] as string),
    total: cents(head[1] as string),
    summary: readSummary(first),
    lines,
    analysis: [],
    subtotals,
    warnings,
  };
}

// --- Nubank and Itaú ------------------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = { JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12 };
const squash = (s: string): string => s.replace(/\s+/g, '');
const NEG = /^[-−–]$/;

/** "14 AGO 2026" to 2026-08-14. */
function longDate(text: string): string | null {
  const m = /(\d{2})\s*([A-ZÇ]{3})\s*(\d{4})/.exec(text);
  const month = m ? MONTHS[m[2] as string] : undefined;
  return m && month ? isoIfValid(Number(m[3]), month, Number(m[1])) : null;
}

/**
 * A money amount at the end of a row. The amount can come as one run or as pieces ("804", ",7", "4") that touch each
 * other, so the pieces are taken from the right while they are digits, dots, commas or a minus and have no gap.
 */
function trailingAmount(items: PdfTextItem[], prefix: RegExp | null): { value: number; credit: boolean; rest: PdfTextItem[] } | null {
  let k = items.length;
  let acc = '';
  while (k > 0) {
    const it = items[k - 1] as PdfTextItem;
    const t = it.text.trim();
    if (!/^[-−–\d.,]+$/.test(t) && !(prefix && t === 'R$')) break;
    const next = items[k];
    if (next && next.x - (it.x + (it.width ?? 0)) > 0.9 * it.size) break;
    acc = t + acc;
    k--;
  }
  const m = new RegExp(`^([-−–])?(${MONEY})$`).exec(acc.replace(/R\$/g, ''));
  if (!m) return null;
  return { value: cents(m[2] as string), credit: m[1] !== undefined, rest: items.slice(0, k) };
}

/** Joins runs into text. In a PDF that positions every few letters alone, the gaps inside words look like spaces, so only a wide gap counts. */
function looseJoin(items: PdfTextItem[], spaced: boolean): string {
  if (!spaced) return clean(joinItems(items));
  const row = [...items].sort((a, b) => a.x - b.x);
  let text = '';
  let end = Number.NEGATIVE_INFINITY;
  for (const it of row) {
    if (text !== '' && it.x - end > 0.45 * it.size && !text.endsWith(' ') && !it.text.startsWith(' ')) text += ' ';
    text += it.text.trim();
    end = it.x + (it.width ?? 0);
  }
  return clean(text);
}

/** A date drawn in one or more runs at the start of a row: DD/MM, or "DD MON" with `named`. */
function datePrefix(items: PdfTextItem[], maxX: number, named: boolean): { day: number; month: number; used: number } | null {
  const first = items[0];
  if (!first || first.x > maxX) return null;
  let acc = '';
  for (let used = 1; used <= Math.min(4, items.length); used++) {
    acc += named ? ` ${(items[used - 1] as PdfTextItem).text.trim()}` : (items[used - 1] as PdfTextItem).text.trim();
    const text = acc.trim();
    const m = named ? /^(\d{2}) ([A-ZÇ]{3})$/.exec(text) : /^(\d{2})\/(\d{2})$/.exec(text);
    if (m) {
      const day = Number(m[1]);
      const month = named ? (MONTHS[m[2] as string] ?? 0) : Number(m[2]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return { day, month, used };
    }
    if (text.length > 6) return null;
  }
  return null;
}

/** A line of text and its amount, for the summary boxes: "label  R$ 1.234,56". */
function labelled(line: PdfLine): { label: string; value: number; credit: boolean } | null {
  const m = new RegExp(`^(.*?)\\s*([-−–])?\\s*R\\$\\s*(${MONEY})$`).exec(line.text.trim());
  return m ? { label: (m[1] as string).trim(), value: cents(m[3] as string), credit: m[2] !== undefined } : null;
}

function installmentTail(text: string): { text: string; installment: { number: number; total: number } | null } {
  const m = /^(.*?)\s*[-–]?\s*Parcela\s+(\d{1,2})\/(\d{1,2})$/.exec(text.trimEnd());
  if (!m) return { text, installment: null };
  const number = Number(m[2]);
  const total = Number(m[3]);
  if (number < 1 || total < 2 || number > total) return { text, installment: null };
  return { text: (m[1] as string).replace(/[\s-–]+$/, '').trim(), installment: { number, total } };
}

const NUBANK_CARD = /^•+\s*(\d{4})$/;

function parseNubank(doc: PdfDocument): Parsed {
  const warnings: string[] = [];
  const pageText = doc.pages.map((p) => p.lines.map((l) => l.text));
  const flat = pageText.flat();
  let due: string | null = null;
  let emission: string | null = null;
  for (const text of flat) {
    const d = /^Data de vencimento:\s*(.+)$/.exec(text);
    if (d && !due) due = longDate(d[1] as string);
    const f = /FATURA\s+(\d{2}\s*[A-ZÇ]{3}\s*\d{4})\s+EMISS[ÃA]O E ENVIO\s+(\d{2}\s*[A-ZÇ]{3}\s*\d{4})/.exec(text);
    if (f) {
      due = due ?? longDate(f[1] as string);
      emission = emission ?? longDate(f[2] as string);
    }
  }
  if (!due || !emission) throw new StatementError('incomplete', 'Vencimento e emissão da fatura não encontrados');

  const summary: Summary = { previous: null, credits: null, debits: null, total: null };
  let inSummary = false;
  for (const page of doc.pages) {
    for (const line of page.lines) {
      if (/^RESUMO DA FATURA ATUAL/.test(line.text)) inSummary = true;
      else if (/^PR[ÓO]XIMAS FATURAS/.test(line.text)) inSummary = false;
      if (!inSummary) continue;
      const l = labelled(line);
      if (!l) continue;
      if (/^Fatura anterior$/.test(l.label) && summary.previous === null) summary.previous = l.value;
      else if (/^Pagamento recebido$/.test(l.label) && summary.credits === null) summary.credits = l.value;
      else if (/^Total de compras/.test(l.label) && summary.debits === null) summary.debits = l.value;
      else if (/^Total a pagar$/.test(l.label) && summary.total === null) summary.total = l.value;
    }
  }
  if (summary.total === null) throw new StatementError('incomplete', 'Total da fatura não encontrado');

  const lines: RawLine[] = [];
  const subtotals: number[] = [];
  const finals: string[] = [];
  let started = false;
  let payments = false;
  for (const page of doc.pages) {
    for (const line of page.lines) {
      const items = line.items.filter((i) => i.size >= 3 && i.text.trim() !== '');
      if (items.length === 0) continue;
      if (!started) {
        if (/^TRANSA[ÇC][ÕO]ES\b/.test(line.text)) started = true;
        continue;
      }
      const date = datePrefix(items, page.width * 0.3, true);
      if (!date) {
        // A cardholder's total or the "Pagamentos" heading, each with a total at the right.
        const l = labelled(line);
        if (l && items[0] && items[0].x < page.width * 0.3) {
          if (/^Pagamentos$/.test(l.label)) payments = true;
          else subtotals.push(l.credit ? -l.value : l.value);
        }
        continue;
      }
      let rest = items.slice(date.used);
      const last = rest[rest.length - 1];
      if (!last) continue;
      let credit = false;
      if (rest.length > 1 && NEG.test(last.text.trim())) rest.pop();
      const tail = rest[rest.length - 1];
      const am = tail ? new RegExp(`^([-−–])?\\s*R\\$\\s*(${MONEY})$`).exec(tail.text.trim()) : null;
      if (!tail || !am) continue;
      rest = rest.slice(0, -1);
      credit = am[1] !== undefined || NEG.test(last.text.trim());
      let card: string | null = null;
      const parts: PdfTextItem[] = [];
      for (const it of rest) {
        const c = NUBANK_CARD.exec(it.text.trim());
        if (c) card = c[1] as string;
        else parts.push(it);
      }
      if (card && !finals.includes(card)) finals.push(card);
      const { text: description, installment } = installmentTail(clean(joinItems(parts)));
      const payment = credit && (payments || /^Pagamento (em|recebido)/i.test(description));
      lines.push({
        cardFinal: card,
        day: date.day,
        month: date.month,
        description,
        city: null,
        amount: credit ? cents(am[2] as string) : -cents(am[2] as string),
        installment,
        foreign: null,
        kind: payment ? 'payment' : kindOf(credit, installment, description),
        chargeDate: true,
      });
    }
  }
  if (lines.length === 0) throw new StatementError('incomplete', 'Nenhum lançamento encontrado');
  // The card the bill goes to: the one with most lines.
  const count = (f: string): number => lines.filter((l) => l.cardFinal === f).length;
  const header = [...finals].sort((a, b) => count(b) - count(a))[0] ?? null;
  return {
    issuer: 'nubank',
    product: 'Nubank',
    headerCardFinal: header,
    cardFinals: finals,
    due,
    total: summary.total,
    summary,
    lines,
    analysis: [],
    subtotals: [subtotals.reduce((a, c) => a + c, 0)].filter(() => subtotals.length > 0),
    warnings,
    closing: emission,
    reference: emission,
  };
}

const ITAU_CARD = /Cart[ãa]o\d{4}\.X{4}\.X{4}\.(\d{4})/;

function parseItau(doc: PdfDocument): Parsed {
  const warnings: string[] = [];
  const first = doc.pages[0] as PdfPage;
  const cut = (page: PdfPage): number => page.width * 0.58;
  const allText = doc.pages.flatMap((p) => p.lines.map((l) => squash(l.text)));
  let due: string | null = null;
  let emission: string | null = null;
  let headerCardFinal: string | null = null;
  for (const t of allText) {
    const d = /Vencimento:(\d{2}\/\d{2}\/\d{4})/.exec(t);
    if (d && !due) due = dmyToIso(d[1] as string);
    const e = /Emiss[ãa]o:(\d{2}\/\d{2}\/\d{4})/.exec(t);
    if (e && !emission) emission = dmyToIso(e[1] as string);
    const c = ITAU_CARD.exec(t);
    if (c && !headerCardFinal) headerCardFinal = c[1] as string;
  }
  if (!due) throw new StatementError('incomplete', 'Vencimento da fatura não encontrado');
  const head = squash(first.lines.slice(0, 3).map((l) => l.text).join(' '));
  const product = /Platinum|Gold|Black|Infinite|Uniclass|Personnalit[eé]/i.exec(head)?.[0] ?? '';

  // Summary box at the right of the first page.
  const summary: Summary = { previous: null, credits: null, debits: null, total: null };
  let financed: number | null = null;
  for (const line of first.lines) {
    const right = line.items.filter((i) => i.x >= cut(first) && i.text.trim() !== '');
    const amount = trailingAmount(right, null);
    if (!amount) continue;
    const label = squash(joinItems(amount.rest));
    const signed = amount.credit ? -amount.value : amount.value;
    if (/Totaldafaturaanterior$/.test(label) && summary.previous === null) summary.previous = amount.value;
    else if (/^Pagamento(s)?efetuado/.test(label) && summary.credits === null) summary.credits = Math.abs(signed);
    else if (/Saldofinanciado$/.test(label) && financed === null) financed = amount.value;
    else if (/Lançamentosatuais$/.test(label) && summary.debits === null) summary.debits = amount.value;
    else if (/Totaldestafatura$/.test(label) && summary.total === null) summary.total = amount.value;
  }
  if (summary.total === null) throw new StatementError('incomplete', 'Total da fatura não encontrado');
  const reference = emission ?? addDays(due, -7);

  const lines: RawLine[] = [];
  const subtotals: number[] = [];
  const finals: string[] = [];
  let mode: 'pay' | 'launch' | null = null;
  let card: string | null = null;
  let international = false;
  const items0 = doc.pages.flatMap((p) => p.lines.flatMap((l) => l.items)).filter((i) => i.size >= 3);
  const spaced = items0.length > 0 && items0.filter((i) => i.text.trim().length <= 2).length / items0.length > 0.35;
  for (const page of doc.pages) {
    for (const line of page.lines) {
      const items = line.items.filter((i) => i.x < cut(page) && i.size >= 3 && i.text.trim() !== '');
      if (items.length === 0) continue;
      const text = squash(joinItems(items));
      if (/Pagamentosefetuados/.test(text)) {
        mode = 'pay';
        continue;
      }
      if (/Lançamentos:/.test(text)) {
        mode = 'launch';
        if (/internacion/i.test(text)) international = true;
        continue;
      }
      if (/Totaldospagamentos|Limitesdecrédito|Limite(total|disponível)/.test(text)) {
        mode = null;
        continue;
      }
      if (/Lançamentosnocartão|Totaldoslançamentosatuais/.test(text)) {
        const a = trailingAmount(items, null);
        if (a && /Lançamentosnocartão/.test(text)) subtotals.push(a.value);
        mode = null;
        continue;
      }
      if (mode === null) continue;
      const cardLine = mode === 'launch' ? new RegExp('^Cart[ãa]o(?:final)?[\\dX.]*?(\\d{4})$').exec(text) : null;
      if (cardLine) {
        card = cardLine[1] as string;
        if (!finals.includes(card)) finals.push(card);
        continue;
      }
      const date = datePrefix(items, page.width * 0.3, false);
      const amount = trailingAmount(date ? items.slice(date.used) : items, null);
      if (!amount) continue;
      const body = amount.rest;
      const raw = looseJoin(body, spaced);
      let description = raw;
      let installment: { number: number; total: number } | null = null;
      const m = /^(.*?)\s*(\d)\s?(\d)\s?\/\s?(\d)\s?(\d)$/.exec(description);
      if (m) {
        const number = Number(`${m[2]}${m[3]}`);
        const total = Number(`${m[4]}${m[5]}`);
        const before = (m[1] as string).trim();
        if (number >= 1 && total >= 2 && number <= total && /[^\d\s/]$/.test(before)) {
          description = before;
          installment = { number, total };
        }
      }
      if (mode === 'pay') {
        if (!date || !amount.credit) continue;
        lines.push({ cardFinal: null, day: date.day, month: date.month, description, city: null, amount: amount.value, installment: null, foreign: null, kind: 'payment' });
        continue;
      }
      let day: number;
      let month: number;
      if (date) {
        day = date.day;
        month = date.month;
      } else {
        // Charges the bank adds on its own (interest, IOF, fees) can come without a date.
        if (!FEE.test(description) || description === '') continue;
        day = Number(reference.slice(8, 10));
        month = Number(reference.slice(5, 7));
      }
      if (card && !finals.includes(card)) finals.push(card);
      lines.push({
        cardFinal: card,
        day,
        month,
        description,
        city: null,
        amount: amount.credit ? amount.value : -amount.value,
        installment,
        foreign: null,
        kind: kindOf(amount.credit, installment, description),
      });
    }
  }
  if (international) warnings.push('A fatura tem lançamentos internacionais, que ainda não têm leitura própria.');
  if (spaced) warnings.push('O PDF separa as letras de cada palavra; as descrições podem sair sem alguns espaços.');
  if (finals.length === 0 && headerCardFinal) finals.push(headerCardFinal);
  const carry = financed ?? undefined;
  return {
    issuer: 'itau',
    product,
    headerCardFinal,
    cardFinals: finals,
    due,
    total: summary.total,
    summary,
    lines,
    analysis: [],
    subtotals,
    warnings,
    closing: emission,
    reference,
    ...(carry !== undefined ? { carry } : {}),
  };
}

// --- result ----------------------------------------------------------------------------------------------------------

const reais = (c: number): string => `R$ ${(Math.abs(c) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function parseStatement(doc: PdfDocument): ParsedStatement {
  if (doc.textChars < 40 || doc.pages.every((p) => p.lines.length === 0)) {
    throw new StatementError('no_text', 'O PDF não tem texto para ler');
  }
  const all = doc.pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n');
  let parsed: Parsed;
  const flatAll = squash(all);
  if (/RESUMO DA FATURA ATUAL/.test(all) && /TRANSA[ÇC][ÕO]ES/.test(all) && /EMISS[ÃA]O E ENVIO/.test(all)) parsed = parseNubank(doc);
  else if (/Resumodafatura/.test(flatAll) && /Totaldestafatura/.test(flatAll) && /Lançamentos:/.test(flatAll)) parsed = parseItau(doc);
  else if (/Fatura mensal/.test(all) && /Total da fatura/.test(all)) parsed = parseBradescard(doc);
  else if (/Fatura Mensal/.test(all) && (/N[úu]mero do Cart[ãa]o/.test(all) || /Hist[óo]rico de Lan[çc]amentos/.test(all))) parsed = parseBradesco(doc);
  else throw new StatementError('unknown_layout', 'O layout da fatura não é reconhecido');

  const warnings = [...parsed.warnings];
  const closing = parsed.closing !== undefined ? parsed.closing : closingDate(doc);
  if (!closing && parsed.closing === undefined) warnings.push('O fechamento não está impresso; o ano das compras foi inferido pelo vencimento.');
  const reference = parsed.reference ?? closing ?? addDays(parsed.due, -7);

  const toLine = (r: RawLine): StatementLine => {
    const day = inferDay(r.day, r.month, reference, r.chargeDate ? null : r.installment);
    if (!day) throw new StatementError('incomplete', 'Uma data de lançamento não pôde ser lida');
    return {
      cardFinal: r.cardFinal,
      day,
      description: r.description,
      city: r.city,
      amount: r.amount,
      installment: r.installment,
      foreign: r.foreign,
      kind: r.kind,
    };
  };
  const lines = parsed.lines.map(toLine);
  const inAnalysis = parsed.analysis.map(toLine);

  const payments = lines.filter((l) => l.kind === 'payment').reduce((a, l) => a + l.amount, 0);
  const sum = -lines.filter((l) => l.kind !== 'payment').reduce((a, l) => a + l.amount, 0);
  const carry = parsed.carry ?? (parsed.summary.previous === null ? 0 : parsed.summary.previous - payments);
  const expected = parsed.total - carry;
  const difference = sum - expected;
  const analysisCredits = inAnalysis.reduce((a, l) => a + l.amount, 0);
  const contested = lines.filter((l) => l.amount > 0 && /CONTESTAD/i.test(l.description)).reduce((a, l) => a + l.amount, 0);
  let note: string | null = null;
  let ok = difference === 0;
  if (!ok && analysisCredits > 0 && difference === analysisCredits) {
    ok = true;
    note = `A fatura já desconta ${reais(analysisCredits)} de uma transação em análise, que fica fora dos lançamentos até virar um crédito definitivo.`;
  } else if (!ok && contested > 0 && difference === -contested) {
    ok = true;
    note = `O crédito de transação contestada (${reais(contested)}) já foi descontado na fatura anterior, quando estava em análise, e esta fatura não o desconta de novo.`;
  }
  if (!ok) {
    throw new StatementError('incomplete', `A soma dos lançamentos não bate com o total da fatura (diferença de ${reais(difference)})`);
  }

  if (parsed.summary.total !== null && parsed.summary.total !== parsed.total) warnings.push('O total do resumo difere do total impresso no topo da fatura.');
  if (parsed.subtotals.length > 0 && parsed.subtotals.reduce((a, c) => a + c, 0) !== parsed.total) warnings.push('A soma dos totais por cartão difere do total da fatura.');

  return {
    issuer: parsed.issuer,
    product: parsed.product,
    headerCardFinal: parsed.headerCardFinal,
    cardFinals: parsed.cardFinals,
    dueDate: parsed.due,
    closingDate: closing,
    total: parsed.total,
    previousBalance: parsed.summary.previous,
    paymentsAndCredits: parsed.summary.credits,
    lines,
    tieOut: { expected, sum, difference, ok, note },
    warnings,
    ...(inAnalysis.length > 0 ? { inAnalysis } : {}),
  };
}
