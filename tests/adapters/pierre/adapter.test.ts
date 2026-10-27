import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PierreAdapter } from '../../../src/adapters/pierre/adapter.ts';
import { SourceFormatError, SourceHttpError } from '../../../src/core/http.ts';
import { FakeHttp, ok, type FakeRoute } from '../../support/fake-http.ts';
import {
  pierreBankAccount,
  pierreBankCredit,
  pierreBill,
  pierreCardAccount,
  pierreCardPurchase,
  pierreWalletAccount,
} from '../../fixtures/pierre.ts';

const NOW = () => new Date('2026-10-26T15:00:00.000Z');

function routes(overrides: FakeRoute[] = []): FakeRoute[] {
  return [
    ...overrides,
    { method: 'GET', match: '/get-accounts', respond: () => ok({ success: true, data: [pierreBankAccount, pierreCardAccount, pierreWalletAccount] }) },
    { method: 'GET', match: /\/get-transactions\?/, respond: () => ok({ success: true, data: [pierreBankCredit, pierreCardPurchase] }) },
    { method: 'GET', match: '/get-bills', respond: () => ok({ success: true, data: [pierreBill] }) },
    { method: 'POST', match: '/manual-update', respond: () => ok({ success: true, message: 'Manual sync initiated' }) },
  ];
}

function build(overrides: FakeRoute[] = []) {
  const http = new FakeHttp(routes(overrides));
  const snapshots: Array<{ endpoint: string; httpStatus: number; body: unknown }> = [];
  const adapter = new PierreAdapter({ apiKey: 'sk-test-key' }, { http, sink: (s) => snapshots.push(s), now: NOW });
  return { http, snapshots, adapter };
}

test('fetchAccounts returns accounts with card limits learned from transactions', async () => {
  const { adapter } = build();
  const { accounts } = await adapter.fetchAccounts();
  const card = accounts.find((a) => a.externalId === 'p-acc-card');
  assert.equal(card?.creditLimit, 500000);
  assert.equal(card?.availableLimit, 467950);
  assert.equal(accounts.length, 3);
});

test('freshness has one entry per connector and skips manual accounts', async () => {
  const { adapter } = build();
  const { freshness } = await adapter.fetchAccounts();
  assert.deepEqual(freshness, [
    { sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T13:34:07.676Z', observedAt: '2026-10-26T15:00:00.000Z' },
  ]);
});

test('sends the bearer key and reads the credit window of 90 days', async () => {
  const { http, adapter } = build();
  await adapter.fetchAccounts();
  assert.ok(http.calls.every((c) => c.options?.headers?.Authorization === 'Bearer sk-test-key'));
  assert.equal(http.callsTo('GET', 'startDate=2026-07-28&endDate=2026-10-26').length, 1);
});

test('fetchTransactions asks for raw posted and pending transactions since the date', async () => {
  const { http, adapter } = build();
  const txs = await adapter.fetchTransactions(new Date('2026-09-01T00:00:00.000Z'));
  assert.deepEqual(txs.map((t) => t.externalId), ['p-tx-1', 'p-tx-2']);
  const call = http.callsTo('GET', 'get-transactions')[0];
  assert.match(call?.url ?? '', /startDate=2026-09-01&endDate=2026-10-26&format=raw&includeStatus=POSTED,PENDING$/);
});

test('fetchBills normalizes the bills', async () => {
  const { adapter } = build();
  const bills = await adapter.fetchBills();
  assert.equal(bills[0]?.total, 32050);
});

test('stores every raw response in the sink, without the api key', async () => {
  const { snapshots, adapter } = build();
  await adapter.fetchAccounts();
  await adapter.fetchBills();
  assert.deepEqual(snapshots.map((s) => s.endpoint.split('?')[0]), ['get-accounts', 'get-transactions', 'get-bills']);
  assert.equal(JSON.stringify(snapshots).includes('sk-test-key'), false);
});

test('requestRefresh posts once and reports when it was requested', async () => {
  const { http, adapter } = build();
  const handle = await adapter.requestRefresh();
  assert.equal(handle.requestedAt, '2026-10-26T15:00:00.000Z');
  assert.equal(http.callsTo('POST', 'manual-update').length, 1);
});

test('requestRefresh fails on a rejected request and on an unexpected answer', async () => {
  const rejected = build([{ method: 'POST', match: '/manual-update', respond: () => ({ status: 400, body: { error: 'no accounts' } }) }]);
  await assert.rejects(rejected.adapter.requestRefresh(), (e: Error) => e instanceof SourceHttpError);

  const odd = build([{ method: 'POST', match: '/manual-update', respond: () => ok({ success: false }) }]);
  await assert.rejects(odd.adapter.requestRefresh(), SourceFormatError);
});

test('an authentication error surfaces as SourceHttpError with the status', async () => {
  const { adapter } = build([
    { method: 'GET', match: '/get-accounts', respond: () => ({ status: 401, body: { type: 'invalid_api_key' } }) },
  ]);
  await assert.rejects(adapter.fetchAccounts(), (e: Error) => e instanceof SourceHttpError && (e as SourceHttpError).status === 401);
});

test('skips accounts and transactions of unsupported types and reports them', async () => {
  const odd = { ...pierreBankAccount, id: 'p-acc-odd', type: 'INVESTMENT', subtype: 'FUND' };
  const oddTx = { ...pierreBankCredit, id: 'p-tx-odd', account_type: 'INVESTMENT', account_subtype: 'FUND' };
  const { adapter } = build([
    { method: 'GET', match: '/get-accounts', respond: () => ok({ data: [pierreBankAccount, odd] }) },
    { method: 'GET', match: /\/get-transactions\?/, respond: () => ok({ data: [pierreBankCredit, oddTx] }) },
  ]);
  const { accounts } = await adapter.fetchAccounts();
  const txs = await adapter.fetchTransactions(new Date('2026-09-01T00:00:00.000Z'));
  assert.deepEqual(accounts.map((a) => a.externalId), ['p-acc-bank']);
  assert.deepEqual(txs.map((t) => t.externalId), ['p-tx-1']);
  assert.equal(adapter.drainWarnings().length, 2);
});

test('fetchFreshness reads only the account list and records nothing', async () => {
  const { http, snapshots, adapter } = build();
  const freshness = await adapter.fetchFreshness();
  assert.deepEqual(freshness, [
    { sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T13:34:07.676Z', observedAt: '2026-10-26T15:00:00.000Z' },
  ]);
  assert.equal(http.calls.length, 1);
  assert.equal(http.callsTo('GET', 'get-accounts').length, 1);
  assert.deepEqual(snapshots, []);
});
