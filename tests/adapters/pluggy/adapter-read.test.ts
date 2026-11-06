import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluggyAdapter } from '../../../src/adapters/pluggy/adapter.ts';
import { SourceHttpError } from '../../../src/core/http.ts';
import { FakeHttp, ok, type FakeRoute } from '../../support/fake-http.ts';
import { pluggyBankAccount, pluggyBankCredit, pluggyCardAccount, pluggyItem } from '../../fixtures/pluggy.ts';

const NOW = () => new Date('2026-10-26T15:00:00.000Z');
const CONFIG = { clientId: 'cid', clientSecret: 'super-secret', items: [{ label: 'Bank A', itemId: 'item-1' }] };
const SINCE = new Date('2026-08-01T00:00:00.000Z');

function build(cardStatus: number) {
  const routes: FakeRoute[] = [
    { method: 'POST', match: '/auth', respond: () => ok({ apiKey: 'key-1' }) },
    { method: 'GET', match: '/items/item-1', respond: () => ok(pluggyItem) },
    { method: 'GET', match: /\/accounts\?itemId=item-1$/, respond: () => ok({ results: [pluggyBankAccount, pluggyCardAccount] }) },
    { method: 'GET', match: /\/v2\/transactions\?accountId=acc-bank-1/, respond: () => ok({ results: [pluggyBankCredit], next: null }) },
    { method: 'GET', match: /\/v2\/transactions\?accountId=acc-card-1/, respond: () => ({ status: cardStatus, body: cardStatus === 200 ? { results: [], next: null } : { message: 'boom' } }) },
  ];
  return new PluggyAdapter(CONFIG, { http: new FakeHttp(routes), sink: () => {}, now: NOW });
}

test('fetchTransactionRead returns the accounts that worked when one fails, with the name of the one that did not', async () => {
  const read = await build(500).fetchTransactionRead(SINCE);
  assert.deepEqual(read.readAccountIds, ['acc-bank-1']);
  assert.deepEqual(read.transactions.map((t) => t.externalId), ['tx-1']);
  assert.equal(read.failed.length, 1);
  assert.equal(read.failed[0]?.accountId, 'acc-card-1');
  assert.match(read.failed[0]?.label ?? '', /^Bank A \/ /);
  assert.ok(read.failed[0]?.error instanceof SourceHttpError);
});

test('fetchTransactionRead lists an account that answered with no rows as read', async () => {
  const read = await build(200).fetchTransactionRead(SINCE);
  assert.deepEqual(read.readAccountIds, ['acc-bank-1', 'acc-card-1']);
  assert.deepEqual(read.failed, []);
});

test('the strict fetchTransactions still fails when any account fails', async () => {
  await assert.rejects(build(500).fetchTransactions(SINCE), (e: Error) => e instanceof SourceHttpError);
});
