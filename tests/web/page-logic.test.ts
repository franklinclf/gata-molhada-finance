import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billPaymentNote, cellMoney, choiceOf, countNote, currentLabel, cycleCaption, endpoints, estimatedNote, otherCycles, resolveCycle, internalNote, localStamp, recurringWhen, splitZero, tileSums, times, trendChange, whenAhead } from '../../web/src/pages/page-logic.ts';

const NOW = new Date('2026-11-08T15:00:00Z');

test('times uses the singular for one occurrence', () => {
  assert.equal(times(1), '1 vez');
  assert.equal(times(2), '2 vezes');
});

test('the transaction count says how many refunds sit under their purchase', () => {
  assert.equal(countNote(10, 10), null);
  assert.equal(countNote(1625, 1646), '21 estornos agrupados com a compra');
  assert.equal(countNote(9, 10), '1 estorno agrupado com a compra');
});

test('the totals note names what is not income or spending, and hides the values on request', () => {
  assert.equal(internalNote({ count: 0, income: 0, expense: 0 }, false), null);
  const text = internalNote({ count: 3, income: 20000, expense: 60000 }, false)!;
  assert.match(text, /^Nas somas há 3 movimentos que não são renda nem gasto/);
  assert.match(text, /entraram R\$\s?200,00 e saíram R\$\s?600,00\.$/);
  assert.match(internalNote({ count: 1, income: 0, expense: 500 }, false)!, /há 1 movimento .*: saíram R\$\s?5,00\.$/);
  assert.doesNotMatch(internalNote({ count: 3, income: 20000, expense: 60000 }, true)!, /\d,\d\d/);
});

test('a recurring item whose expected day passed says it was expected, not that it is next', () => {
  const r = { dayOfMonth: 22, occurrences: 2, nextDay: '2026-10-22' };
  assert.equal(recurringWhen(r, '2026-11-08'), 'todo dia 22 · 2 vezes · esperada em 22/10, ainda não veio');
  assert.equal(recurringWhen({ ...r, occurrences: 1, nextDay: '2026-11-22' }, '2026-11-08'), 'todo dia 22 · 1 vez · próximo 22/11');
});

test('calendar cells get a short form for thousands', () => {
  assert.deepEqual(cellMoney(383647, false).short, '3,8 mil');
  assert.match(cellMoney(383647, false).full, /^3\.836,47$/);
  assert.deepEqual(cellMoney(4250, false), { full: '42,50', short: '42,50' });
  assert.deepEqual(cellMoney(383647, true), { full: '••', short: '••' });
});

test('accounts with no balance are split from the ones with money; debts and other kinds stay', () => {
  const items = [
    { name: 'a', kind: 'bank', value: 0, liability: false },
    { name: 'b', kind: 'bank', value: 500, liability: false },
    { name: 'c', kind: 'bank', value: 0, liability: true },
    { name: 'd', kind: 'manual', value: 0, liability: false },
  ];
  const { shown, zero } = splitZero(items);
  assert.deepEqual(zero.map((i) => i.name), ['a']);
  assert.deepEqual(shown.map((i) => i.name), ['b', 'c', 'd']);
});

test('instants are written in Brazil time, not in UTC', () => {
  assert.equal(localStamp('2026-11-09T03:40:00Z'), '09/11 00:40');
  assert.equal(whenAhead('2026-11-09T03:40:00Z', NOW), 'amanhã 00:40');
  assert.equal(whenAhead('2026-11-08T21:00:00Z', NOW), 'hoje 18:00');
  assert.equal(whenAhead('2026-11-20T15:00:00Z', NOW), '20/11 12:00');
});

test('endpoints give the first and last value of a chart without axes', () => {
  const e = endpoints(['2026-01-31', '2026-02-28', '2026-03-31'], [100000, 150000, 250000], false)!;
  assert.match(e.from, /^31\/01\/2026: R\$\s?1\.000,00$/);
  assert.match(e.to, /^31\/03\/2026: R\$\s?2\.500,00$/);
  assert.equal(endpoints(['2026-01-31'], [1], false), null);
  assert.doesNotMatch(endpoints(['2026-01-31', '2026-02-28'], [1, 2], true)!.to, /\d,\d\d/);
});

