import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FakeAdapter, type FakeData } from '../support/fake-adapter.ts';
import { syncSource } from '../../src/sync/sync.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { SourceAccount, SourceTransaction } from '../../src/core/types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const SINCE = new Date('2026-10-01T00:00:00.000Z');
let clock = Date.parse('2026-10-20T12:00:00.000Z');
const now = () => new Date((clock += 60_000));

const account = (externalId: string): SourceAccount => ({ externalId, externalItemId: null, institution: 'Bank', kind: 'credit_card', name: externalId, last4: '1111', balance: 0, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null });
const tx = (id: string, day: string, accountExternalId = 'a1'): SourceTransaction => ({ externalId: id, accountExternalId, occurredAt: `${day}T15:00:00Z`, amount: -1000, description: id, descriptionRaw: null, status: 'pending', installment: null, category: null });

function setup(data: FakeData) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  return { store, adapter: new FakeAdapter('pluggy', data), data };
}
const ids = (store: ReturnType<typeof openSqliteStore>) => store.listSourceTransactions('pluggy').map((t) => t.externalId).sort();

test('a record the provider no longer returns is removed, and one older than the read window is left alone', async () => {
  const { store, adapter, data } = setup({ accounts: [account('a1')], transactions: [tx('keep', '2026-10-10'), tx('gone', '2026-10-12'), tx('also', '2026-10-14')] });
  // A record from an earlier, longer read, now older than the window.
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, '2026-09-21T00:00:00Z');
  store.upsertSourceTransactions('pluggy', [tx('old', '2026-09-20')], '2026-09-21T00:00:00Z');
  await syncSource(adapter, { store, now }, SINCE);
  assert.deepEqual(ids(store), ['also', 'gone', 'keep', 'old']);
  // Next read: 'gone' was deleted at the provider; 'old' is older than the window and is not returned either.
  data.transactions = [tx('keep', '2026-10-10'), tx('also', '2026-10-14'), tx('new', '2026-10-15')];
  const result = await syncSource(adapter, { store, now }, SINCE);
  assert.deepEqual(ids(store), ['also', 'keep', 'new', 'old']);
  assert.deepEqual(result.warnings, []);
});

test('a read that returns almost nothing is treated as a failed read and removes nothing', async () => {
  const many = Array.from({ length: 12 }, (_, i) => tx(`t${i}`, '2026-10-10'));
  const { store, adapter, data } = setup({ accounts: [account('a1')], transactions: many });
  await syncSource(adapter, { store, now }, SINCE);
  data.transactions = [tx('t0', '2026-10-10')];
  const result = await syncSource(adapter, { store, now }, SINCE);
  assert.equal(ids(store).length, 12);
  assert.match(result.warnings.join(' '), /Bank \/ a1: .*nenhum dos 11 foi removido/);
});

test('an empty read removes nothing', async () => {
  const { store, adapter, data } = setup({ accounts: [account('a1')], transactions: [tx('a', '2026-10-10')] });
  await syncSource(adapter, { store, now }, SINCE);
  data.transactions = [];
  await syncSource(adapter, { store, now }, SINCE);
  assert.deepEqual(ids(store), ['a']);
});

test('an account the provider no longer lists leaves with its transactions, and the ones still listed stay', async () => {
  const { store, adapter, data } = setup({
    accounts: [account('a1'), account('a2'), account('a3')],
    transactions: [tx('x1', '2026-10-10', 'a1'), tx('x2', '2026-10-10', 'a2'), tx('x3', '2026-10-10', 'a3')],
  });
  await syncSource(adapter, { store, now }, SINCE);
  // a3 was reconnected under a new id (a4); a1 and a2 are still there.
  data.accounts = [account('a1'), account('a2'), account('a4')];
  data.transactions = [tx('x1', '2026-10-10', 'a1'), tx('x2', '2026-10-10', 'a2'), tx('x4', '2026-10-10', 'a4')];
  await syncSource(adapter, { store, now }, SINCE);
  assert.deepEqual(store.listSourceAccounts('pluggy').map((a) => a.externalId).sort(), ['a1', 'a2', 'a4']);
  assert.deepEqual(ids(store), ['x1', 'x2', 'x4']);
});

test('losing most accounts in one read is not trusted', async () => {
  const { store, adapter, data } = setup({ accounts: [account('a1'), account('a2'), account('a3')], transactions: [] });
  await syncSource(adapter, { store, now }, SINCE);
  data.accounts = [account('a1')];
  const result = await syncSource(adapter, { store, now }, SINCE);
  assert.equal(store.listSourceAccounts('pluggy').length, 3);
  assert.match(result.warnings.join(' '), /none were removed/);
});

test('two syncs of one source run one after the other', async () => {
  const { store, data } = setup({ accounts: [account('a1')], transactions: [] });
  const order: string[] = [];
  class Slow extends FakeAdapter {
    override async fetchTransactions() {
      order.push('start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('end');
      return [];
    }
  }
  const slow = new Slow('pluggy', data);
  await Promise.all([syncSource(slow, { store, now }, SINCE), syncSource(slow, { store, now }, SINCE)]);
  assert.deepEqual(order, ['start', 'end', 'start', 'end']);
});
