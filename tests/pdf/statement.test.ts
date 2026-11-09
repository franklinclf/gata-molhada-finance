import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPdf } from '../../src/pdf/reader.ts';
import { parseStatement, StatementError } from '../../src/pdf/statement.ts';
import type { ParsedStatement } from '../../src/pdf/statement.ts';
import { buildPdf } from './fixture-pdf.ts';
import { bradesco, bradescard, pad, Page, pdfOf } from './statements.ts';

// Every name, merchant, city and number here is invented.

const parse = (pages: Page[]): ParsedStatement => parseStatement(readPdf(pdfOf(pages)));

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