test('the totals of one bill leave out its payment, which would cancel the purchases', () => {
  const sums = { income: 134530, expense: 134530, net: 0 };
  const internal = { count: 1, income: 134530, expense: 0 };
  assert.deepEqual(tileSums(sums, internal, true), { income: 0, expense: 134530, net: -134530 });
  assert.deepEqual(tileSums(sums, internal, false), sums);
  assert.match(billPaymentNote(internal, false)!, /^O pagamento da fatura \(R\$\s?1\.345,30\) aparece na lista, mas não entra nas somas\.$/);
  assert.equal(billPaymentNote({ count: 0, income: 0, expense: 0 }, false), null);
  assert.match(billPaymentNote({ count: 2, income: 1000, expense: 500 }, false)!, /^2 pagamentos e movimentos/);
});

test('the trend row compares the month in progress with the whole month before, and flags only a rise', () => {
  assert.equal(trendChange(100, null, false), null, 'no month before');
  assert.equal(trendChange(0, 0, false), null);
  assert.deepEqual(trendChange(5000, 0, false), { text: 'nada no mês passado', rising: false });
  const up = trendChange(30000, 20000, false)!;
  assert.match(up.text, /^\+R\$\s?100,00$/);
  assert.equal(up.rising, true);
  const down = trendChange(5000, 20000, false)!;
  assert.match(down.text, /^−R\$\s?150,00$/);
  assert.equal(down.rising, false);
  assert.equal(trendChange(20000, 20000, false)!.text, 'igual');
  assert.doesNotMatch(trendChange(30000, 20000, true)!.text, /\d,\d\d/);
});

const BARS = [{ key: '2026-10', current: false }, { key: '2026-11', current: true }, { key: '2026-12', current: false }];

test('the current cycle is the bar flagged current, and nothing is asked for before the bars are known', () => {
  assert.equal(resolveCycle('current', BARS), '2026-11');
  assert.equal(resolveCycle('current', undefined), undefined);
  // No card has an open bill: the current cycle is everything unpaid.
  assert.equal(resolveCycle('current', [{ key: '2026-10', current: false }]), 'open');
  assert.equal(resolveCycle('open', undefined), 'open');
  assert.equal(resolveCycle('2026-10', undefined), '2026-10');
});

test('the current cycle button carries the short name of its month, and the month of the current bill is the button, not a list entry', () => {
  assert.equal(currentLabel('2026-11'), 'Ciclo atual (nov)');
  assert.equal(currentLabel('open'), 'Ciclo atual');
  assert.equal(currentLabel(undefined), 'Ciclo atual');
  assert.equal(choiceOf('2026-11', '2026-11'), 'current');
  assert.equal(choiceOf('2026-10', '2026-11'), '2026-10');
});

test('the dropdown lists the other cycles, newest first, with no "Em aberto" and not the current one', () => {
  assert.deepEqual(otherCycles(['2026-09', '2026-10', '2026-11'], '2026-11', 'current'), ['2026-10', '2026-09']);
  // A month picked on the chart is listed even when no bill of it is closed yet.
  assert.deepEqual(otherCycles(['2026-10'], '2026-11', '2026-12'), ['2026-12', '2026-10']);
  assert.deepEqual(otherCycles(['2026-10'], '2026-11', 'open'), ['2026-10']);
});

test('the caption says what each view counts', () => {
  assert.equal(cycleCaption('2026-11', '2026-11-08'), 'Faturas que vencem em novembro');
  assert.equal(cycleCaption('2027-01', '2026-11-08'), 'Faturas que vencem em janeiro de 2027');
  assert.equal(cycleCaption('open', '2026-11-08'), 'Tudo que falta pagar nos cartões');
});

test('the list says how many estimated installments are in its totals', () => {
  assert.equal(estimatedNote({ count: 0, expense: 0 }, false), null);
  assert.match(estimatedNote({ count: 1, expense: 5500 }, false)!, /^As somas incluem 1 parcela estimada \(R\$\s?55,00\)/);
  assert.match(estimatedNote({ count: 3, expense: 5500 }, false)!, /3 parcelas estimadas/);
  assert.doesNotMatch(estimatedNote({ count: 3, expense: 5500 }, true)!, /\d,\d\d/);
});
