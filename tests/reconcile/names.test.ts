import { test } from 'node:test';
import assert from 'node:assert/strict';
import { institutionKey, normalizeName } from '../../src/reconcile/names.ts';

test('normalizeName removes accents, case and punctuation', () => {
  assert.equal(normalizeName('Crédito Útil Múltiplo MC Plat'), 'credito util multiplo mc plat');
  assert.equal(normalizeName('  PAGA2  INSTITUICAO-DE PAGAMENTO S.A. '), 'paga2 instituicao de pagamento s a');
});

test('institutionKey matches names written differently', () => {
  assert.equal(institutionKey('Crédito Útil'), institutionKey('CREDITO UTIL'));
  assert.notEqual(institutionKey('Banco Central'), institutionKey('Banco Central Cartões'));
});
