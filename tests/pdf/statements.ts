/** Builders of synthetic Bradescard and Bradesco statements, drawn at the positions the real layouts use. Every name, merchant, city and number here is invented. Glyphs are 0.5 em wide in the fixture font. */
import { buildPdf } from './fixture-pdf.ts';
import type { FixtureRun } from './fixture-pdf.ts';

export const CHAR = 0.5;

export class Page {
  readonly runs: FixtureRun[] = [];
  put(x: number, y: number, text: string, size = 7): void {
    this.runs.push({ x, y, text, size });
  }
  /** Text whose right edge is at `end`. */
  right(end: number, y: number, text: string, size = 7): void {
    this.put(end - text.length * size * CHAR, y, text, size);
  }
  /** A date drawn as three runs, the way Bradesco does. */
  pieces(x: number, y: number, text: string, size: number): void {
    const [a, b] = text.split('/') as [string, string];
    const w = size * CHAR;
    this.put(x, y, a, size);
    this.put(x + a.length * w, y, '/', size);
    this.put(x + (a.length + 1) * w, y, b, size);
  }
}

/** The PDF bytes of a statement built from pages. */
export const pdfOf = (pages: Page[]): Uint8Array => buildPdf(pages.map((p) => ({ runs: p.runs })));

// --- Bradescard layout -------------------------------------------------------------------------------------------

export interface BcRow {
  date: string;
  desc: string;
  amount: string;
  credit?: boolean;
}

export interface BcSpec {
  due?: string;
  /** DD/MM/YYYY, or null for a bill that does not print it. */
  closing?: string | null;
  total: string;
  previous: string;
  credits: string;
  debits: string;
  rows: BcRow[];
  analysis?: BcRow[];
}

export const HOLDER = 'TITULAR FICTICIA';
export const MASK = '4455.00**.****.6203';

export function bradescard(spec: BcSpec): Page[] {
  const closing = spec.closing === undefined ? '03/03/2026' : spec.closing;
  const p1 = new Page();
  p1.put(43, 807.9, 'Fatura mensal', 19);
  p1.put(43, 780.2, HOLDER, 9);
  p1.put(43, 769.2, 'CARTAO EXEMPLO PLATINUM', 9);
  p1.put(192, 769.2, MASK, 9);
  p1.put(44, 737.6, 'Total da fatura', 12);
  p1.put(170, 737.6, 'Vencimento', 12);
  p1.put(305, 737.6, 'Limite de compras', 12);
  p1.put(44, 709.3, 'R$', 12);
  p1.put(64, 709.3, spec.total, 12);
  p1.put(173, 709.3, spec.due ?? '17/03/2026', 12);
  p1.put(302, 709.3, 'R$', 12);
  p1.put(322, 709.3, '12.000,00', 12);
  p1.put(49, 439.6, 'Resumo da fatura', 9.5);
  p1.put(43, 418.7, 'Saldo anterior');
  p1.put(129, 418.7, 'R$');
  p1.put(139, 418.7, spec.previous);
  p1.put(297, 418.7, 'R$ 55,55 encargos');
  p1.put(43, 410.2, '(-) Créditos/Pagamentos');
  p1.put(129, 410.2, 'R$');
  p1.put(139, 410.2, spec.credits);
  p1.put(164, 410.2, '-');
  p1.put(43, 402.8, '(+) Compras/Débitos');
  p1.put(129, 402.8, 'R$');
  p1.put(139, 402.8, spec.debits);
  p1.put(43, 395.6, '(=) Total');
  p1.put(129, 395.6, 'R$');
  p1.put(139, 395.6, spec.total);
  // payment slip block: a row that starts with a date, which must not become a line
  p1.put(52, 209.6, '17/03/2026', 7);
  p1.put(145, 209.6, '0000012345', 7);
  p1.right(550, 209.6, '999,99', 7);

  const p2 = new Page();
  p2.put(43, 807.9, 'Fatura mensal', 19);
  p2.put(57, 775.7, 'Lançamentos', 9.5);
  p2.put(313, 775.7, 'Total parcelado para as próximas faturas', 9.5);
  p2.put(49, 764.2, 'Data', 8);
  p2.put(71, 764.2, 'Descrição', 8);
  p2.put(259, 764.2, 'Valor R$', 8);
  if (closing) {
    p2.put(505, 661.4, 'Disponível em:', 7);
    p2.put(523, 653.9, closing, 6);
  }
  let y = 754.6;
  const section = (title: string, rows: BcRow[]): void => {
    p2.put(49, y, title, 9);
    y -= 8.9;
    p2.put(49, y, HOLDER, 8);
    p2.put(216, y, MASK, 8);
    y -= 7.7;
    rows.forEach((r, i) => {
      p2.put(49, y, r.date);
      p2.put(73, y, r.desc);
      p2.right(284, y, r.amount);
      if (r.credit) p2.put(286, y, '-');
      // right-hand boxes share the text rows
      if (i % 2 === 0) {
        p2.put(306, y, 'Compras');
        p2.put(371, y, 'R$');
        p2.put(382, y, '143,21');
        p2.put(524, y, 'R$');
        p2.put(535, y, '88,88');
      }
      y -= 8.6;
    });
    y -= 6;
  };
  section('Nacionais em Reais (R$)', spec.rows);
  if (spec.analysis) section('Transações em Análise em Reais (R$)', spec.analysis);

  const p3 = new Page();
  p3.put(43, 807.9, 'Parcelamento da fatura', 19);
  p3.put(295, 765, 'Total da fatura', 10);
  p3.put(295, 754, 'R$ 12,34', 10);
  return [p1, p2, p3];
}

