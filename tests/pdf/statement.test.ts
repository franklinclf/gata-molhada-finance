import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPdf } from '../../src/pdf/reader.ts';
import { parseStatement, StatementError } from '../../src/pdf/statement.ts';
import type { ParsedStatement } from '../../src/pdf/statement.ts';
import { buildPdf } from './fixture-pdf.ts';
import type { FixtureRun } from './fixture-pdf.ts';

// Every name, merchant, city and number here is invented. Glyphs are 0.5 em wide in the fixture font.

const CHAR = 0.5;

class Page {
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

const parse = (pages: Page[]): ParsedStatement => parseStatement(readPdf(buildPdf(pages.map((p) => ({ runs: p.runs })))));

function failure(fn: () => unknown): StatementError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof StatementError, `expected a StatementError, got ${String(e)}`);
    return e;
  }
  assert.fail('expected a StatementError');
}

// --- Bradescard layout -------------------------------------------------------------------------------------------

interface BcRow {
  date: string;
  desc: string;
  amount: string;
  credit?: boolean;
}

interface BcSpec {
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

const HOLDER = 'TITULAR FICTICIA';
const MASK = '4455.00**.****.6203';

function bradescard(spec: BcSpec): Page[] {
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

const pad = (merchant: string, city: string, tail = 'BRA'): string => `${merchant.padEnd(24)}${city.padEnd(14)}${tail}`;

test('reads a Bradescard statement: header, lines with signs, installments, and ignores the right-hand boxes', () => {
  const s = parse(
    bradescard({
      total: '170,50',
      previous: '500,00',
      credits: '530,00',
      debits: '200,50',
      rows: [
        { date: '18/02', desc: 'PAGAMENTO RECEBIDO - OBRIGADO', amount: '500,00', credit: true },
        { date: '20/02', desc: pad('MERCADO EXEMPLO', 'CIDADE UM'), amount: '120,50' },
        { date: '25/01', desc: `${'LOJA FICTICIA'.padEnd(24)}${'CIDADE DOIS'.padEnd(14)}(02/03)`, amount: '80,00' },
        { date: '10/02', desc: pad('ESTORNO LOJA', 'CIDADE TRES'), amount: '30,00', credit: true },
      ],
    }),
  );
  assert.equal(s.issuer, 'bradescard');
  assert.equal(s.product, 'CARTAO EXEMPLO PLATINUM');
  assert.equal(s.headerCardFinal, '6203');
  assert.deepEqual(s.cardFinals, ['6203']);
  assert.equal(s.dueDate, '2026-03-17');
  assert.equal(s.closingDate, '2026-03-03');
  assert.equal(s.total, 17050);
  assert.equal(s.previousBalance, 50000);
  assert.equal(s.paymentsAndCredits, 53000);
  assert.deepEqual(
    s.lines.map((l) => [l.day, l.description, l.city, l.amount, l.installment, l.kind, l.cardFinal]),
    [
      ['2026-02-18', 'PAGAMENTO RECEBIDO - OBRIGADO', null, 50000, null, 'payment', '6203'],
      ['2026-02-20', 'MERCADO EXEMPLO', 'CIDADE UM', -12050, null, 'purchase', '6203'],
      ['2026-01-25', 'LOJA FICTICIA', 'CIDADE DOIS', -8000, { number: 2, total: 3 }, 'installment', '6203'],
      ['2026-02-10', 'ESTORNO LOJA', 'CIDADE TRES', 3000, null, 'credit', '6203'],
    ],
  );
  assert.deepEqual(s.tieOut, { expected: 17050, sum: 17050, difference: 0, ok: true, note: null });
  assert.deepEqual(s.warnings, []);
  // nothing personal is kept
  const json = JSON.stringify(s);
  assert.ok(!json.includes('TITULAR'));
  assert.ok(!json.includes('0000012345'));
});

test('a Bradescard merchant and city with a single space between them stay together in the description', () => {
  const s = parse(
    bradescard({
      total: '10,00',
      previous: '0,00',
      credits: '0,00',
      debits: '10,00',
      rows: [{ date: '02/02', desc: 'PADARIA DO BAIRRO CIDADE QUATRO      BRA', amount: '10,00' }],
    }),
  );
  assert.equal(s.lines[0]?.description, 'PADARIA DO BAIRRO CIDADE QUATRO');
  assert.equal(s.lines[0]?.city, null);
});

test('infers the year from the closing date, including a January closing with December purchases', () => {
  const s = parse(
    bradescard({
      due: '19/01/2027',
      closing: '04/01/2027',
      total: '175,00',
      previous: '0,00',
      credits: '0,00',
      debits: '175,00',
      rows: [
        { date: '28/12', desc: pad('LOJA UM', 'CIDADE'), amount: '100,00' },
        { date: '04/01', desc: pad('LOJA DOIS', 'CIDADE'), amount: '50,00' },
        { date: '05/01', desc: `${'LOJA TRES'.padEnd(24)}${'CIDADE'.padEnd(14)}(05/10)`, amount: '25,00' },
      ],
    }),
  );
  assert.deepEqual(s.lines.map((l) => l.day), ['2026-12-28', '2027-01-04', '2026-01-05']);
  assert.equal(s.closingDate, '2027-01-04');
});

test('a plan longer than 12 installments goes back more than one year, and 29/02 only lands on a leap year', () => {
  const s = parse(
    bradescard({
      total: '30,00',
      previous: '0,00',
      credits: '0,00',
      debits: '30,00',
      rows: [
        { date: '15/02', desc: `${'LOJA LONGA'.padEnd(24)}${'CIDADE'.padEnd(14)}(14/24)`, amount: '10,00' },
        { date: '15/02', desc: `${'LOJA CURTA'.padEnd(24)}${'CIDADE'.padEnd(14)}(04/06)`, amount: '10,00' },
        { date: '29/02', desc: `${'LOJA BISSEXTA'.padEnd(24)}${'CIDADE'.padEnd(14)}(05/10)`, amount: '10,00' },
      ],
    }),
  );
  assert.deepEqual(
    s.lines.map((l) => [l.day, l.installment]),
    [
      ['2025-02-15', { number: 14, total: 24 }],
      ['2026-02-15', { number: 4, total: 6 }],
      ['2024-02-29', { number: 5, total: 10 }],
    ],
  );
});

test('without a printed closing date the year comes from the due date and a warning says so', () => {
  const s = parse(
    bradescard({
      closing: null,
      total: '20,00',
      previous: '0,00',
      credits: '0,00',
      debits: '20,00',
      rows: [
        { date: '28/02', desc: pad('LOJA UM', 'CIDADE'), amount: '10,00' },
        { date: '12/03', desc: pad('LOJA DOIS', 'CIDADE'), amount: '10,00' },
      ],
    }),
  );
  assert.equal(s.closingDate, null);
  // due 17/03 minus 7 days is 10/03
  assert.deepEqual(s.lines.map((l) => l.day), ['2026-02-28', '2025-03-12']);
  assert.equal(s.warnings.length, 1);
});

test('a provisional credit in analysis stays out of the lines and the tie-out explains the difference', () => {
  const s = parse(
    bradescard({
      total: '200,00',
      previous: '300,00',
      credits: '300,00',
      debits: '287,00',
      rows: [
        { date: '10/02', desc: 'PAGAMENTO RECEBIDO - OBRIGADO', amount: '300,00', credit: true },
        { date: '11/02', desc: pad('LOJA UM', 'CIDADE'), amount: '200,00' },
        { date: '12/02', desc: pad('LOJA DOIS', 'CIDADE'), amount: '87,00' },
      ],
      analysis: [{ date: '12/02', desc: 'TRANSACAO EM ANALISE', amount: '87,00', credit: true }],
    }),
  );
  assert.equal(s.lines.length, 3);
  assert.equal(s.inAnalysis?.length, 1);
  assert.equal(s.inAnalysis?.[0]?.amount, 8700);
  assert.equal(s.tieOut.difference, 8700);
  assert.equal(s.tieOut.ok, true);
  assert.match(s.tieOut.note ?? '', /em análise/);
});

test('a contested-transaction credit that the bill total does not deduct is explained by a note', () => {
  const s = parse(
    bradescard({
      total: '100,00',
      previous: '200,00',
      credits: '287,00',
      debits: '100,00',
      rows: [
        { date: '10/02', desc: 'PAGAMENTO RECEBIDO - OBRIGADO', amount: '200,00', credit: true },
        { date: '11/02', desc: pad('LOJA UM', 'CIDADE'), amount: '100,00' },
        { date: '12/02', desc: 'CREDITO TRANSACAO CONTESTADA', amount: '87,00', credit: true },
      ],
    }),
  );
  assert.equal(s.tieOut.difference, -8700);
  assert.equal(s.tieOut.ok, true);
  assert.match(s.tieOut.note ?? '', /contestada/);
  assert.equal(s.lines.find((l) => l.description.includes('CONTESTADA'))?.kind, 'credit');
});

test('a difference nothing explains rejects the statement as incomplete', () => {
  const err = failure(() =>
    parse(
      bradescard({
        total: '110,00',
        previous: '0,00',
        credits: '0,00',
        debits: '100,00',
        rows: [{ date: '11/02', desc: pad('LOJA UM', 'CIDADE'), amount: '100,00' }],
      }),
    ),
  );
  assert.equal(err.code, 'incomplete');
  assert.ok(!err.message.includes('TITULAR'));
});

// --- Bradesco layout -------------------------------------------------------------------------------------------

interface BdRow {
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

interface BdSpec {
  due?: string;
  closing?: string | null;
  total: string;
  previous: string;
  credits: string;
  debits: string;
  head: BdRow[];
  sections: { final: string; rows: BdRow[]; subtotal: string }[];
}

function bradesco(spec: BdSpec): Page[] {
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

test('reads a Bradesco statement: sections, payment and fee before the first card, credit with a detached minus, foreign and wrapped city', () => {
  const s = parse(
    bradesco({
      total: '328,19',
      previous: '1.290,45',
      credits: '1.323,45',
      debits: '361,19',
      head: [
        { date: '19/02', desc: 'PAGTO ANTECIPADO PIX', amount: '1.290,45', credit: true, bare: true },
        { date: '06/03', desc: 'CUSTO TRANS. EXTERIOR-IOF', amount: '1,87', bare: true },
      ],
      sections: [
        {
          final: '5188',
          subtotal: '278,19',
          rows: [
            { date: '21/02', desc: 'MERCADO TESTE', city: 'SAO PAULO', amount: '45,00' },
            { date: '22/02', desc: 'TECNOLOGIA EXEMPLO01/04', city: 'CIDADE', amount: '100,00' },
            { date: '23/02', desc: 'SERVICO EXEMPLO*12345678', city: 'DUBLIN', amount: '73,08', foreign: { code: 'EUR', original: '12,00', usd: '13,92', rate: '5,2500' } },
            { date: '24/02', desc: 'LOJA ESTORNO', city: 'CIDADE', amount: '33,00', credit: true },
            { date: '25/02', desc: 'PADARIA TESTE      02/02', city: 'RECIFE', amount: '12,34' },
            { date: '26/02', desc: 'RESTAURANTE EXEMPLO', city: 'FLORIANOPOL', cityTail: 'IS', amount: '78,90' },
          ],
        },
        { final: '7741', subtotal: '50,00', rows: [{ date: '27/02', desc: 'FARMACIA EXEMPLO', city: 'CURITIBA', amount: '50,00' }] },
      ],
    }),
  );
  assert.equal(s.issuer, 'bradesco');
  assert.equal(s.product, 'VISA EXEMPLO');
  assert.equal(s.headerCardFinal, '8850');
  assert.deepEqual(s.cardFinals, ['5188', '7741']);
  assert.equal(s.dueDate, '2026-03-20');
  assert.equal(s.closingDate, '2026-03-06');
  assert.equal(s.total, 32819);
  assert.equal(s.previousBalance, 129045);
  assert.deepEqual(
    s.lines.map((l) => [l.cardFinal, l.day, l.description, l.city, l.amount, l.installment, l.kind]),
    [
      [null, '2026-02-19', 'PAGTO ANTECIPADO PIX', null, 129045, null, 'payment'],
      [null, '2026-03-06', 'CUSTO TRANS. EXTERIOR-IOF', null, -187, null, 'fee'],
      ['5188', '2026-02-21', 'MERCADO TESTE', 'SAO PAULO', -4500, null, 'purchase'],
      ['5188', '2026-02-22', 'TECNOLOGIA EXEMPLO', 'CIDADE', -10000, { number: 1, total: 4 }, 'installment'],
      ['5188', '2026-02-23', 'SERVICO EXEMPLO*12345678', 'DUBLIN', -7308, null, 'purchase'],
      ['5188', '2026-02-24', 'LOJA ESTORNO', 'CIDADE', 3300, null, 'credit'],
      ['5188', '2026-02-25', 'PADARIA TESTE', 'RECIFE', -1234, { number: 2, total: 2 }, 'installment'],
      ['5188', '2026-02-26', 'RESTAURANTE EXEMPLO', 'FLORIANOPOLIS', -7890, null, 'purchase'],
      ['7741', '2026-02-27', 'FARMACIA EXEMPLO', 'CURITIBA', -5000, null, 'purchase'],
    ],
  );
  assert.deepEqual(s.lines[4]?.foreign, { currency: 'EUR', amount: 1200, usd: 1392, rate: 52500 });
  assert.deepEqual(s.tieOut, { expected: 32819, sum: 32819, difference: 0, ok: true, note: null });
  assert.deepEqual(s.warnings, []);
  assert.ok(!JSON.stringify(s).includes('TITULAR'));
  assert.ok(!JSON.stringify(s).includes('FLORES'));
});

test('a Bradesco foreign purchase in dollars keeps the dollar amount and the quote', () => {
  const s = parse(
    bradesco({
      total: '43,35',
      previous: '0,00',
      credits: '0,00',
      debits: '43,35',
      head: [],
      sections: [
        {
          final: '3069',
          subtotal: '43,35',
          rows: [{ date: '10/02', desc: 'ASSINATURA EXTERIOR', city: 'CIDADE EXT', amount: '43,35', foreign: { code: 'USD', original: '8,50', usd: '8,50', rate: '5,1000' } }],
        },
      ],
    }),
  );
  assert.deepEqual(s.lines[0]?.foreign, { currency: 'USD', amount: 850, usd: 850, rate: 51000 });
  assert.equal(s.lines[0]?.city, 'CIDADE EXT');
  assert.equal(s.lines[0]?.amount, -4335);
});

test('a Bradesco bill that does not add up is rejected', () => {
  const err = failure(() =>
    parse(
      bradesco({
        total: '50,00',
        previous: '0,00',
        credits: '0,00',
        debits: '45,00',
        head: [],
        sections: [{ final: '3069', subtotal: '45,00', rows: [{ date: '10/02', desc: 'LOJA UM', city: 'CIDADE', amount: '45,00' }] }],
      }),
    ),
  );
  assert.equal(err.code, 'incomplete');
});

test('an unpaid previous balance is not expected in the lines', () => {
  const s = parse(
    bradesco({
      total: '145,00',
      previous: '100,00',
      credits: '0,00',
      debits: '45,00',
      head: [],
      sections: [{ final: '3069', subtotal: '45,00', rows: [{ date: '10/02', desc: 'LOJA UM', city: 'CIDADE', amount: '45,00' }] }],
    }),
  );
  assert.equal(s.tieOut.expected, 4500);
  assert.equal(s.tieOut.ok, true);
});

// --- failures --------------------------------------------------------------------------------------------------

test('an unrecognised layout is an error', () => {
  const p = new Page();
  p.put(40, 700, 'Extrato de uma conta qualquer, sem a palavra que identifica uma fatura de cartão');
  p.put(40, 680, 'Saldo disponível 1.000,00 e movimento do dia 12/05');
  assert.equal(failure(() => parse([p])).code, 'unknown_layout');
});

test('a PDF with only an image has no text and lists the image', () => {
  const pixels = new Uint8Array(30 * 40 * 3);
  const doc = readPdf(buildPdf([{ images: [{ width: 30, height: 40, data: pixels }] }, { images: [] }]));
  assert.equal(doc.images.length, 1);
  assert.equal(doc.images[0]?.width, 30);
  assert.equal(failure(() => parseStatement(doc)).code, 'no_text');
});
