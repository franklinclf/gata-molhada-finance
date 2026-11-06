import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { assertCopyWritten, pruneCopies } from '../../src/backup/retention.ts';
import { syncSource } from '../../src/sync/sync.ts';
import { createSnapshotSink } from '../../src/sync/sync.ts';
import { FakeAdapter } from '../support/fake-adapter.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const GAP = 15 * 60_000;

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, '2026-01-01T00:00:00Z');
  return store;
}

/** One read: a few responses a few seconds apart. */
function read(store: ReturnType<typeof newStore>, at: string, status = 200, endpoints = ['/items/i', '/v2/transactions?accountId=a&dateTo=x']) {
  endpoints.forEach((endpoint, i) => store.saveSnapshot({ sourceId: 'pluggy', endpoint, fetchedAt: new Date(Date.parse(at) + i * 5_000).toISOString(), httpStatus: status, body: { at } }));
}
const stamps = (store: ReturnType<typeof newStore>) => [...new Set(store.listSnapshots('pluggy', '/items').map((s) => (s.body as { at: string }).at))];

test('the last three complete reads and the last read of each month stay, the rest goes', () => {
  const store = newStore();
  const days = ['2026-08-03', '2026-08-20', '2026-09-02', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  for (const d of days) read(store, `${d}T12:00:00.000Z`);
  const removed = store.pruneSnapshots('pluggy', 3, GAP);
  // Recent: oct 2, 3, 4. Monthly: aug 20, sep 25, oct 4.
  assert.deepEqual(stamps(store), ['2026-08-20T12:00:00.000Z', '2026-09-25T12:00:00.000Z', '2026-10-02T12:00:00.000Z', '2026-10-03T12:00:00.000Z', '2026-10-04T12:00:00.000Z']);
  assert.equal(removed, 3 * 2);
  // Both responses of a kept read stay together.
  assert.equal(store.listSnapshots('pluggy', '/v2/transactions').length, 5);
});

test('running it again changes nothing', () => {
  const store = newStore();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) read(store, `${d}T12:00:00.000Z`);
  store.pruneSnapshots('pluggy', 3, GAP);
  assert.equal(store.pruneSnapshots('pluggy', 3, GAP), 0);
});

test('failed reads do not push out the last good ones, and are only kept while they are newer than them', () => {
  const store = newStore();
  read(store, '2026-10-01T12:00:00.000Z');
  read(store, '2026-10-02T12:00:00.000Z');
  read(store, '2026-10-03T12:00:00.000Z');
  read(store, '2026-10-04T12:00:00.000Z', 500);
  read(store, '2026-10-05T12:00:00.000Z', 500);
  read(store, '2026-10-06T12:00:00.000Z', 500);
  store.pruneSnapshots('pluggy', 2, GAP);
  // Good ones: 1, 2, 3 -> keep 2 and 3 (and nothing older, same month as 3). The failures after them stay.
  assert.deepEqual(stamps(store), ['2026-10-02T12:00:00.000Z', '2026-10-03T12:00:00.000Z', '2026-10-04T12:00:00.000Z', '2026-10-05T12:00:00.000Z', '2026-10-06T12:00:00.000Z']);
});

test('nothing is deleted when no read was complete', () => {
  const store = newStore();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) read(store, `${d}T12:00:00.000Z`, 500);
  assert.equal(store.pruneSnapshots('pluggy', 1, GAP), 0);
  assert.equal(stamps(store).length, 4);
});

test('a read where one response failed does not count as complete', () => {
  const store = newStore();
  read(store, '2026-10-01T12:00:00.000Z');
  read(store, '2026-10-02T12:00:00.000Z');
  store.saveSnapshot({ sourceId: 'pluggy', endpoint: '/items/i', fetchedAt: '2026-10-03T12:00:00.000Z', httpStatus: 200, body: { at: '2026-10-03T12:00:00.000Z' } });
  store.saveSnapshot({ sourceId: 'pluggy', endpoint: '/v2/transactions?accountId=a', fetchedAt: '2026-10-03T12:00:05.000Z', httpStatus: 502, body: { at: '2026-10-03T12:00:00.000Z' } });
  store.pruneSnapshots('pluggy', 1, GAP);
  // The only complete reads are oct 1 and oct 2: oct 2 stays, oct 1 goes, the partly failed oct 3 is newer and stays.
  assert.deepEqual(stamps(store), ['2026-10-02T12:00:00.000Z', '2026-10-03T12:00:00.000Z']);
});

