import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bankHolidays, easterOf, isBusinessDay, moveToBusinessDay, nextBusinessDay, nonBusinessReason, previousBusinessDay } from '../../src/core/business-days.ts';

test('Easter falls on the known Sundays', () => {
  assert.deepEqual([2024, 2025, 2026, 2027].map(easterOf), ['2024-03-31', '2025-04-20', '2026-04-05', '2027-03-28']);
});

test('the movable holidays follow Easter and the fixed ones keep their date', () => {
  const h = bankHolidays(2026);
  assert.deepEqual([...h.keys()].filter((d) => h.get(d) === 'Carnaval'), ['2026-02-16', '2026-02-17']);
  assert.equal(h.get('2026-04-03'), 'Sexta-feira Santa');
  assert.equal(h.get('2026-06-04'), 'Corpus Christi');
  assert.equal(bankHolidays(2025).get('2025-06-19'), 'Corpus Christi');
  for (const day of ['2026-01-01', '2026-04-21', '2026-05-01', '2026-09-07', '2026-10-12', '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25']) assert.ok(h.has(day), day);
  assert.equal(h.size, 13);
});

test('weekends and holidays are not business days', () => {
  assert.deepEqual(['2026-11-06', '2026-11-09', '2026-11-10', '2026-12-24'].map(isBusinessDay), [true, true, true, true]);
  // Saturday, Sunday, Carnival Tuesday, Good Friday, Tiradentes (a Tuesday), Black Consciousness Day (a Friday), Christmas.
  assert.deepEqual(['2026-10-10', '2026-10-11', '2026-02-17', '2026-04-03', '2026-04-21', '2026-11-20', '2026-12-25'].map(isBusinessDay), [false, false, false, false, false, false, false]);
});

test('a day moves to the previous or the next business day, or stays', () => {
  // 10/10/2026 is a Saturday, 25/10/2026 a Sunday.
  assert.equal(previousBusinessDay('2026-10-10'), '2026-10-09');
  assert.equal(previousBusinessDay('2026-10-25'), '2026-10-23');
  // The Monday after (12/10) is a holiday too.
  assert.equal(nextBusinessDay('2026-10-10'), '2026-10-13');
  assert.equal(previousBusinessDay('2026-11-10'), '2026-11-10');
  // 25/12/2026 is a Friday holiday; the weekend and Christmas stack up at the turn of the year.
  assert.equal(previousBusinessDay('2026-12-25'), '2026-12-24');
  assert.equal(previousBusinessDay('2027-01-01'), '2026-12-31');
  assert.equal(nextBusinessDay('2026-04-03'), '2026-04-06');
  assert.deepEqual((['previous', 'next', 'keep'] as const).map((r) => moveToBusinessDay('2026-10-10', r)), ['2026-10-09', '2026-10-13', '2026-10-10']);
});

test('the reason a day is not a business day is named', () => {
  assert.equal(nonBusinessReason('2026-10-10'), 'no sábado');
  assert.equal(nonBusinessReason('2026-10-25'), 'no domingo');
  assert.equal(nonBusinessReason('2026-12-25'), 'no feriado (Natal)');
  assert.equal(nonBusinessReason('2026-11-10'), null);
});
