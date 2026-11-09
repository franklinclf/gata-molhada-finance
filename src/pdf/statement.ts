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
  issuer: 'bradescard' | 'bradesco';
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

// --- result ----------------------------------------------------------------------------------------------------------

const reais = (c: number): string => `R$ ${(Math.abs(c) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function parseStatement(doc: PdfDocument): ParsedStatement {
  if (doc.textChars < 40 || doc.pages.every((p) => p.lines.length === 0)) {
    throw new StatementError('no_text', 'O PDF não tem texto para ler');
  }
  const all = doc.pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n');
  let parsed: Parsed;
  if (/Fatura mensal/.test(all) && /Total da fatura/.test(all)) parsed = parseBradescard(doc);
  else if (/Fatura Mensal/.test(all) && (/N[úu]mero do Cart[ãa]o/.test(all) || /Hist[óo]rico de Lan[çc]amentos/.test(all))) parsed = parseBradesco(doc);
  else throw new StatementError('unknown_layout', 'O layout da fatura não é reconhecido');

  const warnings = [...parsed.warnings];
  const closing = closingDate(doc);
  if (!closing) warnings.push('O fechamento não está impresso; o ano das compras foi inferido pelo vencimento.');
  const reference = closing ?? addDays(parsed.due, -7);

  const toLine = (r: RawLine): StatementLine => {
    const day = inferDay(r.day, r.month, reference, r.installment);
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
  const carry = parsed.summary.previous === null ? 0 : parsed.summary.previous - payments;
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
