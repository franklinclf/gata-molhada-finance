import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { deleteIncome, incomeIn, saveIncome } from '../../src/api/income.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { migrate } from '../../src/store/migrations.ts';
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

test('the rule for a day that is not a business day is validated, defaults to the business day before, and is edited', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  assert.equal(saveIncome(store, null, { name: 'Salário', amount: 100, dayOfMonth: 5, nonBusinessRule: 'later' }, NOW).ok, false);
  assert.equal(saveIncome(store, null, { name: 'Salário', amount: 100, dayOfMonth: 5, nonBusinessRule: 7 }, NOW).ok, false);
  const salary = saveIncome(store, null, { name: 'Salário', amount: 100, dayOfMonth: 5 }, NOW);
  const rent = saveIncome(store, null, { name: 'Aluguel', amount: 100, dayOfMonth: 10, nonBusinessRule: 'keep' }, NOW);
  if (!salary.ok || !rent.ok) throw new Error('unreachable');
  assert.deepEqual(store.listIncome().map((i) => [i.name, i.nonBusinessRule]), [['Salário', 'previous'], ['Aluguel', 'keep']]);
  assert.equal(saveIncome(store, rent.value.id, { name: 'Aluguel', amount: 100, dayOfMonth: 10, nonBusinessRule: 'next' }, NOW).ok, true);
  assert.equal(store.listIncome().find((i) => i.id === rent.value.id)?.nonBusinessRule, 'next');
  const listed = apiRoute('GET', '/api/income', new URLSearchParams(), store, NOW, '')?.body as { items: Array<{ nonBusinessRule: string }> };
  assert.deepEqual(listed.items.map((i) => i.nonBusinessRule), ['previous', 'next']);
});

test('income registered before the rule existed gets the business day before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmf-income-migrations-'));
  for (const file of readdirSync(MIGRATIONS).filter((f) => f < '033')) copyFileSync(join(MIGRATIONS, file), join(dir, file));
  const db = new DatabaseSync(':memory:');
  migrate(db, dir);
  db.prepare("INSERT INTO income_items (name, amount, day_of_month, created_at, updated_at) VALUES ('Salário', 100, 10, 'x', 'x')").run();
  migrate(db, MIGRATIONS);
  assert.deepEqual(db.prepare('SELECT non_business_rule FROM income_items').all().map((r) => r.non_business_rule), ['previous']);
});
