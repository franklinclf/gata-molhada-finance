import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deleteIncome, incomeIn, saveIncome } from '../../src/api/income.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-20T15:00:00Z');

test('income items are validated, listed, edited, removed and summed per month', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  assert.equal(saveIncome(store, null, { name: '', amount: 100, dayOfMonth: 5 }, NOW).ok, false);
  assert.equal(saveIncome(store, null, { name: 'Salário', amount: 0, dayOfMonth: 5 }, NOW).ok, false);
  assert.equal(saveIncome(store, null, { name: 'Salário', amount: 100, dayOfMonth: 40 }, NOW).ok, false);
  assert.equal(saveIncome(store, null, { name: 'Salário', amount: 100, dayOfMonth: 5, fromMonth: '2026-12', untilMonth: '2026-11' }, NOW).ok, false);
  const salary = saveIncome(store, null, { name: 'Salário', amount: 500000, dayOfMonth: 5 }, NOW);
  assert.equal(salary.ok, true);
  const rent = saveIncome(store, null, { name: 'Aluguel', amount: 100000, dayOfMonth: 10, fromMonth: '2026-11' }, NOW);
  assert.equal(incomeIn(store.listIncome(), '2026-10'), 500000);
  assert.equal(incomeIn(store.listIncome(), '2026-11'), 600000);
  if (!salary.ok || !rent.ok) throw new Error('unreachable');
  assert.equal(saveIncome(store, salary.value.id, { name: 'Salário', amount: 550000, dayOfMonth: 5 }, NOW).ok, true);
  assert.equal(incomeIn(store.listIncome(), '2026-10'), 550000);
  assert.equal(deleteIncome(store, rent.value.id).ok, true);
  assert.equal(deleteIncome(store, rent.value.id).ok, false);
  assert.equal(apiRoute('GET', '/api/income', new URLSearchParams(), store, NOW, '')?.status, 200);
});
