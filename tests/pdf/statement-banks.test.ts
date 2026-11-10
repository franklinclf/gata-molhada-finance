import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPdf } from '../../src/pdf/reader.ts';
import { parseAccountStatement } from '../../src/pdf/account-statement.ts';
import { parseStatement, StatementError } from '../../src/pdf/statement.ts';
import { pdfOf } from './statements.ts';
import { itau, nubank, pay99, type ItSpec, type NuSpec, type PayRow } from './statements-banks.ts';

// Every name, merchant, card and amount here is invented.

const NU: NuSpec = {
  due: '21 AGO 2026',
  emission: '14 AGO 2026',
  previous: '500,00',
  payment: '500,00',
  purchases: '1.350,00',
  total: '1.320,00',
  sections: [
    {
      name: 'Pessoa Ficticia',
      total: '1.100,00',
      rows: [
        { date: '14 JUL', desc: 'Loja Alfa - NuPay - Parcela 3/10', amount: 'R$ 400,00' },
        { date: '16 JUL', card: '1111', desc: 'Mercado Beta', amount: 'R$ 700,00' },
        { date: '20 JUL', card: '1111', desc: 'Estorno de "Mercado Beta"', amount: '−R$ 30,00' },
      ],
    },
    {
      name: 'Outra Pessoa',
      total: '220,00',
      rows: [
        { date: '02 AGO', card: '2222', desc: 'Cafe Gama', amount: 'R$ 200,00' },
        { date: '03 AGO', card: '2222', desc: 'Juros e IOF do rotativo', amount: 'R$ 50,00' },
      ],
    },
  ],
  payments: [{ date: '14 JUL', desc: 'Pagamento em 14 JUL', amount: '−R$ 500,00' }],
};

test('a Nubank statement with two cardholders is read, with its credit, fee and installment, and ties out', () => {
  const s = parseStatement(readPdf(pdfOf(nubank(NU))));
  assert.equal(s.issuer, 'nubank');
  assert.equal(s.dueDate, '2026-08-21');
  assert.equal(s.closingDate, '2026-08-14');
  assert.equal(s.total, 132000);
  assert.deepEqual(s.cardFinals.sort(), ['1111', '2222']);
  assert.deepEqual(s.tieOut, { expected: 132000, sum: 132000, difference: 0, ok: true, note: null });
  assert.deepEqual(s.lines.map((l) => [l.day, l.description, l.amount, l.kind, l.cardFinal, l.installment]), [
    ['2026-07-14', 'Loja Alfa - NuPay', -40000, 'installment', null, { number: 3, total: 10 }],
    ['2026-07-16', 'Mercado Beta', -70000, 'purchase', '1111', null],
    ['2026-07-20', 'Estorno de "Mercado Beta"', 3000, 'credit', '1111', null],
    ['2026-08-02', 'Cafe Gama', -20000, 'purchase', '2222', null],
    ['2026-08-03', 'Juros e IOF do rotativo', -5000, 'fee', '2222', null],
    ['2026-07-14', 'Pagamento em 14 JUL', 50000, 'payment', null, null],
  ]);
  assert.deepEqual(s.warnings, []);
});

test('a Nubank installment above 12 keeps the charge year (the printed day is the charge, not the purchase)', () => {
  const spec: NuSpec = { ...NU, sections: [{ name: 'Pessoa Ficticia', total: '10,00', rows: [{ date: '14 JUL', desc: 'Loja Alfa - Parcela 18/18', amount: 'R$ 1.320,00' }] }], purchases: '1.320,00' };
  const s = parseStatement(readPdf(pdfOf(nubank(spec))));
  assert.equal(s.lines[0]!.day, '2026-07-14');
});

test('a Nubank statement whose lines do not sum to the total is refused', () => {
  const bad = { ...NU, total: '1.321,00' };
  assert.throws(() => parseStatement(readPdf(pdfOf(nubank(bad)))), (e: unknown) => e instanceof StatementError && e.code === 'incomplete');
});

const IT: ItSpec = {
  due: '15/11/2026',
  emission: '08/11/2026',
  previous: '800,00',
  paid: '537,19',
  financed: '262,81',
  current: '440,32',
  total: '703,13',
  payments: [{ date: '15/10', desc: 'Pagamento via conta', amount: '537,19' }],
  purchases: [
    { date: '28/11', desc: 'LOJA ALFA 12/12', amount: '276,90' },
    { date: '11/10', desc: 'APP BETA ASSINATURA', amount: '6,00' },
    { date: '12/10', desc: 'ESTORNO LOJA GAMA', amount: '-10,00' },
    { date: '06/06', desc: 'FARMACIA DELTA 05/05', amount: '118,00' },
  ],
  charges: [
    { date: '08/11', desc: 'ENCARGOS FINANCIAMENTO', amount: '47,84' },
    { date: '08/11', desc: 'IOF FINANCIAMENTO', amount: '1,58' },
  ],
};

