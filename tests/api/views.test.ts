import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { apiRoute } from '../../src/api/routes.ts';
import * as views from '../../src/api/views.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

function acc(overrides: Partial<CanonicalAccount>): CanonicalAccount {
  return {
    id: 'a', institution: 'Bank A', kind: 'checking', name: 'Conta', last4: null, balance: 0, balanceSourceId: 'pierre',
    balanceAsOf: '2026-10-27T14:00:00Z', creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [],
    ...overrides,
  };
}

function txn(overrides: Partial<CanonicalTransaction>): CanonicalTransaction {
  return {
    id: 't', accountId: 'chk', occurredAt: '2026-10-20T15:00:00Z', amount: -1000, description: 'Shop', descriptionRaw: null, status: 'posted',
    installment: null, category: 'Compras', state: 'confirmed', sourceIds: ['pierre'], excluded: false,
    ...overrides,
  };
}

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.replaceCanonicalAccounts(
    [
      acc({ id: 'chk', institution: 'Bank A', balance: 300000 }),
      acc({ id: 'sav', institution: 'Bank B', kind: 'savings', balance: 100000, balanceAsOf: '2026-10-26T10:00:00Z' }),
      acc({ id: 'c1', institution: 'Bank A', kind: 'credit_card', name: 'Card 1', last4: '1111', balance: 50000, creditLimit: 500000, availableLimit: 400000, limitGroupId: 'g1', dueDate: '2026-11-05' }),
      acc({ id: 'c2', institution: 'Bank A', kind: 'credit_card', name: 'Card 2', last4: '2222', balance: 50000, creditLimit: 500000, availableLimit: 400000, limitGroupId: 'g1' }),
    ],
    [{ id: 'g1', institution: 'Bank A', creditLimit: 500000, memberIds: ['c1', 'c2'] }],
    NOW.toISOString(),
  );
  store.replaceCanonicalTransactions(
    [
      txn({ id: 'salary', amount: 500000, category: 'Salário', description: 'Salary' }),
      txn({ id: 'rent', amount: -150000, category: 'Aluguel', description: 'Rent', occurredAt: '2026-10-05T15:00:00Z' }),
      txn({ id: 'own', amount: -20000, category: 'Transferência mesma titularidade', description: 'To savings' }),
      txn({ id: 'billpay', amount: -80000, category: 'Pagamento de cartão de crédito', description: 'Card bill' }),
      txn({ id: 'p1', accountId: 'c1', amount: -3000, category: 'Supermercado', description: 'Market' }),
      txn({ id: 'p2', accountId: 'c1', amount: -2000, category: 'Supermercado', description: 'Market', occurredAt: '2026-10-21T15:00:00Z' }),
      txn({ id: 'refund', accountId: 'c1', amount: 500, category: 'Supermercado', description: 'Market' }),
      txn({ id: 'old', accountId: 'c1', amount: -9999, category: 'Lazer', description: 'Cinema', occurredAt: '2026-09-15T15:00:00Z' }),
      txn({ id: 'stale', accountId: 'c1', amount: -7777, category: 'Lazer', description: 'Ghost', excluded: true, state: 'stale_pending' }),
      txn({ id: 'i1', accountId: 'c1', amount: -10000, category: 'Compras', description: 'Phone', installment: { number: 3, total: 10 }, occurredAt: '2026-10-10T15:00:00Z' }),
      txn({ id: 'i0', accountId: 'c1', amount: -10000, category: 'Compras', description: 'Phone', installment: { number: 2, total: 10 }, occurredAt: '2026-09-10T15:00:00Z' }),
      txn({ id: 'done', accountId: 'c1', amount: -5000, category: 'Compras', description: 'Shoes', installment: { number: 4, total: 4 }, occurredAt: '2026-10-11T15:00:00Z' }),
    ],
    [],
    NOW.toISOString(),
  );
  return store;
}

const THIS_MONTH = { from: '2026-10-01', to: '2026-10-27' };

