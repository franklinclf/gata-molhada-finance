import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { Freshness } from '../../src/core/types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = '2026-10-26T16:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, NOW);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, NOW);
  return store;
}

const fresh = (sourceId: string, institution: string, lastUpdatedAt: string, extra: Partial<Freshness> = {}): Freshness => ({
  sourceId,
  institution,
  lastUpdatedAt,
  observedAt: NOW,
  ...extra,
});

test('upsertFreshness reports whether the last-synced time changed', () => {
  const store = newStore();
  assert.deepEqual(store.upsertFreshness(fresh('pierre', 'Bank A', '2026-10-26T10:00:00.000Z')), { changed: true, previous: null });
  assert.deepEqual(store.upsertFreshness(fresh('pierre', 'Bank A', '2026-10-26T10:00:00.000Z')), { changed: false, previous: '2026-10-26T10:00:00.000Z' });
  assert.deepEqual(store.upsertFreshness(fresh('pierre', 'Bank A', '2026-10-26T14:00:00.000Z')), { changed: true, previous: '2026-10-26T10:00:00.000Z' });
});

test('each distinct last-synced time counts once as a bank read', () => {
  const store = newStore();
  for (const t of ['2026-10-26T10:00:00.000Z', '2026-10-26T10:00:00.000Z', '2026-10-26T14:00:00.000Z']) {
    store.upsertFreshness(fresh('pierre', 'Bank A', t));
  }
  assert.deepEqual(store.quotaUsage('2026-10'), [{ institutionKey: 'bank a', events: 2 }]);
});

test('reads by both sources count toward the same institution', () => {
  const store = newStore();
  store.upsertFreshness(fresh('pierre', 'Crédito Útil', '2026-10-26T10:00:00.000Z'));
  store.upsertFreshness(fresh('pluggy', 'CREDITO UTIL', '2026-10-26T09:00:00.000Z'));
  store.upsertFreshness(fresh('pluggy', 'Bank B', '2026-10-26T09:00:00.000Z'));
  assert.deepEqual(store.quotaUsage('2026-10'), [
    { institutionKey: 'bank b', events: 1 },
    { institutionKey: 'credito util', events: 2 },
  ]);
});

test('a read is attributed to the Brazilian month it happened in', () => {
  const store = newStore();
  store.upsertFreshness(fresh('pierre', 'Bank A', '2026-11-01T01:30:00.000Z'));
  assert.deepEqual(store.quotaUsage('2026-10'), [{ institutionKey: 'bank a', events: 1 }]);
  assert.deepEqual(store.quotaUsage('2026-11'), []);
});

test('the exhausted flag is stored and listed only when set', () => {
  const store = newStore();
  store.upsertFreshness(fresh('pluggy', 'Bank A', '2026-10-26T10:00:00.000Z', { quotaExhausted: true }));
  store.upsertFreshness(fresh('pluggy', 'Bank B', '2026-10-26T10:00:00.000Z'));
  const rows = store.listFreshness();
  assert.equal(rows.find((r) => r.institution === 'Bank A')?.quotaExhausted, true);
  assert.equal('quotaExhausted' in (rows.find((r) => r.institution === 'Bank B') ?? {}), false);
  store.upsertFreshness(fresh('pluggy', 'Bank A', '2026-10-27T10:00:00.000Z'));
  assert.equal('quotaExhausted' in (store.listFreshness().find((r) => r.institution === 'Bank A') ?? {}), false);
});

test('a refresh is logged from request to finish', () => {
  const store = newStore();
  assert.equal(store.lastRefresh('pierre'), null);
  const id = store.startRefresh('pierre', '2026-10-26T15:00:00.000Z');
  assert.deepEqual(store.lastRefresh('pierre'), { id, sourceId: 'pierre', requestedAt: '2026-10-26T15:00:00.000Z', finishedAt: null, status: 'requested', detail: {} });
  store.finishRefresh(id, '2026-10-26T15:01:00.000Z', 'completed', { updated: 5 });
  const last = store.lastRefresh('pierre');
  assert.equal(last?.status, 'completed');
  assert.equal(last?.finishedAt, '2026-10-26T15:01:00.000Z');
  assert.deepEqual(last?.detail, { updated: 5 });
});

test('lastRefresh returns the newest entry of that source only', () => {
  const store = newStore();
  store.startRefresh('pierre', '2026-10-26T10:00:00.000Z');
  const second = store.startRefresh('pierre', '2026-10-26T12:00:00.000Z');
  store.startRefresh('pluggy', '2026-10-26T13:00:00.000Z');
  assert.equal(store.lastRefresh('pierre')?.id, second);
});
