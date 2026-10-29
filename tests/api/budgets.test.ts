import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalTransaction } from '../../src/core/canonical.ts';
import { budgetsFor, copyBudgets, createBudgets, resolveBudget, setBudget, suggestBudgets } from '../../src/api/budgets.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-15T15:00:00Z'); // day 15 of 31
const T = NOW.toISOString();

const tx = (id: string, day: string, amount: number, category: string): CanonicalTransaction => ({
  id, accountId: 'chk', occurredAt: `${day}T15:00:00Z`, amount, description: id, descriptionRaw: null, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pluggy'], excluded: false,
});

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.replaceCanonicalAccounts([{ id: 'chk', institution: 'Bank', kind: 'checking', name: 'Conta', last4: null, balance: 0, balanceSourceId: 'pluggy', balanceAsOf: T, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [] }], [], T);
  const list = [
    tx('m1', '2026-10-03', -30000, 'Supermercado'), tx('m2', '2026-10-10', -20000, 'Supermercado'), tx('r1', '2026-10-12', -9000, 'Restaurantes e bares'),
    tx('c1', '2026-10-05', -5000, 'Compras online'),
    tx('s1', '2026-09-04', -40000, 'Supermercado'), tx('s2', '2026-08-04', -60000, 'Supermercado'), tx('s3', '2026-07-04', -50000, 'Supermercado'), tx('v1', '2026-09-20', -8000, 'Compras online'),
  ];
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), T);
  return store;
}
const set = (store: ReturnType<typeof seeded>, name: string, month: string, amount: number | null, recurring = false, scope = 'category') => setBudget(store, { scope, name, month, amount, recurring }, NOW);

test('a month row beats the recurring one, and a recurring row carries forward until a newer one', () => {
  const store = seeded();
  set(store, 'Supermercado', '2026-08', 100000, true);
  set(store, 'Supermercado', '2026-10', 80000, true);
  set(store, 'Supermercado', '2026-09', 90000, false);
  const rows = store.listBudgets();
  const at = (m: string) => resolveBudget(rows, 'category', 'Supermercado', m);
  assert.equal(at('2026-07'), null, 'before the first row there is no budget');
  assert.deepEqual([at('2026-08')?.amount, at('2026-08')?.source], [100000, 'month']);
  assert.deepEqual([at('2026-09')?.amount, at('2026-09')?.recurring], [90000, false]);
  assert.deepEqual([at('2026-11')?.amount, at('2026-11')?.source], [80000, 'recurring']);
  assert.equal(at('2026-12')?.from, '2026-10', 'the change of October does not rewrite August');
  set(store, 'Supermercado', '2026-10', null);
  assert.equal(resolveBudget(store.listBudgets(), 'category', 'Supermercado', '2026-11')?.amount, 100000, 'removing the newest row brings the older one back');
});

test('a month shows actual, pace, the month before and the unbudgeted spending', () => {
  const store = seeded();
  set(store, 'Supermercado', '2026-10', 100000, true);
  const view = budgetsFor(store, '2026-10', NOW);
  assert.deepEqual([view.elapsedDays, view.totalDays], [15, 31]);
  const market = view.lines.find((l) => l.name === 'Supermercado')!;
  assert.deepEqual([market.budget, market.actual, market.previous, market.used], [100000, 50000, 40000, 0.5]);
  assert.equal(market.pace, Math.round((50000 / 15) * 31));
  assert.deepEqual(view.lines.filter((l) => l.budget === null).map((l) => l.name).sort(), ['Compras online', 'Restaurantes e bares']);
  assert.deepEqual([view.totals.budget, view.totals.actual, view.totals.over], [100000, 50000, 0]);
  const past = budgetsFor(store, '2026-09', NOW).lines.find((l) => l.name === 'Supermercado')!;
  assert.equal(past.pace, past.actual, 'a closed month has no projection beyond its actual');
});

test('a group budget counts its categories and a category cannot have a budget inside a budgeted group', () => {
  const store = seeded();
  assert.deepEqual(set(store, 'Alimentação', '2026-10', 120000, true, 'group'), { ok: true, value: {} });
  const view = budgetsFor(store, '2026-10', NOW);
  const group = view.lines.find((l) => l.name === 'Alimentação')!;
  assert.equal(group.actual, 59000, 'Supermercado 500 + Restaurantes 90');
  assert.equal(view.lines.some((l) => l.name === 'Supermercado'), false, 'the categories inside a budgeted group are not listed apart');
  const clash = set(store, 'Supermercado', '2026-10', 50000);
  assert.deepEqual([clash.ok, clash.ok ? 0 : clash.status], [false, 409]);
  const other = seeded();
  set(other, 'Supermercado', '2026-10', 50000);
  assert.equal(set(other, 'Alimentação', '2026-10', 100000, false, 'group').ok, false);
});

