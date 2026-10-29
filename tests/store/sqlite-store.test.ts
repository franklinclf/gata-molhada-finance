import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = '2026-10-26T15:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: { refreshOnDemand: true } }, NOW);
  return store;
}

test('applies the real migrations on open', () => {
  const store = newStore();
  assert.equal(store.schemaVersion(), 17);
});

test('saveSnapshot stores the body and latestSnapshot returns the newest one', () => {
  const store = newStore();
  store.saveSnapshot({ sourceId: 'pierre', endpoint: 'get-accounts', fetchedAt: '2026-10-26T10:00:00.000Z', httpStatus: 200, body: { n: 1 } });
  const id = store.saveSnapshot({ sourceId: 'pierre', endpoint: 'get-accounts', fetchedAt: '2026-10-26T11:00:00.000Z', httpStatus: 200, body: { n: 2 } });
  const latest = store.latestSnapshot('pierre', 'get-accounts');
  assert.equal(latest?.id, id);
  assert.deepEqual(latest?.body, { n: 2 });
  assert.match(latest?.sha256 ?? '', /^[0-9a-f]{64}$/);
});

test('latestSnapshot returns null when nothing was saved', () => {
  assert.equal(newStore().latestSnapshot('pierre', 'get-accounts'), null);
});

test('identical bodies produce the same hash', () => {
  const store = newStore();
  const a = store.saveSnapshot({ sourceId: 'pierre', endpoint: 'e', fetchedAt: NOW, httpStatus: 200, body: { x: 1 } });
  const b = store.saveSnapshot({ sourceId: 'pierre', endpoint: 'e', fetchedAt: '2026-10-26T15:01:00.000Z', httpStatus: 200, body: { x: 1 } });
  assert.notEqual(a, b);
  assert.equal(store.latestSnapshot('pierre', 'e')?.sha256.length, 64);
});

test('saveSnapshot rejects an unregistered source', () => {
  const store = newStore();
  assert.throws(
    () => store.saveSnapshot({ sourceId: 'ghost', endpoint: 'e', fetchedAt: NOW, httpStatus: 200, body: {} }),
    /FOREIGN KEY/,
  );
});

test('registerSource is idempotent and updates capabilities', () => {
  const store = newStore();
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: { refreshOnDemand: false } }, '2026-10-27T00:00:00.000Z');
  store.saveSnapshot({ sourceId: 'pierre', endpoint: 'e', fetchedAt: NOW, httpStatus: 200, body: {} });
});

test('upsertFreshness keeps one row per source and institution', () => {
  const store = newStore();
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T04:00:00.000Z', observedAt: NOW });
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T15:38:00.000Z', observedAt: '2026-10-26T15:40:00.000Z' });
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank B', lastUpdatedAt: '2026-10-26T06:00:00.000Z', observedAt: NOW });
  const rows = store.listFreshness();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.institution, 'Bank A');
  assert.equal(rows[0]?.lastUpdatedAt, '2026-10-26T15:38:00.000Z');
});

test('a source that leaves out a card limit or due date for one read does not erase the one it gave before', () => {
  const store = openSqliteStore(':memory:', fileURLToPath(new URL('../../migrations', import.meta.url)));
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, '2026-10-01T00:00:00Z');
  const card = { externalId: 'c1', externalItemId: null, institution: 'Bank', kind: 'credit_card' as const, name: 'Card', last4: '1234', balance: 1000, creditLimit: 500000, availableLimit: 400000, minimumPayment: 5000, dueDate: '2026-11-10' };
  store.upsertSourceAccounts('pluggy', [card], '2026-10-01T00:00:00Z');
  store.upsertSourceAccounts('pluggy', [{ ...card, balance: 2000, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, last4: null }], '2026-10-02T00:00:00Z');
  const saved = store.listSourceAccounts('pluggy')[0]!;
  assert.deepEqual([saved.balance, saved.creditLimit, saved.availableLimit, saved.minimumPayment, saved.dueDate, saved.last4], [2000, 500000, 400000, 5000, '2026-11-10', '1234']);
});

test('a retired source keeps its records but stops reporting freshness, and comes back when registered again', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  for (const id of ['old', 'live']) {
    store.registerSource({ id, kind: 'test', capabilities: {} }, '2026-10-01T00:00:00Z');
    store.upsertFreshness({ sourceId: id, institution: 'Bank', lastUpdatedAt: '2026-10-01T00:00:00Z', observedAt: '2026-10-01T00:00:00Z' });
  }
  store.upsertSourceTransactions('old', [{ externalId: 't1', accountExternalId: 'a', occurredAt: '2026-10-01T00:00:00Z', amount: -100, description: 'X', descriptionRaw: null, status: 'posted', installment: null, category: null }], '2026-10-01T00:00:00Z');
  assert.deepEqual(store.retireSourcesExcept(['live']), ['old']);
  assert.deepEqual(store.listFreshness().map((f) => f.sourceId), ['live']);
  assert.equal(store.listSourceTransactions('old').length, 1);
  assert.deepEqual(store.retireSourcesExcept(['live']), [], 'retiring twice does nothing');
  store.registerSource({ id: 'old', kind: 'test', capabilities: {} }, '2026-10-02T00:00:00Z');
  assert.equal(store.listFreshness().length, 2);
});