test('balances: totals, share per institution and the oldest sync time', () => {
  const v = views.balances(seeded(), NOW);
  assert.equal(v.total, 400000);
  assert.deepEqual(v.institutions.map((i) => [i.institution, i.balance, i.share]), [['Bank A', 300000, 0.75], ['Bank B', 100000, 0.25]]);
  assert.equal(v.oldestDataAt, '2026-10-26T10:00:00Z');
  assert.equal(v.accounts.length, 2);
});

test('cards: a shared limit is counted once', () => {
  const v = views.cards(seeded(), NOW);
  assert.equal(v.cards.length, 2);
  assert.equal(v.totals.creditLimit, 500000);
  assert.equal(v.totals.used, 100000);
  assert.equal(v.totals.available, 400000);
  assert.deepEqual(v.limitGroups, [{ id: 'g1', institution: 'Bank A', creditLimit: 500000, used: 100000, available: 400000, cardIds: ['c1', 'c2'], openEstimate: 50000 }]);
});

test('cash flow counts bank accounts only, keeps card bill payments, leaves out own transfers', () => {
  const v = views.cashFlow(seeded(), THIS_MONTH, NOW);
  assert.equal(v.inflow, 500000);
  assert.equal(v.outflow, 230000);
  assert.equal(v.net, v.inflow - v.outflow);
  assert.deepEqual(v.days.map((d) => d.day), ['2026-10-05', '2026-10-20']);
});

test('spending: card purchases and bank outflows, minus refunds, without card payments, transfers or stale entries', () => {
  const v = views.spending(seeded(), THIS_MONTH, 'category', NOW);
  const byName = Object.fromEntries(v.groups.map((g) => [g.name, g.amount]));
  assert.deepEqual(byName, { Aluguel: 150000, Compras: 15000, Supermercado: 4500 });
  assert.equal(v.total, 169500);
  assert.equal(v.daily.reduce((sum, d) => sum + d.amount, 0), 169500);
  assert.deepEqual(v.daily.map((d) => d.day), [...v.daily.map((d) => d.day)].sort());
  assert.equal(Math.round(v.groups[0]!.share * 1000), Math.round((150000 / 169500) * 1000));
});

test('spending by merchant groups on the description', () => {
  const v = views.spending(seeded(), THIS_MONTH, 'merchant', NOW);
  const market = v.groups.find((g) => g.name === 'Market');
  assert.deepEqual([market?.amount, market?.count], [4500, 3]);
});

test('installments: latest seen per purchase, finished ones dropped, remaining and last month computed', () => {
  const v = views.installments(seeded(), NOW);
  assert.equal(v.items.length, 1);
  assert.deepEqual(v.items[0], { accountId: 'c1', description: 'Phone', number: 3, total: 10, installmentAmount: 10000, remainingCount: 7, remainingAmount: 70000, lastMonth: '2027-05' });
  assert.equal(v.monthlyCommitment, 10000);
  assert.equal(v.remainingTotal, 70000);
});

test('routes validate dates and numbers', () => {
  const store = seeded();
  const call = (path: string, q = '') => apiRoute('GET', path, new URLSearchParams(q), store, NOW);
  assert.equal(call('/api/cashflow', 'from=2026-13-01')?.status, 400);
  assert.equal(call('/api/cashflow', 'from=2026-10-10&to=2026-10-01')?.status, 400);
  assert.equal(call('/api/spending', 'by=color')?.status, 400);
  assert.equal(call('/api/transactions', 'limit=0')?.status, 400);
  assert.equal(call('/api/transactions', 'limit=501')?.status, 400);
  assert.equal(call('/api/balances')?.status, 200);
  assert.equal(call('/api/cashflow')?.status, 200);
  assert.equal(call('/api/nothing'), null);
  assert.equal(apiRoute('POST', '/api/balances', new URLSearchParams(), store, NOW)?.status, 405);
});

test('freshness and findings answer from the store', () => {
  const store = seeded();
  assert.deepEqual(views.freshness(store, NOW).sources, []);
  assert.deepEqual(views.findings(store, false), []);
});
