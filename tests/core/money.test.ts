import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, sumCents, formatBRL } from '../../src/core/money.ts';

test('toCents converts numbers without float drift', () => {
  assert.equal(toCents(2.35), 235);
  assert.equal(toCents(-142.87), -14287);
  assert.equal(toCents(0.1 + 0.2), 30);
});

test('toCents converts decimal strings', () => {
  assert.equal(toCents('280.90'), 28090);
  assert.equal(toCents('0.00'), 0);
});

test('toCents rounds values with more than two decimals', () => {
  assert.equal(toCents(201.7918), 20179);
});

test('toCents never returns negative zero', () => {
  assert.equal(Object.is(toCents(-0.001), 0), true);
});

test('toCents rejects invalid input', () => {
  assert.throws(() => toCents('abc'), /Invalid money value/);
  assert.throws(() => toCents(''), /Invalid money value/);
  assert.throws(() => toCents(Number.NaN), /Invalid money value/);
});

test('sumCents adds integers exactly', () => {
  assert.equal(sumCents([28090, 120535, 30943]), 179568);
  assert.equal(sumCents([]), 0);
});

test('formatBRL uses pt-BR currency format', () => {
  assert.equal(formatBRL(123456).replace(/\u00a0/g, ' '), 'R$ 1.234,56');
  assert.equal(formatBRL(-14287).replace(/\u00a0/g, ' '), '-R$ 142,87');
});
