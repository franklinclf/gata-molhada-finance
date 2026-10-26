import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadSourceViews, runAccountReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { account, history } from '../support/builders.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T16:00:00.000Z');

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  for (const id of ['pierre', 'pluggy']) store.registerSource({ id, kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  store.upsertSourceAccounts('pierre', [account({ externalId: 'p1', balance: 500000 })], NOW.toISOString());
  store.upsertSourceTransactions('pierre', history('p1', 'pt'), NOW.toISOString());
  store.upsertSourceAccounts('pluggy', [account({ externalId: 'g1', balance: 514051 })], NOW.toISOString());
  store.upsertSourceTransactions('pluggy', history('g1', 'gt'), NOW.toISOString());
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T15:38:00.000Z', observedAt: NOW.toISOString() });
  store.upsertFreshness({ sourceId: 'pluggy', institution: 'Bank A', lastUpdatedAt: '2026-10-25T20:00:00.000Z', observedAt: NOW.toISOString() });
  return store;
}

test('rebuilds and saves the canonical accounts from the stored source records', () => {
  const store = seeded();
  const result = runAccountReconciliation(store, { now: () => NOW });
  assert.equal(result.accounts.length, 1);
  const [saved] = store.listCanonicalAccounts();
  assert.equal(saved?.balance, 500000);
  assert.equal(saved?.balanceSourceId, 'pierre');
  assert.equal(saved?.refs.length, 2);
});

test('running it again keeps the same ids and does not duplicate rows', () => {
  const store = seeded();
  runAccountReconciliation(store, { now: () => NOW });
  const first = store.listCanonicalAccounts().map((a) => a.id);
  runAccountReconciliation(store, { now: () => new Date('2026-10-26T17:00:00.000Z') });
  assert.deepEqual(store.listCanonicalAccounts().map((a) => a.id), first);
  assert.equal(store.listCanonicalAccounts().length, 1);
});

test('a source that was never synced is ignored', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  store.upsertSourceAccounts('pierre', [account({ externalId: 'p1' })], NOW.toISOString());
  const views = loadSourceViews(store, ['pierre', 'pluggy']);
  assert.deepEqual(views.map((v) => v.sourceId), ['pierre']);
  const result = runAccountReconciliation(store, { now: () => NOW });
  assert.deepEqual(result.notes, []);
});

test('with no synced data it saves nothing', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const result = runAccountReconciliation(store, { now: () => NOW });
  assert.deepEqual(result.accounts, []);
  assert.deepEqual(store.listCanonicalAccounts(), []);
});
