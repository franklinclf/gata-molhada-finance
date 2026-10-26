import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCashFlow, toStatus } from '../../src/adapters/cash-flow.ts';
import { asRecord, optDay, optNumber, reqIsoInstant, reqNumber, reqString } from '../../src/adapters/shape.ts';
import { SourceFormatError } from '../../src/core/http.ts';

test('toCashFlow keeps the sign of bank amounts', () => {
  assert.equal(toCashFlow('checking', -142.87), -14287);
  assert.equal(toCashFlow('savings', 2.35), 235);
});

test('toCashFlow flips credit card amounts', () => {
  assert.equal(toCashFlow('credit_card', 49.9), -4990);
  assert.equal(toCashFlow('credit_card', -804.74), 80474);
  assert.equal(Object.is(toCashFlow('credit_card', 0), 0), true);
});

test('toStatus maps source statuses', () => {
  assert.equal(toStatus('POSTED'), 'posted');
  assert.equal(toStatus('PENDING'), 'pending');
  assert.equal(toStatus('CANCELLED'), null);
});

test('shape helpers read strings, numbers and dates', () => {
  const r = asRecord({ a: 'x', n: '12.5', m: 3, when: '2026-10-26T03:00:00.000Z', bad: 'nope' }, 'item');
  assert.equal(reqString(r, 'a', 'item'), 'x');
  assert.equal(reqNumber(r, 'n', 'item'), 12.5);
  assert.equal(optNumber(r, 'missing'), null);
  assert.equal(optNumber(r, 'm'), 3);
  assert.equal(reqIsoInstant(r, 'when', 'item'), '2026-10-26T03:00:00.000Z');
  assert.equal(optDay(r, 'when'), '2026-10-26');
  assert.equal(optDay(r, 'bad'), null);
});

test('shape helpers raise a format error that names the path', () => {
  const r = asRecord({ a: 1 }, 'item');
  assert.throws(() => reqString(r, 'a', 'item'), (e: Error) => e instanceof SourceFormatError && /item\.a/.test(e.message));
  assert.throws(() => reqNumber(r, 'zzz', 'item'), SourceFormatError);
  assert.throws(() => reqIsoInstant(asRecord({ d: 'not a date' }, 'x'), 'd', 'x'), /not a valid date/);
  assert.throws(() => asRecord([], 'item'), /expected an object/);
});
