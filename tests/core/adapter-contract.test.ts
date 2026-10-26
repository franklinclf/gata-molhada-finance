import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '../support/fake-adapter.ts';
import type { SourceTransaction } from '../../src/core/types.ts';

function tx(externalId: string, occurredAt: string): SourceTransaction {
  return {
    externalId,
    accountExternalId: 'acc-1',
    occurredAt,
    amount: -1990,
    description: 'Coffee',
    descriptionRaw: 'COFFEE SHOP',
    status: 'posted',
    installment: null,
    category: null,
  };
}

test('fetchTransactions returns only transactions since the given date', async () => {
  const adapter = new FakeAdapter('fake', {
    transactions: [tx('old', '2026-10-01T10:00:00.000Z'), tx('new', '2026-10-20T10:00:00.000Z')],
  });
  const result = await adapter.fetchTransactions(new Date('2026-10-10T00:00:00.000Z'));
  assert.deepEqual(result.map((t) => t.externalId), ['new']);
});

test('requestRefresh exists only when the capability is declared', async () => {
  const plain = new FakeAdapter('plain');
  assert.equal(plain.requestRefresh, undefined);

  const refreshable = new FakeAdapter('refreshable', {}, { refreshOnDemand: true });
  const handle = await refreshable.requestRefresh?.();
  assert.match(handle?.requestedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(refreshable.refreshCalls.length, 1);
});

test('fetchAccounts returns accounts together with freshness', async () => {
  const adapter = new FakeAdapter('fake', {
    freshness: [{ sourceId: 'fake', institution: 'Bank A', lastUpdatedAt: '2026-10-26T04:00:00.000Z', observedAt: '2026-10-26T04:05:00.000Z' }],
  });
  const { accounts, freshness } = await adapter.fetchAccounts();
  assert.deepEqual(accounts, []);
  assert.equal(freshness[0]?.institution, 'Bank A');
});