test('an Itaú statement with a financed balance, fees and a future-installments table ties out and keeps only real lines', () => {
  const s = parseStatement(readPdf(pdfOf(itau(IT))));
  assert.equal(s.issuer, 'itau');
  assert.equal(s.product, 'Platinum');
  assert.equal(s.dueDate, '2026-11-15');
  assert.equal(s.closingDate, '2026-11-08');
  assert.equal(s.headerCardFinal, '4321');
  assert.equal(s.total, 70313);
  assert.equal(s.previousBalance, 80000);
  assert.deepEqual(s.tieOut, { expected: 44032, sum: 44032, difference: 0, ok: true, note: null });
  assert.deepEqual(s.lines.map((l) => [l.day, l.description, l.amount, l.kind, l.installment]), [
    ['2026-10-15', 'Pagamento via conta', 53719, 'payment', null],
    ['2025-11-28', 'LOJA ALFA', -27690, 'installment', { number: 12, total: 12 }],
    ['2026-10-11', 'APP BETA ASSINATURA', -600, 'purchase', null],
    ['2026-10-12', 'ESTORNO LOJA GAMA', 1000, 'credit', null],
    ['2026-06-06', 'FARMACIA DELTA', -11800, 'installment', { number: 5, total: 5 }],
    ['2026-11-08', 'ENCARGOS FINANCIAMENTO', -4784, 'fee', null],
    ['2026-11-08', 'IOF FINANCIAMENTO', -158, 'fee', null],
  ]);
  assert.ok(!s.lines.some((l) => /FUTURA/.test(l.description) || l.amount === -55555));
});

test('an Itaú statement drawn in small pieces with gaps inside the words reads the same numbers', () => {
  const plain = parseStatement(readPdf(pdfOf(itau(IT))));
  const spaced = parseStatement(readPdf(pdfOf(itau({ ...IT, spaced: true }))));
  const shape = (s: typeof plain) => s.lines.map((l) => [l.day, l.amount, l.kind, l.installment]);
  assert.deepEqual(shape(spaced), shape(plain));
  assert.deepEqual(spaced.tieOut, plain.tieOut);
  assert.equal(spaced.total, plain.total);
  assert.equal(spaced.dueDate, plain.dueDate);
  assert.ok(spaced.warnings.some((w) => /separa as letras/.test(w)));
});

test('an Itaú statement that does not tie out is refused, and unknown text keeps unknown_layout', () => {
  assert.throws(() => parseStatement(readPdf(pdfOf(itau({ ...IT, total: '693,14' })))), (e: unknown) => e instanceof StatementError && e.code === 'incomplete');
  const other = pay99([]);
  assert.throws(() => parseStatement(readPdf(pdfOf(other))), (e: unknown) => e instanceof StatementError && e.code === 'unknown_layout');
});

const ROWS: PayRow[] = [
  { id: '20261109001433434810333388922744', type: 'Lucro', amount: '3,11', when: '09/11/2026 04:06:46' },
  { id: '20261108001433434810333378066896', type: 'Corridas', amount: '-6,28', when: '07/11/2026 19:46:16' },
  { id: '20261108001433434810333378066485', type: 'Corridas', amount: '6,28', when: '07/11/2026 19:45:32' },
  { id: '20261102001433434810333333827707', type: '', amount: '-312,40', when: '02/11/2026 12:19:34', pix: 'enviado' },
  { id: '20261102001433434810333333969416', type: '', amount: '250,00', when: '02/11/2026 12:18:18', pix: 'recebido' },
  { id: '20251231001433434810333333333334', type: 'Lucro', amount: '1,50', when: '31/12/2025 05:00:00' },
];

test('a 99Pay statement is read: signs, a Pix type on its own lines, the paired charge and reversal, and the period', () => {
  const a = parseAccountStatement(readPdf(pdfOf(pay99(ROWS))));
  assert.equal(a.issuer, '99pay');
  assert.deepEqual([a.from, a.to, a.rows, a.failed, a.duplicates, a.warnings], ['2026-01-01', '2026-11-09', 6, 0, 0, []]);
  assert.deepEqual(a.lines.map((l) => [l.id.slice(-6), l.day, l.time, l.type, l.amount]), [
    ['922744', '2026-11-09', '04:06:46', 'Lucro', 311],
    ['066896', '2026-11-07', '19:46:16', 'Corridas', -628],
    ['066485', '2026-11-07', '19:45:32', 'Corridas', 628],
    ['827707', '2026-11-02', '12:19:34', 'Pagamento com Pix enviado', -31240],
    ['969416', '2026-11-02', '12:18:18', 'Pagamento com Pix recebido', 25000],
    ['333334', '2025-12-31', '05:00:00', 'Lucro', 150],
  ]);
});

test('99Pay: a repeated row is counted once with a warning, and a repeated id with other content keeps both', () => {
  const dup = [...ROWS, ROWS[0]!, { ...ROWS[1]!, amount: '-9,99' }];
  const a = parseAccountStatement(readPdf(pdfOf(pay99(dup))));
  assert.equal(a.rows, 8);
  assert.equal(a.duplicates, 1);
  assert.equal(a.lines.length, 7);
  assert.deepEqual(a.lines.filter((l) => l.id === ROWS[1]!.id).map((l) => [l.occurrence, l.amount]), [[0, -628], [1, -999]]);
  assert.equal(a.warnings.length, 2);
});

test('99Pay: unreadable rows warn when few and refuse the file above 2%', () => {
  const rows: PayRow[] = Array.from({ length: 60 }, (_, i) => ({ id: `2026010100140010158700000${String(1000 + i)}`, type: 'Lucro', amount: '1,00', when: '01/01/2026 05:00:00' }));
  const one = rows.map((r, i) => (i === 7 ? { ...r, when: 'sem horario' } : r));
  const a = parseAccountStatement(readPdf(pdfOf(pay99(one))));
  assert.equal(a.lines.length, 59);
  assert.equal(a.failed, 1);
  assert.equal(a.warnings.length, 1);
  const two = rows.map((r, i) => (i === 7 || i === 9 ? { ...r, amount: 'x' } : r));
  assert.throws(() => parseAccountStatement(readPdf(pdfOf(pay99(two)))), (e: unknown) => e instanceof StatementError && e.code === 'incomplete');
});
