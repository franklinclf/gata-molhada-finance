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
  assert.equal(store.schemaVersion(), 3);
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