test('another source is not touched, and the saved records are not either', () => {
  const store = newStore();
  store.registerSource({ id: 'other', kind: 'aggregator', capabilities: {} }, '2026-01-01T00:00:00Z');
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    read(store, `${d}T12:00:00.000Z`);
    store.saveSnapshot({ sourceId: 'other', endpoint: '/items/i', fetchedAt: `${d}T12:00:00.000Z`, httpStatus: 200, body: { at: d } });
  }
  store.upsertSourceAccounts('pluggy', [{ externalId: 'a', externalItemId: null, institution: 'B', kind: 'checking', name: 'C', last4: null, balance: 0, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null }], '2026-10-03T12:00:00Z');
  store.pruneSnapshots('pluggy', 1, GAP);
  assert.equal(stamps(store).length, 1);
  assert.equal(store.listSnapshots('other', '/items').length, 3);
  assert.equal(store.listSourceAccounts('pluggy').length, 1);
});

test('a sync trims old responses at its end', async () => {
  const store = newStore();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) read(store, `${d}T12:00:00.000Z`);
  const at = new Date('2026-10-06T12:00:00.000Z');
  const adapter = new FakeAdapter('pluggy', {});
  const sink = createSnapshotSink(store, 'pluggy', () => at);
  sink({ endpoint: '/items/i', httpStatus: 200, body: { at: at.toISOString() } });
  const result = await syncSource(adapter, { store, now: () => at }, new Date('2026-09-01T00:00:00Z'));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(stamps(store), ['2026-10-04T12:00:00.000Z', '2026-10-05T12:00:00.000Z', '2026-10-06T12:00:00.000Z']);
});

test('space is reclaimed only when a lot of the file is free, and at most once a day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmf-vacuum-'));
  try {
    const path = join(dir, 'db.sqlite');
    const store = openSqliteStore(path, MIGRATIONS);
    store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, '2026-01-01T00:00:00Z');
    assert.equal(store.reclaimSpace('2026-10-01T00:00:00Z'), false, 'nothing is free yet');
    const big = 'x'.repeat(200_000);
    for (let i = 0; i < 30; i++) store.saveSnapshot({ sourceId: 'pluggy', endpoint: `/e${i}`, fetchedAt: `2026-10-0${1 + (i % 5)}T00:00:00.000Z`, httpStatus: 200, body: { big } });
    assert.equal(store.reclaimSpace('2026-10-01T00:00:00Z'), false, 'a full file has nothing to give back');
    const before = statSync(path).size;
    store.pruneSnapshots('pluggy', 1, GAP);
    assert.equal(store.reclaimSpace('2026-10-02T00:00:00Z'), true);
    assert.ok(statSync(path).size < before / 2, 'the file shrank');
    // Free pages again right after, but the last run was an hour ago.
    for (let i = 0; i < 30; i++) store.saveSnapshot({ sourceId: 'pluggy', endpoint: `/f${i}`, fetchedAt: `2026-10-1${i % 5}T00:00:00.000Z`, httpStatus: 200, body: { big } });
    store.pruneSnapshots('pluggy', 1, GAP);
    assert.equal(store.reclaimSpace('2026-10-02T01:00:00Z'), false);
    assert.equal(store.reclaimSpace('2026-10-03T01:00:00Z'), true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the newest before-reset copies stay, and other files are left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmf-copies-'));
  try {
    mkdirSync(join(dir, 'sub'));
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) writeFileSync(join(dir, `before-reset-${d}T10-00-00-000Z.sqlite`), 'x');
    writeFileSync(join(dir, 'pre-deploy-2026-09-01.sqlite'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const removed = pruneCopies(dir, 'before-reset-', 3);
    assert.deepEqual(removed, ['before-reset-2026-10-01T10-00-00-000Z.sqlite', 'before-reset-2026-10-02T10-00-00-000Z.sqlite']);
    assert.deepEqual(pruneCopies(dir, 'before-reset-', 3), []);
    assert.deepEqual(pruneCopies(join(dir, 'missing'), 'before-reset-', 3), []);
    // Never zero: keeping none would remove the copy that was just made.
    assert.equal(pruneCopies(dir, 'before-reset-', 0).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty copy is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmf-copy-'));
  try {
    writeFileSync(join(dir, 'empty.sqlite'), '');
    writeFileSync(join(dir, 'full.sqlite'), 'x');
    assert.throws(() => assertCopyWritten(join(dir, 'empty.sqlite')), /vazia/);
    assert.throws(() => assertCopyWritten(join(dir, 'missing.sqlite')));
    assertCopyWritten(join(dir, 'full.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
