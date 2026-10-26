import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FakeAdapter } from '../support/fake-adapter.ts';
import { createSnapshotSink, registerAdapter, syncSource } from '../../src/sync/sync.ts';
import { SourceHttpError } from '../../src/core/http.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { SourceAccount, SourceTransaction } from '../../src/core/types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T15:00:00.000Z');
const SINCE = new Date('2026-08-01T00:00:00.000Z');

const account: SourceAccount = {
  externalId: 'acc-1',
  externalItemId: null,
  institution: 'Bank A',
  kind: 'checking',
  name: 'Conta Corrente',
  last4: null,
  balance: 152345,
  creditLimit: null,
  availableLimit: null,
  minimumPayment: null,
  dueDate: null,
};

const tx = (id: string, occurredAt: string): SourceTransaction => ({
  externalId: id,
  accountExternalId: 'acc-1',
  occurredAt,
  amount: -1990,
  description: 'Coffee',
  descriptionRaw: null,
  status: 'posted',
  installment: null,
  category: null,
});

class FailingBills extends FakeAdapter {
  override async fetchBills(): Promise<never> {
    throw new SourceHttpError(500, 'https://x.test/bills?token=secret');
  }
}

class WarningAdapter extends FakeAdapter {
  drainWarnings(): string[] {
    return ['skipped one account'];
  }
}

function setup() {
  return openSqliteStore(':memory:', MIGRATIONS);
}

test('stores accounts, transactions, bills and freshness from a source', async () => {
  const store = setup();
  const adapter = new FakeAdapter('fake', {
    accounts: [account],
    freshness: [{ sourceId: 'fake', institution: 'Bank A', lastUpdatedAt: '2026-10-26T14:00:00.000Z', observedAt: NOW.toISOString() }],
    transactions: [tx('t1', '2026-09-01T10:00:00.000Z'), tx('t2', '2026-07-01T10:00:00.000Z')],
    bills: [{ externalId: 'b1', accountExternalId: 'acc-1', dueDate: '2026-11-10', closingDate: null, total: 1000, minimumPayment: null }],
  });
  const result = await syncSource(adapter, { store, now: () => NOW }, SINCE);
  assert.deepEqual(result, {
    sourceId: 'fake',
    accounts: 1,
    transactions: 1,
    bills: 1,
    freshness: 1,
    warnings: [],
    errors: [],
  });
  assert.equal(store.listSourceTransactions('fake').length, 1);
  assert.equal(store.listFreshness()[0]?.institution, 'Bank A');
});

test('running the sync twice does not duplicate records', async () => {
  const store = setup();
  const adapter = new FakeAdapter('fake', { accounts: [account], transactions: [tx('t1', '2026-09-01T10:00:00.000Z')] });
  await syncSource(adapter, { store, now: () => NOW }, SINCE);
  await syncSource(adapter, { store, now: () => new Date('2026-10-26T16:00:00.000Z') }, SINCE);
  assert.equal(store.listSourceAccounts('fake').length, 1);
  const [stored] = store.listSourceTransactions('fake');
  assert.equal(store.listSourceTransactions('fake').length, 1);
  assert.equal(stored?.firstSeenAt, NOW.toISOString());
  assert.equal(stored?.lastSeenAt, '2026-10-26T16:00:00.000Z');
});

test('a failing step is reported without a url query and does not stop the others', async () => {
  const store = setup();
  const adapter = new FailingBills('fake', { accounts: [account], transactions: [tx('t1', '2026-09-01T10:00:00.000Z')] });
  const result = await syncSource(adapter, { store, now: () => NOW }, SINCE);
  assert.equal(result.accounts, 1);
  assert.equal(result.transactions, 1);
  assert.deepEqual(result.errors, ['bills: HTTP 500 from https://x.test/bills']);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('adapter warnings are included in the result', async () => {
  const store = setup();
  const result = await syncSource(new WarningAdapter('fake'), { store, now: () => NOW }, SINCE);
  assert.deepEqual(result.warnings, ['skipped one account']);
});

test('the snapshot sink stores each raw response under the source', () => {
  const store = setup();
  registerAdapter(new FakeAdapter('fake'), store, NOW);
  const sink = createSnapshotSink(store, 'fake', () => NOW);
  sink({ endpoint: 'get-accounts', httpStatus: 200, body: { data: [] } });
  const snapshot = store.latestSnapshot('fake', 'get-accounts');
  assert.equal(snapshot?.fetchedAt, NOW.toISOString());
  assert.deepEqual(snapshot?.body, { data: [] });
});

test('registerAdapter records the declared capabilities and is repeatable', () => {
  const store = setup();
  const adapter = new FakeAdapter('fake', {}, { refreshOnDemand: true });
  registerAdapter(adapter, store, NOW);
  registerAdapter(adapter, store, NOW);
  store.saveSnapshot({ sourceId: 'fake', endpoint: 'e', fetchedAt: NOW.toISOString(), httpStatus: 200, body: {} });
});
