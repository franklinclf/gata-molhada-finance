/**
 * Reads a payment account statement ("EXTRATO") out of the text positions a PDF reader gives. Today only the 99Pay layout
 * is known: columns ID, TIPO, VALOR and HORÁRIO, one row per line with the printed id, a signed amount and the time.
 * The statement prints no balance, so nothing can be tied out; instead rows that cannot be read and repeated ids are
 * reported as warnings, and a file where more than 2% of the rows fail is refused. Name, CPF and account number
 * printed in the header are never read.
 */
import { groupLines } from './reader.ts';
import type { PdfDocument, PdfLine, PdfPage, PdfTextItem } from './reader.ts';
import { StatementError } from './statement.ts';

export interface AccountStatementLine {
  /** The long numeric id as printed: the key that tells two rows apart. */
  id: string;
  /** 0 for the first row with this id, 1 for a later row that has the same id but other content. */
  occurrence: number;
  /** YYYY-MM-DD and HH:MM:SS as printed (Brazil time). */
  day: string;
  time: string;
  type: string;
  /** Cents with the printed sign: money out is negative. */
  amount: number;
}

export interface ParsedAccountStatement {
  issuer: '99pay';
  from: string;
  to: string;
  lines: AccountStatementLine[];
  /** Rows found (lines starting with an id), rows dropped as unreadable or repeated. */
  rows: number;
  failed: number;
  duplicates: number;
  warnings: string[];
}

/** Share of unreadable rows above which the file is refused. */
export const MAX_FAILED_SHARE = 0.02;

const ID = /^\d{16,}$/;
const AMOUNT = /^-?\d{1,3}(?:\.\d{3})*,\d{2}$/;
const WHEN = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/;
const PERIOD = /Per[ií]odo:\s*(\d{2})\/(\d{2})\/(\d{4})\s*at[ée]\s*(\d{2})\/(\d{2})\/(\d{4})/;
const squash = (s: string): string => s.replace(/\s+/g, '');

/** True when the text looks like the 99Pay statement: the title, the period and the four column titles. */
export function isAccountStatement(doc: PdfDocument): boolean {
  const first = doc.pages[0];
  if (!first) return false;
  const head = first.lines.slice(0, 12).map((l) => squash(l.text));
  return head.some((t) => t.startsWith('EXTRATO')) && head.some((t) => t.includes('Período:') || t.includes('Periodo:')) && head.some((t) => /^ID.*TIPO.*VALOR.*HOR[ÁA]RIO$/.test(t));
}

function cents(text: string): number {
  const negative = text.startsWith('-');
  const value = Number(text.replace('-', '').replace(/\./g, '').replace(',', '')) || 0;
  return negative ? -value : value;
}

const validDay = (y: number, m: number, d: number): boolean => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

interface Row {
  page: PdfPage;
  line: PdfLine;
  /** Type text found on the id line itself, and on the lines just above and below. */
  above: string[];
  inline: string;
  below: string[];
  /** Amount or time runs that sit a few points off the id line's baseline. */
  extra: PdfTextItem[];
}

export function parseAccountStatement(doc: PdfDocument): ParsedAccountStatement {
  if (!isAccountStatement(doc)) throw new StatementError('unknown_layout', 'O layout do extrato não é reconhecido');
  const first = doc.pages[0] as PdfPage;
  const period = PERIOD.exec(first.lines.slice(0, 6).map((l) => l.text).join(' '));

  const rows: Row[] = [];
  for (const page of doc.pages) {
    const lines = groupLines(page.lines.flatMap((l) => l.items.filter((i) => i.size >= 3 && i.text.trim() !== '')));
    const idLines = lines.filter((l) => l.items[0] && l.items[0].x < page.width * 0.3 && ID.test(l.items[0].text.trim()));
    const made = idLines.map((line): Row => ({ page, line, above: [], inline: '', below: [], extra: [] }));
    for (const line of lines) {
      if (idLines.includes(line)) continue;
      const text = squash(line.text);
      if (/^ID.*TIPO/.test(text) || line.items.some((i) => i.x < page.width * 0.2)) continue;
      // A type printed on its own line belongs to the id line nearest to it (within a line and a half).
      let best: Row | null = null;
      for (const r of made) if (Math.abs(r.line.y - line.y) < 9 && (!best || Math.abs(r.line.y - line.y) < Math.abs(best.line.y - line.y))) best = r;
      if (!best) continue;
      const numeric = line.items.filter((i) => i.x > page.width * 0.55 && (AMOUNT.test(i.text.trim()) || WHEN.test(i.text)));
      if (numeric.length > 0) {
        best.extra.push(...numeric);
        continue;
      }
      const text1 = line.items.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
      (line.y > best.line.y ? best.above : best.below).push(text1);
    }
    rows.push(...made);
  }
  if (rows.length === 0) throw new StatementError('incomplete', 'Nenhuma linha do extrato foi encontrada');

  const warnings: string[] = [];
  const parsed: AccountStatementLine[] = [];
  let failed = 0;
  let duplicates = 0;
  const seen = new Map<string, AccountStatementLine[]>();
  for (const row of rows) {
    const items = [...row.line.items, ...row.extra].sort((a, b) => a.x - b.x);
    const id = (items[0] as PdfTextItem).text.trim();
    const amountItem = [...items].reverse().find((i) => AMOUNT.test(i.text.trim()));
    const when = WHEN.exec(items.filter((i) => i.x > row.page.width * 0.6).map((i) => i.text).join(' ').replace(/\s+/g, ' '));
    if (!amountItem || !when) {
      failed++;
      continue;
    }
    const [, dd, mm, yyyy, hh, mi, ss] = when as unknown as string[];
    if (!validDay(Number(yyyy), Number(mm), Number(dd)) || Number(hh) > 23 || Number(mi) > 59 || Number(ss) > 59) {
      failed++;
      continue;
    }
    const inline = items.filter((i) => i.x > (items[0] as PdfTextItem).x + 40 && i.x < amountItem.x - 2 && i !== amountItem).map((i) => i.text.trim()).join(' ');
    const type = [...row.above, inline, ...row.below].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const line: AccountStatementLine = { id, occurrence: 0, day: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}:${ss}`, type, amount: cents(amountItem.text.trim()) };
    const same = seen.get(id) ?? [];
    if (same.some((o) => o.day === line.day && o.time === line.time && o.type === line.type && o.amount === line.amount)) {
      duplicates++;
      continue;
    }
    line.occurrence = same.length;
    same.push(line);
    seen.set(id, same);
    parsed.push(line);
  }
  if (failed / rows.length > MAX_FAILED_SHARE) {
    throw new StatementError('incomplete', `${failed} de ${rows.length} linhas do extrato não puderam ser lidas`);
  }
  if (failed > 0) warnings.push(`${failed} de ${rows.length} linhas do extrato não puderam ser lidas e ficaram de fora.`);
  if (duplicates > 0) warnings.push(`${duplicates} linha(s) repetida(s) com o mesmo id foram contadas uma vez.`);
  const reused = [...seen.values()].filter((l) => l.length > 1).length;
  if (reused > 0) warnings.push(`${reused} id(s) aparecem em linhas com valores diferentes; as duas foram mantidas.`);

  const days = parsed.map((l) => l.day).sort();
  const from = period ? `${period[3]}-${period[2]}-${period[1]}` : (days[0] ?? '');
  const to = period ? `${period[6]}-${period[5]}-${period[4]}` : (days[days.length - 1] ?? '');
  return { issuer: '99pay', from, to, lines: parsed, rows: rows.length, failed, duplicates, warnings };
}
