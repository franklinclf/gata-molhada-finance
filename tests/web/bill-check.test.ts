import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapShort, gapText, monthSpan } from '../../web/src/bill-check.ts';
import { MASK } from '../../web/src/format.ts';

test('a run of bills is named by its months, with the year only when it crosses one', () => {
  assert.equal(monthSpan('2026-03', '2026-09'), 'mar a set');
  assert.equal(monthSpan('2026-05', '2026-05'), 'mai');
  assert.equal(monthSpan('2025-11', '2026-02'), 'nov/2025 a fev/2026');
});

test('the difference between app and bank is written in words, so the sign never splits from the amount', () => {
  assert.match(gapText(-25058), /^o app tem R\$\s250,58 a menos que o banco$/);
  assert.match(gapText(1500), /^o app tem R\$\s15,00 a mais que o banco$/);
  assert.equal(gapText(-25058, true), `o app tem ${MASK} a menos que o banco`);
});

test('the short form fits a table column and keeps the amount whole', () => {
  assert.match(gapShort(-25058), /^R\$\s250,58 a menos no app$/);
  assert.match(gapShort(1500), /^R\$\s15,00 a mais no app$/);
});
