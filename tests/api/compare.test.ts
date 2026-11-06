import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { compareMonths } from '../../src/api/compare.ts';
import * as views from '../../src/api/views.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-10T15:00:00Z');

const account: CanonicalAccount = {
  id: 'card', institution: 'Bank A', kind: 'credit_card', name: 'Card', last4: '1111', balance: 0, balanceSourceId: 'pierre',
  balanceAsOf: '2026-10-10T14:00:00Z', creditLimit: 500000, availableLimit: 400000, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [],
};

function txn(id: string, day: string, amount: number, description: string, category: string, overrides: Partial<CanonicalTransaction> = {}): CanonicalTransaction {
  return { id, accountId: 'card', occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pierre'], excluded: false, ...overrides };
}

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.replaceCanonicalAccounts([account], [], NOW.toISOString());
  store.replaceCanonicalTransactions(
    [
      // Today is day 10: only days 1 to 10 of each month count.
      txn('c1', '2026-10-03', -30000, 'Mercado Azul', 'Supermercado'),
      txn('c2', '2026-10-08', -90000, 'Mercado Azul', 'Supermercado'),
      txn('c3', '2026-10-09', -12000, 'Cafe Novo', 'Restaurantes'),
      txn('c4', '2026-10-20', -99999, 'Mercado Azul', 'Supermercado'),
      txn('c5', '2026-10-05', -50000, 'Cartao pago', 'Pagamento de cartão de crédito'),
      txn('p1', '2026-09-04', -30000, 'Mercado Azul', 'Supermercado'),
      txn('p2', '2026-09-20', -70000, 'Mercado Azul', 'Supermercado'),
      txn('p3', '2026-09-06', -8000, 'Padaria Sol', 'Restaurantes'),
      txn('a1', '2026-08-02', -28000, 'Mercado Azul', 'Supermercado'),
      txn('a2', '2026-07-02', -26000, 'Mercado Azul', 'Supermercado'),
      txn('a3', '2026-07-03', -6000, 'Padaria Sol', 'Restaurantes'),
    ],
    [],
    NOW.toISOString(),
  );
  return store;
}

test('compare: the month so far against the same days before and the average of three closed months', () => {
  const v = compareMonths(seeded(), '2026-10', NOW);
  assert.deepEqual([v.from, v.to, v.previous.from, v.previous.to], ['2026-10-01', '2026-10-10', '2026-09-01', '2026-09-10']);
  // Card payments and charges after day 10 are out.
  assert.equal(v.total.current, 132000);
  assert.equal(v.total.previous, 38000);
  // Same days in Jul, Aug and Sep: 32000, 28000, 38000.
  assert.equal(v.total.average, 32667);
  assert.equal(v.total.delta, 94000);
  assert.deepEqual(v.baselineMonths, ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(v.categories.map((c) => [c.name, c.current, c.previous, c.delta]), [['Supermercado', 120000, 30000, 90000], ['Restaurantes', 12000, 8000, 4000]]);
});

test('compare: uses the same rule as the spending view', () => {
  const store = seeded();
  const range = { from: '2026-10-01', to: '2026-10-10' };
  assert.equal(compareMonths(store, '2026-10', NOW).total.current, views.spending(store, range, 'category', NOW).total);
});

test('compare: names the merchants behind a rise, new merchants and out-of-pattern purchases', () => {
  const v = compareMonths(seeded(), '2026-10', NOW);
  const top = v.drivers[0]!;
  assert.equal(top.category, 'Supermercado');
  assert.equal(top.delta, 90000);
  assert.deepEqual(top.merchants.map((m) => [m.current, m.previous, m.delta, m.count]), [[120000, 30000, 90000, 2]]);
  assert.deepEqual(v.newMerchants.map((m) => [m.amount, m.count]), [[12000, 1]]);
  // The usual Mercado Azul purchase is the median of 28000, 26000, 30000 and 70000 (29000); 90000 is above three times that.
  assert.deepEqual(v.bigPurchases.map((b) => [b.id, b.amount, b.usual]), [['c2', 90000, 29000]]);
});

test('compare: a closed month is compared whole, and months before the data start leave the average', () => {
  const store = seeded();
  const v = compareMonths(store, '2026-09', NOW);
  assert.equal(v.to, '2026-09-30');
  assert.equal(v.total.current, 108000);
  assert.deepEqual(v.baselineMonths, ['2026-06', '2026-07', '2026-08']);
  const early = compareMonths(store, '2026-02', NOW);
  assert.deepEqual(early.baselineMonths, ['2026-01']);
  assert.equal(compareMonths(store, '2026-01', NOW).total.average, null);
});

test('compare: route validates the month and defaults to the current one', () => {
  const store = seeded();
  const get = (query: string) => apiRoute('GET', '/api/spending/compare', new URLSearchParams(query), store, NOW, '');
  assert.equal(get('')?.status, 200);
  assert.equal((get('')?.body as { month: string }).month, '2026-10');
  assert.equal(get('month=2026-13')?.status, 400);
  assert.equal(get('month=2026-12')?.status, 400);
  assert.equal(apiRoute('POST', '/api/spending/compare', new URLSearchParams(), store, NOW, '')?.status, 405);
});
