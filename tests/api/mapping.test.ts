import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { transactionDetail } from '../../src/api/detail.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { runReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { account, tx } from '../support/builders.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T16:00:00.000Z');

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const at = NOW.toISOString();
  for (const id of ['pierre', 'pluggy']) store.registerSource({ id, kind: 'aggregator', capabilities: {} }, at);
  store.upsertSourceAccounts('pierre', [account({ externalId: 'p1' })], at);
  store.upsertSourceAccounts('pluggy', [account({ externalId: 'g1' })], at);
  store.upsertSourceTransactions('pierre', [tx({ externalId: 'a', accountExternalId: 'p1', occurredAt: '2026-10-22T12:00:00.000Z', amount: -777, descriptionRaw: 'ONLY HERE' }), tx({ externalId: 'c', accountExternalId: 'p1', occurredAt: '2026-10-20T12:00:00.000Z', amount: -50, descriptionRaw: 'COFFEE' })], at);
  store.upsertSourceTransactions('pluggy', [tx({ externalId: 'b', accountExternalId: 'g1', occurredAt: '2026-10-25T12:00:00.000Z', amount: -777, descriptionRaw: 'WORDED DIFFERENTLY' })], at);
  runReconciliation(store, { now: () => NOW });
  return store;
}

const call = (store: ReturnType<typeof seeded>, method: string, path: string, body = '') => apiRoute(method, path, new URLSearchParams(), store, new Date(NOW.getTime() + 3_600_000), body);
const find = (store: ReturnType<typeof seeded>, desc: string) => store.listCanonicalTransactions({ includeExcluded: true }).find((t) => t.description === desc || t.descriptionRaw === desc)!;

test('candidates list the other source records nearby, same amount first', () => {
  const store = seeded();
  const mine = find(store, 'ONLY HERE');
  const res = call(store, 'GET', `/api/transactions/${mine.id}/candidates`);
  const items = (res?.body as { items: Array<{ amount: number; sourceIds: string[]; daysApart: number }> }).items;
  assert.equal(items.length, 1);
  assert.deepEqual([items[0]!.amount, items[0]!.sourceIds, items[0]!.daysApart], [-777, ['pluggy'], 3]);
  assert.equal(call(store, 'GET', '/api/transactions/ghost/candidates')?.status, 404);
});

test('joining by hand merges the two, the detail says so, and separating splits them again', () => {
  const store = seeded();
  const a = find(store, 'ONLY HERE');
  const b = find(store, 'WORDED DIFFERENTLY');
  assert.equal(call(store, 'POST', `/api/transactions/${a.id}/merge`, JSON.stringify({ otherId: b.id }))?.status, 200);
  const joined = store.listCanonicalTransactions().find((t) => t.sourceIds.length === 2 && t.amount === -777)!;
  assert.ok(joined);
  assert.equal(transactionDetail(store, joined.id, NOW)?.joinedByHand, true);
  assert.deepEqual(store.listFindings(), []);
  assert.equal(call(store, 'DELETE', `/api/transactions/${joined.id}/merge`)?.status, 200);
  assert.equal(store.listCanonicalTransactions().filter((t) => t.amount === -777).length, 2);
});

test('joining is validated: same transaction, unknown id, same source', () => {
  const store = seeded();
  const a = find(store, 'ONLY HERE');
  const c = find(store, 'COFFEE');
  assert.equal(call(store, 'POST', `/api/transactions/${a.id}/merge`, JSON.stringify({ otherId: a.id }))?.status, 400);
  assert.equal(call(store, 'POST', `/api/transactions/${a.id}/merge`, JSON.stringify({ otherId: 'ghost' }))?.status, 404);
  assert.equal(call(store, 'POST', `/api/transactions/${a.id}/merge`, JSON.stringify({ otherId: c.id }))?.status, 400);
  assert.equal(call(store, 'POST', `/api/transactions/${a.id}/merge`, 'nope')?.status, 400);
});

test('ignoring takes a transaction out of the totals and bringing it back restores it', () => {
  const store = seeded();
  const c = find(store, 'COFFEE');
  assert.equal(call(store, 'PUT', `/api/transactions/${c.id}/ignore`, '{"ignored":true}')?.status, 200);
  assert.equal(store.listCanonicalTransactions().some((t) => t.descriptionRaw === 'COFFEE'), false);
  assert.equal(find(store, 'COFFEE').state, 'ignored');
  assert.equal(call(store, 'PUT', `/api/transactions/${c.id}/ignore`, '{"ignored":false}')?.status, 200);
  assert.equal(find(store, 'COFFEE').state, 'single_source');
  assert.equal(call(store, 'PUT', `/api/transactions/${c.id}/ignore`, '{"ignored":"yes"}')?.status, 400);
});

test('dismissing a suggestion removes it for good', () => {
  const store = seeded();
  const f = store.listFindings()[0]!;
  assert.equal(call(store, 'POST', `/api/findings/${f.id}/dismiss`)?.status, 200);
  assert.deepEqual(store.listFindings(), []);
  assert.equal(call(store, 'POST', `/api/findings/${f.id}/dismiss`)?.status, 404);
  assert.equal(call(store, 'GET', `/api/findings/${f.id}/dismiss`)?.status, 405);
});

test('a manual category survives a join', () => {
  const store = seeded();
  const a = find(store, 'ONLY HERE');
  const b = find(store, 'WORDED DIFFERENTLY');
  call(store, 'PUT', `/api/transactions/${a.id}/category`, '{"category":"Minha"}');
  call(store, 'POST', `/api/transactions/${a.id}/merge`, JSON.stringify({ otherId: b.id }));
  const joined = store.listCanonicalTransactions().find((t) => t.sourceIds.length === 2 && t.amount === -777)!;
  assert.equal(store.listCategoryOverrides().get(joined.id), 'Minha');
});
