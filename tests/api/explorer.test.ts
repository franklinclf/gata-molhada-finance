import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { transactionDetail } from '../../src/api/detail.ts';
import { explore, type ExplorerQuery } from '../../src/api/explorer.ts';
import { addCategory, listCategories, removeCategory, setAccountHidden, setTransactionCategory } from '../../src/api/mutations.ts';
import { apiRoute } from '../../src/api/routes.ts';
import * as views from '../../src/api/views.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

function acc(overrides: Partial<CanonicalAccount>): CanonicalAccount {
  return {
    id: 'chk', institution: 'Bank A', kind: 'checking', name: 'Conta', last4: null, balance: 0, balanceSourceId: 'pierre', balanceAsOf: '2026-10-27T14:00:00Z',
    creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [], ...overrides,
  };
}

function txn(id: string, overrides: Partial<CanonicalTransaction> = {}): CanonicalTransaction {
  return {
    id, accountId: 'chk', occurredAt: '2026-10-20T15:00:00Z', amount: -1000, description: 'Shop', descriptionRaw: 'SHOP RAW', status: 'posted', installment: null,
    category: 'Compras', state: 'confirmed', sourceIds: ['pierre'], excluded: false, ...overrides,
  };
}

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.replaceCanonicalAccounts([acc({ id: 'chk' }), acc({ id: 'card', institution: 'Bank B', kind: 'credit_card', name: 'Card', last4: '9999' })], [], NOW.toISOString());
  const list = [
    txn('market1', { description: 'Market', category: 'Supermercado', amount: -5000, occurredAt: '2026-10-21T15:00:00Z' }),
    txn('market2', { description: 'Market', category: 'Supermercado', amount: -7000, occurredAt: '2026-09-21T15:00:00Z', accountId: 'card' }),
    txn('rent', { description: 'Rent', category: 'Aluguel', amount: -150000, occurredAt: '2026-10-05T15:00:00Z' }),
    txn('salary', { description: 'Salary', category: 'Salário', amount: 500000, occurredAt: '2026-10-05T15:00:00Z' }),
    txn('nocat', { description: 'Mystery', category: null, amount: -300, status: 'pending', state: 'single_source' }),
    txn('phone', { description: 'Phone', category: 'Compras', amount: -10000, accountId: 'card', installment: { number: 3, total: 10 }, occurredAt: '2026-10-10T15:00:00Z' }),
    txn('phone2', { description: 'Phone', category: 'Compras', amount: -10000, accountId: 'card', installment: { number: 4, total: 10 }, occurredAt: '2026-09-10T15:00:00Z' }),
    txn('stale', { description: 'Ghost', excluded: true, state: 'stale_pending' }),
  ];
  store.replaceCanonicalTransactions(list, list.filter((t) => !t.excluded).map((t, i) => ({ sourceId: 'pierre', externalId: `ext-${t.id}`, transactionId: t.id, matchPass: i === 0 ? 0 : 0 })), NOW.toISOString());
  store.upsertSourceTransactions('pierre', [{ externalId: 'ext-market1', accountExternalId: 'x', occurredAt: '2026-10-21T15:00:00Z', amount: -5000, description: 'Market', descriptionRaw: 'MARKET RAW', status: 'posted', installment: null, category: 'Supermercado' }], NOW.toISOString());
  return store;
}

const base: ExplorerQuery = { kind: 'all', sort: 'date_desc', limit: 50, offset: 0 };
const ids = (r: { items: Array<{ id: string }> }) => r.items.map((t) => t.id).sort();

test('explorer: filters by day, kind, category, amount, text and status', () => {
  const store = seeded();
  assert.equal(explore(store, base, NOW).total, 7);
  assert.deepEqual(ids(explore(store, { ...base, from: '2026-10-01', to: '2026-10-31', kind: 'expense' }, NOW)), ['market1', 'nocat', 'phone', 'rent']);
  assert.deepEqual(ids(explore(store, { ...base, kind: 'income' }, NOW)), ['salary']);
  assert.deepEqual(ids(explore(store, { ...base, categories: ['Supermercado'] }, NOW)), ['market1', 'market2']);
  assert.deepEqual(ids(explore(store, { ...base, categories: [''] }, NOW)), ['nocat']);
  assert.deepEqual(ids(explore(store, { ...base, min: 6000, max: 20000 }, NOW)), ['market2', 'phone', 'phone2']);
  assert.deepEqual(ids(explore(store, { ...base, q: 'mark' }, NOW)), ['market1', 'market2']);
  assert.deepEqual(ids(explore(store, { ...base, status: 'pending' }, NOW)), ['nocat']);
  assert.deepEqual(ids(explore(store, { ...base, states: ['single_source'] }, NOW)), ['nocat']);
  assert.deepEqual(ids(explore(store, { ...base, accountIds: ['card'] }, NOW)), ['market2', 'phone', 'phone2']);
  assert.equal(explore(store, { ...base, includeExcluded: true }, NOW).total, 8);
});

