import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildAdapters } from '../../src/sync/adapters.ts';
import { syncSource } from '../../src/sync/sync.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { FakeHttp, ok } from '../support/fake-http.ts';
import {
  pierreBankAccount,
  pierreBankCredit,
  pierreBill,
  pierreCardAccount,
  pierreCardPurchase,
} from '../fixtures/pierre.ts';
import {
  pluggyBankAccount,
  pluggyBankCredit,
  pluggyBill,
  pluggyCardAccount,
  pluggyCardPurchase,
  pluggyItem,
} from '../fixtures/pluggy.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T15:00:00.000Z');
const SINCE = new Date('2026-08-01T00:00:00.000Z');

function network() {
  return new FakeHttp([
    { method: 'GET', match: '/get-accounts', respond: () => ok({ data: [pierreBankAccount, pierreCardAccount] }) },
    { method: 'GET', match: /\/get-transactions\?/, respond: () => ok({ data: [pierreBankCredit, pierreCardPurchase] }) },
    { method: 'GET', match: '/get-bills', respond: () => ok({ data: [pierreBill] }) },
    { method: 'POST', match: '/auth', respond: () => ok({ apiKey: 'key-1' }) },
    { method: 'GET', match: '/items/item-1', respond: () => ok(pluggyItem) },
    { method: 'GET', match: /\/accounts\?itemId=item-1$/, respond: () => ok({ results: [pluggyBankAccount, pluggyCardAccount] }) },
    { method: 'GET', match: /\/v2\/transactions\?accountId=acc-bank-1/, respond: () => ok({ results: [pluggyBankCredit], next: null }) },
    { method: 'GET', match: /\/v2\/transactions\?accountId=acc-card-1/, respond: () => ok({ results: [pluggyCardPurchase], next: null }) },
    { method: 'GET', match: /\/bills\?accountId=acc-card-1&page=1$/, respond: () => ok({ page: 1, totalPages: 1, results: [pluggyBill] }) },
  ]);
}

test('syncs both sources end to end into the store', async () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const adapters = buildAdapters(
    {
      pierre: { apiKey: 'sk-test' },
      pluggy: { clientId: 'cid', clientSecret: 'sec', items: [{ label: 'Bank A', itemId: 'item-1' }] },
    },
    { store, http: network(), now: () => NOW },
  );
  assert.deepEqual(adapters.map((a) => a.id), ['pierre', 'pluggy']);

  const results = [];
  for (const adapter of adapters) results.push(await syncSource(adapter, { store, now: () => NOW }, SINCE));

  assert.deepEqual(results.map((r) => [r.sourceId, r.accounts, r.transactions, r.bills, r.errors.length]), [
    ['pierre', 2, 2, 1, 0],
    ['pluggy', 2, 2, 1, 0],
  ]);
  assert.equal(store.listSourceTransactions('pierre').length, 2);
  assert.equal(store.listSourceTransactions('pluggy').length, 2);
  assert.deepEqual(store.listFreshness().map((f) => [f.sourceId, f.institution]), [
    ['pierre', 'Bank A'],
    ['pluggy', 'Bank A'],
  ]);
  assert.ok(store.latestSnapshot('pluggy', '/items/item-1'));
  assert.ok(store.latestSnapshot('pierre', 'get-bills'));
});

test('the same purchase from both sources has the same cash-flow amount', async () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const adapters = buildAdapters(
    { pierre: { apiKey: 'sk-test' }, pluggy: { clientId: 'cid', clientSecret: 'sec', items: [{ label: 'Bank A', itemId: 'item-1' }] } },
    { store, http: network(), now: () => NOW },
  );
  for (const adapter of adapters) await syncSource(adapter, { store, now: () => NOW }, SINCE);
  const pierre = store.listSourceTransactions('pierre').find((t) => t.externalId === 'p-tx-2');
  const pluggy = store.listSourceTransactions('pluggy').find((t) => t.externalId === 'tx-2');
  assert.equal(pierre?.amount, -9990);
  assert.equal(pluggy?.amount, -9990);
  assert.equal(pierre?.occurredAt, pluggy?.occurredAt);
});

test('only configured sources are built', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  assert.deepEqual(buildAdapters({}, { store, http: network() }), []);
  assert.deepEqual(buildAdapters({ pierre: { apiKey: 'k' } }, { store, http: network() }).map((a) => a.id), ['pierre']);
});