test('suggestions average the complete months only and leave out the current one', () => {
  const store = seeded();
  const items = suggestBudgets(store, '2026-10', 3, NOW);
  const market = items.find((i) => i.name === 'Supermercado')!;
  assert.deepEqual([market.months, market.amount], [3, 50000], '(400 + 600 + 500) / 3 = 500, from July to September');
  assert.equal(items.find((i) => i.name === 'Compras online')?.amount, 3000, 'one purchase of 80 over three months is 26,67, rounded to R$ 30');
  assert.equal(suggestBudgets(store, '2026-01', 3, NOW).length, 0, 'nothing before the data starts');
  set(store, 'Supermercado', '2026-10', 1000);
  assert.equal(suggestBudgets(store, '2026-10', 3, NOW).find((i) => i.name === 'Supermercado')?.hasBudget, true);
});

test('creating many is all or nothing, and copying adjusts and skips what it should', () => {
  const store = seeded();
  set(store, 'Supermercado', '2026-10', 100000, true);
  const clash = createBudgets(store, '2026-10', [{ name: 'Compras online', amount: 5000 }, { name: 'Supermercado', amount: 1 }], NOW);
  assert.equal(clash.ok, false);
  assert.equal(store.listBudgets().length, 1, 'the first item was not saved');
  assert.deepEqual(createBudgets(store, '2026-10', [{ name: 'Compras online', amount: 5000 }, { name: 'Compras online', amount: 7000 }], NOW), { ok: true, value: { created: 1 } });
  const copy = copyBudgets(store, { from: '2026-10', to: '2026-11', adjustPercent: 10 }, NOW);
  assert.deepEqual(copy, { ok: true, value: { copied: 2, skipped: 0 } });
  const nov = store.listBudgets().filter((r) => r.month === '2026-11');
  assert.deepEqual(nov.map((r) => [r.name, r.amount, r.recurring]), [['Compras online', 5500, false], ['Supermercado', 110000, false]]);
  assert.deepEqual(copyBudgets(store, { from: '2026-10', to: '2026-11', adjustPercent: 10 }, NOW), { ok: true, value: { copied: 0, skipped: 2 } });
  assert.deepEqual(copyBudgets(store, { from: '2026-10', to: '2026-11', adjustPercent: 20, overwrite: true }, NOW), { ok: true, value: { copied: 2, skipped: 0 } });
  assert.equal(copyBudgets(store, { from: '2026-10', to: '2026-10' }, NOW).ok, false);
  assert.equal(copyBudgets(store, { from: '2026-10', to: '2026-12', adjustPercent: 5000 }, NOW).ok, false);
});

test('the routes validate and answer', () => {
  const store = seeded();
  const call = (method: string, path: string, query = '', payload?: unknown) => apiRoute(method, path, new URLSearchParams(query), store, NOW, payload === undefined ? '' : JSON.stringify(payload));
  assert.equal(call('PUT', '/api/budgets', '', { scope: 'category', name: 'Supermercado', month: '2026-10', amount: 100000, recurring: true })?.status, 200);
  assert.equal(call('PUT', '/api/budgets', '', { scope: 'category', name: 'Supermercado', month: '2026-13', amount: 1 })?.status, 400);
  assert.equal(call('PUT', '/api/budgets', '', { scope: 'category', name: 'Supermercado', month: '2026-10', amount: 12.5 })?.status, 400);
  assert.equal((call('GET', '/api/budgets', 'month=2026-10')?.body as { lines: unknown[] }).lines.length > 0, true);
  assert.equal(call('GET', '/api/budgets', 'month=2026-1')?.status, 400);
  assert.equal(call('GET', '/api/budgets/suggestions', 'months=4')?.status, 400);
  assert.equal(call('GET', '/api/budgets/suggestions', 'month=2026-10&months=3')?.status, 200);
});

import { categoryTrend } from '../../src/api/trends.ts';

test('the trend lists spending per category over the last months, with the average of the closed ones', () => {
  const view = categoryTrend(seeded(), NOW, 4);
  assert.deepEqual(view.months, ['2026-07', '2026-08', '2026-09', '2026-10']);
  const market = view.rows.find((r) => r.name === 'Supermercado')!;
  assert.deepEqual([market.points, market.average, market.current, market.parent], [[50000, 60000, 40000, 50000], 50000, 50000, 'Alimentação']);
  assert.deepEqual(view.rows.find((r) => r.name === 'Compras online')?.points, [0, 0, 8000, 5000]);
  assert.equal(view.rows[0]?.name, 'Supermercado', 'biggest first');
  const route = apiRoute('GET', '/api/spending/trend', new URLSearchParams('months=6'), seeded(), NOW);
  assert.equal(route?.status, 200);
  assert.equal(apiRoute('GET', '/api/spending/trend', new URLSearchParams('months=5'), seeded(), NOW)?.status, 400);
});