test('explorer: sorts, pages and sums the whole filtered set', () => {
  const store = seeded();
  const r = explore(store, { ...base, sort: 'amount_desc', limit: 2 }, NOW);
  assert.deepEqual(r.items.map((t) => t.id), ['salary', 'rent']);
  assert.equal(r.total, 7);
  assert.deepEqual(r.sums, { count: 7, income: 500000, expense: 182300, net: 317700 });
  assert.deepEqual(explore(store, { ...base, sort: 'amount_desc', limit: 2, offset: 2 }, NOW).items.map((t) => t.id), ['phone', 'phone2']);
  assert.equal(explore(store, { ...base, sort: 'date_asc' }, NOW).items[0]!.id, 'phone2');
});

test('explorer: facets ignore their own filter so the other options stay visible', () => {
  const store = seeded();
  const r = explore(store, { ...base, categories: ['Aluguel'] }, NOW);
  assert.equal(r.total, 1);
  assert.ok(r.facets.categories.some((f) => f.name === 'Supermercado' && f.count === 2));
  assert.deepEqual(r.facets.institutions.map((f) => f.name).sort(), ['Bank A']);
  const withAccount = explore(store, { ...base, accountIds: ['card'] }, NOW);
  assert.equal(withAccount.facets.accounts.length, 2);
});

test('explorer: spendingOnly leaves out own transfers and card payments', () => {
  const store = seeded();
  store.replaceCanonicalTransactions([txn('p', { category: 'Pagamento de cartão de crédito' }), txn('s', { category: 'Compras' })], [], NOW.toISOString());
  assert.deepEqual(ids(explore(store, { ...base, spendingOnly: true }, NOW)), ['s']);
});

test('explorer: hidden accounts are left out unless asked for', () => {
  const store = seeded();
  setAccountHidden(store, 'card', true, NOW);
  assert.equal(explore(store, base, NOW).total, 4);
  assert.equal(explore(store, base, NOW, { includeHidden: true }).total, 7);
  assert.equal(views.balances(store, NOW).accounts.length, 1);
});

test('recategorizing one transaction changes the totals, and clearing it goes back to the source category', () => {
  const store = seeded();
  assert.deepEqual(setTransactionCategory(store, 'rent', 'Moradia', false, NOW), { ok: true });
  const r = explore(store, { ...base, categories: ['Moradia'] }, NOW);
  assert.deepEqual([r.items[0]!.id, r.items[0]!.categoryOrigin, r.items[0]!.sourceCategory], ['rent', 'override', 'Aluguel']);
  assert.ok(listCategories(store).some((c) => c.name === 'Moradia' && c.custom && c.count === 1));
  const spending = views.spending(store, { from: '2026-10-01', to: '2026-10-31' }, 'category', NOW);
  assert.equal(spending.groups.find((g) => g.name === 'Moradia')?.amount, 150000);
  setTransactionCategory(store, 'rent', null, false, NOW);
  assert.equal(explore(store, { ...base, categories: ['Aluguel'] }, NOW).total, 1);
});

test('a rule recategorizes every transaction with the same description, and one-off choices win over it', () => {
  const store = seeded();
  setTransactionCategory(store, 'market1', 'Mercado', true, NOW);
  assert.deepEqual(ids(explore(store, { ...base, categories: ['Mercado'] }, NOW)), ['market1', 'market2']);
  setTransactionCategory(store, 'market2', 'Presente', false, NOW);
  const r = explore(store, { ...base, categories: ['Presente'] }, NOW);
  assert.equal(r.items[0]!.categoryOrigin, 'override');
  setTransactionCategory(store, 'market1', null, true, NOW);
  assert.deepEqual(ids(explore(store, { ...base, categories: ['Supermercado'] }, NOW)), ['market1']);
});

