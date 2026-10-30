import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { CanonicalTransaction, Finding, TransactionLink } from '../../src/core/canonical.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T1 = '2026-10-26T10:00:00.000Z';
const T2 = '2026-10-26T12:00:00.000Z';
const T3 = '2026-10-26T14:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, T1);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, T1);
  return store;
}

const transaction = (overrides: Partial<CanonicalTransaction> = {}): CanonicalTransaction => ({
  id: 'tx_1',
  accountId: 'acc_1',
  occurredAt: '2026-10-20T12:00:00.000Z',
  amount: -1990,
  description: 'Coffee',
  descriptionRaw: 'COFFEE SHOP',
  status: 'posted',
  installment: { number: 2, total: 5 },
  category: 'Food',
  state: 'confirmed',
  sourceIds: ['pierre', 'pluggy'],
  excluded: false,
  ...overrides,
});

const links: TransactionLink[] = [
  { sourceId: 'pierre', externalId: 'a', transactionId: 'tx_1', matchPass: 0 },
  { sourceId: 'pluggy', externalId: 'b', transactionId: 'tx_1', matchPass: 1 },
];

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'fd_1',
  kind: 'possible_match',
  severity: 'warning',
  accountId: 'acc_1',
  transactionId: 'tx_1',
  summary: 'Something is missing',
  details: { missingIn: 'pluggy' },
  ...overrides,
});

test('stores canonical transactions with their sources and installment data', () => {
  const store = newStore();
  store.replaceCanonicalTransactions([transaction()], links, T1);
  assert.deepEqual(store.listCanonicalTransactions(), [transaction()]);
});

test('replacing removes the previous transactions and links', () => {
  const store = newStore();
  store.replaceCanonicalTransactions([transaction()], links, T1);
  store.replaceCanonicalTransactions([transaction({ id: 'tx_2', installment: null, sourceIds: ['pierre'] })], [{ sourceId: 'pierre', externalId: 'a', transactionId: 'tx_2', matchPass: 0 }], T2);
  assert.deepEqual(store.listCanonicalTransactions().map((t) => t.id), ['tx_2']);
});

test('excluded transactions are hidden unless requested, and the list can be filtered by account', () => {
  const store = newStore();
  const stale = transaction({ id: 'tx_s', state: 'stale_pending', excluded: true, sourceIds: ['pluggy'] });
  const other = transaction({ id: 'tx_o', accountId: 'acc_2', sourceIds: ['pierre'] });
  store.replaceCanonicalTransactions([transaction(), stale, other], [
    ...links,
    { sourceId: 'pluggy', externalId: 's', transactionId: 'tx_s', matchPass: 0 },
    { sourceId: 'pierre', externalId: 'o', transactionId: 'tx_o', matchPass: 0 },
  ], T1);
  assert.deepEqual(store.listCanonicalTransactions().map((t) => t.id).sort(), ['tx_1', 'tx_o']);
  assert.equal(store.listCanonicalTransactions({ includeExcluded: true }).length, 3);
  assert.deepEqual(store.listCanonicalTransactions({ accountId: 'acc_2' }).map((t) => t.id), ['tx_o']);
});

test('a link can point at only one canonical transaction', () => {
  const store = newStore();
  assert.throws(
    () => store.replaceCanonicalTransactions([transaction(), transaction({ id: 'tx_2' })], [links[0] as TransactionLink, { ...(links[0] as TransactionLink), transactionId: 'tx_2' }], T1),
    /UNIQUE|constraint/i,
  );
  assert.deepEqual(store.listCanonicalTransactions(), []);
});

test('findings keep their opening time while the problem persists', () => {
  const store = newStore();
  store.syncFindings([finding()], T1);
  store.syncFindings([finding({ summary: 'Still missing' })], T2);
  const [stored] = store.listFindings();
  assert.equal(stored?.openedAt, T1);
  assert.equal(stored?.lastSeenAt, T2);
  assert.equal(stored?.summary, 'Still missing');
  assert.deepEqual(stored?.details, { missingIn: 'pluggy' });
  assert.equal(stored?.resolvedAt, null);
});

test('a finding that disappears is marked resolved and hidden from the open list', () => {
  const store = newStore();
  store.syncFindings([finding(), finding({ id: 'fd_2', kind: 'possible_match' })], T1);
  store.syncFindings([finding({ id: 'fd_2', kind: 'possible_match' })], T2);
  assert.deepEqual(store.listFindings().map((f) => f.id), ['fd_2']);
  const all = store.listFindings({ includeResolved: true });
  assert.equal(all.find((f) => f.id === 'fd_1')?.resolvedAt, T2);
});

test('a resolved finding that returns is reopened with a new opening time', () => {
  const store = newStore();
  store.syncFindings([finding()], T1);
  store.syncFindings([], T2);
  store.syncFindings([finding()], T3);
  const [stored] = store.listFindings();
  assert.equal(stored?.resolvedAt, null);
  assert.equal(stored?.openedAt, T3);
});

test('purging a retired source removes its records and moves choices to the twin record in the other source', () => {
  const store = newStore();
  store.replaceCanonicalTransactions([transaction()], links, T1);
  store.setCategoryOverride('tx_1', 'Lazer', T1);
  store.setInstallmentOverride('tx_1', { number: 3, total: 6 }, T1);
  // The overrides above are saved on every linked record; keep only the pierre one, as if the owner had chosen there.
  assert.throws(() => store.purgeSource('pierre', false), /still active/);
  store.retireSourcesExcept(['pluggy']);

  const preview = store.purgeSource('pierre', false);
  assert.equal(preview.applied, false);
  assert.equal(preview.removed.transaction_links, 1);
  assert.equal(store.purgeSource('pierre', false).removed.transaction_links, 1, 'a preview changes nothing');

  const done = store.purgeSource('pierre', true);
  assert.equal(done.applied, true);
  assert.equal(done.removed.transaction_links, 1);
  assert.deepEqual(store.listTransactionLinks('tx_1').map((l) => l.sourceId), ['pluggy']);
  assert.equal(store.listCategoryOverrides().get('tx_1'), 'Lazer', 'the choice survives on the pluggy record');
  assert.deepEqual(store.listInstallmentOverrides().get('tx_1'), { number: 3, total: 6 });
});

test('purging an unknown source is refused', () => {
  assert.throws(() => newStore().purgeSource('nobody', true), /unknown source/);
});