export const pad = (merchant: string, city: string, tail = 'BRA'): string => `${merchant.padEnd(24)}${city.padEnd(14)}${tail}`;

// --- Bradesco layout -------------------------------------------------------------------------------------------

export interface BdRow {
  date: string;
  desc: string;
  city?: string;
  amount: string;
  credit?: boolean;
  /** Purchase in another currency: code, original amount, dollar amount, quote. */
  foreign?: { code: string; original: string; usd: string; rate: string };
  /** A second line that finishes a long city. */
  cityTail?: string;
  /** Rows without a card section have the description a little to the right. */
  bare?: boolean;
}

export interface BdSpec {
  due?: string;
  closing?: string | null;
  total: string;
  previous: string;
  credits: string;
  debits: string;
  head: BdRow[];
  sections: { final: string; rows: BdRow[]; subtotal: string }[];
}

export function bradesco(spec: BdSpec): Page[] {
  const closing = spec.closing === undefined ? '06/03/2026' : spec.closing;
  const p1 = new Page();
  p1.put(54, 807.6, 'Fatura Mensal', 19);
  p1.put(479, 788.5, 'Página 1 de 2', 8);
  p1.put(415, 766.1, 'VISA EXEMPLO', 9);
  p1.put(421, 748.8, 'Total da fatura', 7);
  p1.put(496, 748.8, 'Vencimento', 7);
  p1.put(105, 732.8, 'RUA DAS FLORES 10', 5);
  p1.put(430, 732.8, 'R$', 6.5);
  p1.put(439, 732.8, spec.total, 6.5);
  const [dd, mm, yyyy] = (spec.due ?? '20/03/2026').split('/') as [string, string, string];
  p1.put(498, 732.8, dd, 7);
  p1.put(505, 732.8, '/', 7);
  p1.put(508.5, 732.8, mm, 7);
  p1.put(515.5, 732.8, '/', 7);
  p1.put(519, 732.8, yyyy, 7);
  p1.put(417, 712, 'Previsão de fechamento da próxima fatura', 4.8);
  p1.pieces(515, 712, '07/04', 4.8);
  p1.put(43, 442.2, 'Resumo da fatura', 10);
  const summary = (y: number, label: string, value: string): void => {
    p1.put(40, y, `${label} .................`, 7);
    p1.put(133, y, 'R$', 7);
    p1.put(143, y, value, 6);
  };
  summary(422.2, 'Saldo anterior', spec.previous);
  summary(413.7, '(-) Créditos/Pagamentos', spec.credits);
  summary(405.2, '(+)Compras/Débitos', spec.debits);
  summary(396.7, '(=)Total', spec.total);

  const p2 = new Page();
  p2.put(53, 803.3, 'Fatura Mensal', 18);
  p2.put(40, 765.7, 'Número do Cartão', 9);
  p2.put(130, 765.7, '5111 XXXX XXXX 8850', 9);
  p2.put(365, 765.7, 'Total para próximas faturas', 9);
  p2.put(43, 750.1, 'Lançamentos', 9.5);
  p2.put(45, 727.5, 'Data');
  p2.put(67, 727.5, 'Histórico de Lançamentos');
  p2.put(204, 727.5, 'Cidade');
  p2.put(253, 727.5, 'US$');
  p2.put(332, 727.5, 'R$');
  if (closing) {
    p2.put(504, 718.8, 'Disponível em', 6.5);
    p2.pieces(507, 711.8, closing.slice(0, 5), 6.5);
    p2.put(507 + 5 * 3.25, 711.8, `/${closing.slice(6)}`, 6.5);
  }
  let y = 719;
  const row = (r: BdRow): void => {
    p2.pieces(45, y, r.date, 6);
    p2.put(r.bare ? 74 : 67, y, r.desc, 6);
    if (r.foreign) {
      p2.put(159, y, r.foreign.code, 6);
      p2.put(190, y, r.foreign.original, 6);
      if (r.city) p2.put(205, y, r.city, 6);
      p2.put(258, y, r.foreign.usd, 6);
      p2.put(286, y, r.foreign.rate, 6);
    } else if (r.city) p2.put(205, y, r.city, 6);
    p2.right(344, y, r.amount, 6);
    if (r.credit) p2.put(347, y - 1.15, '-', 6);
    // right-hand boxes on the same rows
    p2.put(364, y, 'Compras', 6);
    p2.put(401, y, 'R$', 6);
    p2.put(410, y, '12.000,00', 6);
    if (r.cityTail) {
      y -= 5.5;
      p2.put(205, y, r.cityTail, 6);
    }
    y -= 8.5;
  };
  spec.head.forEach(row);
  for (const sec of spec.sections) {
    p2.put(45, y, 'TITULAR EXEMPLO', 7);
    p2.put(210, y, 'Cartão', 7);
    p2.put(232, y, `5111 XXXX XXXX ${sec.final}`, 7);
    y -= 8.5;
    sec.rows.forEach(row);
    p2.put(45, y, 'Total para', 7);
    p2.put(83, y, 'TITULAR EXEMPLO', 7);
    y -= 8.5;
    p2.put(45, y, 'EXEMPLO', 7);
    p2.right(340, y, sec.subtotal, 7);
    y -= 12;
  }
  p2.put(45, y, 'Total da fatura em real', 7);
  p2.right(348, y, spec.total, 7);
  return [p1, p2];
}