test('category changes are validated and only categories the user created can be deleted', () => {
  const store = seeded();
  assert.equal((setTransactionCategory(store, 'nope', 'X', false, NOW) as { status: number }).status, 404);
  assert.equal((setTransactionCategory(store, 'rent', '   ', false, NOW) as { status: number }).status, 400);
  assert.equal((setTransactionCategory(store, 'rent', 'x'.repeat(61), false, NOW) as { status: number }).status, 400);
  assert.deepEqual(addCategory(store, '  Viagem   2026 ', NOW), { ok: true });
  assert.ok(listCategories(store).some((c) => c.name === 'Viagem 2026' && c.count === 0));
  assert.equal(removeCategory(store, 'Compras').ok, false);
  setTransactionCategory(store, 'rent', 'Viagem 2026', true, NOW);
  assert.deepEqual(removeCategory(store, 'Viagem 2026'), { ok: true });
  assert.equal(explore(store, { ...base, categories: ['Aluguel'] }, NOW).total, 1);
  assert.equal(setAccountHidden(store, 'ghost', true, NOW).ok, false);
  assert.equal(setAccountHidden(store, 'chk', 'yes', NOW).ok, false);
});

test('detail: sources, installments, merchant history and the category rule', () => {
  const store = seeded();
  setTransactionCategory(store, 'market1', 'Mercado', true, NOW);
  const d = transactionDetail(store, 'market1', NOW)!;
  assert.equal(d.transaction.category, 'Mercado');
  assert.equal(d.account.institution, 'Bank A');
  assert.deepEqual(d.sources.map((s) => [s.sourceId, s.record?.descriptionRaw]), [['pierre', 'MARKET RAW']]);
  assert.deepEqual([d.merchant.count, d.merchant.total, d.merchant.firstDay, d.merchant.lastDay], [2, 12000, '2026-09-21', '2026-10-21']);
  assert.deepEqual(d.rule, { category: 'Mercado' });
  const phone = transactionDetail(store, 'phone', NOW)!;
  assert.deepEqual(phone.installments.map((i) => i.number), [3, 4]);
  assert.equal(transactionDetail(store, 'nope', NOW), null);
});

test('routes: explorer filters, detail, writes and validation', () => {
  const store = seeded();
  const call = (method: string, path: string, query = '', body = '') => apiRoute(method, path, new URLSearchParams(query), store, NOW, body);
  const found = call('GET', '/api/transactions', 'category=Supermercado&kind=expense&sort=amount_asc&limit=1');
  assert.equal(found?.status, 200);
  assert.equal((found?.body as { items: unknown[] }).items.length, 1);
  assert.equal(call('GET', '/api/transactions', 'category=Restaurantes, bares&limit=5')?.status, 200);
  assert.equal(call('GET', '/api/transactions', 'kind=weird')?.status, 400);
  assert.equal(call('GET', '/api/transactions', 'sort=weird')?.status, 400);
  assert.equal(call('GET', '/api/transactions', 'limit=0')?.status, 400);
  assert.equal(call('GET', '/api/transactions', 'cycle=2026-13x')?.status, 400);
  assert.equal(call('GET', '/api/transactions', 'from=2026-10-10&to=2026-10-01')?.status, 400);
  assert.equal(call('GET', '/api/transactions/rent')?.status, 200);
  assert.equal(call('GET', '/api/transactions/ghost')?.status, 404);
  assert.equal(call('PUT', '/api/transactions/rent/category', '', '{"category":"Moradia"}')?.status, 200);
  assert.equal(call('PUT', '/api/transactions/rent/category', '', '{}')?.status, 400);
  assert.equal(call('PUT', '/api/accounts/card', '', '{"hidden":true}')?.status, 200);
  assert.equal((call('GET', '/api/accounts')?.body as { items: Array<{ hidden: boolean }> }).items.filter((a) => a.hidden).length, 1);
  assert.equal(call('POST', '/api/categories', '', '{"name":"Viagem"}')?.status, 200);
  assert.equal(call('DELETE', `/api/categories/${encodeURIComponent('Viagem')}`)?.status, 200);
  assert.equal(call('DELETE', '/api/categories/Compras')?.status, 404);
  assert.equal(call('GET', '/api/cards', 'cycle=bad')?.status, 400);
  assert.equal(call('GET', '/api/cycles', 'accountId=chk')?.status, 404);
  assert.equal(call('GET', '/api/nothing'), null);
  assert.equal(call('POST', '/api/balances')?.status, 405);
});
