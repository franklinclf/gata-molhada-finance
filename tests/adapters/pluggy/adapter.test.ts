import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluggyAdapter } from '../../../src/adapters/pluggy/adapter.ts';
import { SourceHttpError } from '../../../src/core/http.ts';
import { FakeHttp, ok, type FakeRoute } from '../../support/fake-http.ts';
import {
  pluggyBankAccount,
  pluggyBankCredit,
  pluggyBill,
  pluggyCardAccount,
  pluggyCardPurchase,
  pluggyItem,
} from '../../fixtures/pluggy.ts';

const NOW = () => new Date('2026-10-26T15:00:00.000Z');
const CONFIG = { clientId: 'cid', clientSecret: 'super-secret', items: [{ label: 'Bank A', itemId: 'item-1' }] };

function baseRoutes(overrides: FakeRoute[] = []): FakeRoute[] {
  return [
    ...overrides,
    { method: 'POST', match: '/auth', respond: () => ok({ apiKey: 'key-1' }) },
    { method: 'GET', match: '/items/item-1', respond: () => ok(pluggyItem) },
    { method: 'GET', match: /\/accounts\?itemId=item-1$/, respond: () => ok({ results: [pluggyBankAccount, pluggyCardAccount] }) },
    {
      method: 'GET',
      match: /\/v2\/transactions\?accountId=acc-bank-1/,
      respond: () => ok({ results: [pluggyBankCredit], next: null }),
    },
    {
      method: 'GET',
      match: /\/v2\/transactions\?accountId=acc-card-1/,
      respond: () => ok({ results: [pluggyCardPurchase], next: null }),
    },
    { method: 'GET', match: /\/bills\?accountId=acc-card-1&page=1$/, respond: () => ok({ page: 1, totalPages: 1, results: [pluggyBill] }) },
  ];
}

function build(routes: FakeRoute[] = baseRoutes()) {
  const http = new FakeHttp(routes);
  const snapshots: Array<{ endpoint: string; httpStatus: number; body: unknown }> = [];
  const adapter = new PluggyAdapter(CONFIG, { http, sink: (s) => snapshots.push(s), now: NOW });
  return { http, snapshots, adapter };
}

test('fetchAccounts returns normalized accounts and one freshness entry per item', async () => {
  const { adapter } = build();
  const { accounts, freshness } = await adapter.fetchAccounts();
  assert.deepEqual(accounts.map((a) => [a.externalId, a.kind, a.institution]), [
    ['acc-bank-1', 'checking', 'Bank A'],
    ['acc-card-1', 'credit_card', 'Bank A'],
  ]);
  assert.deepEqual(freshness, [
    { sourceId: 'pluggy', institution: 'Bank A', lastUpdatedAt: '2026-10-26T14:53:55.112Z', observedAt: '2026-10-26T15:00:00.000Z' },
  ]);
});

test('authenticates once and sends the key on every data call', async () => {
  const { http, adapter } = build();
  await adapter.fetchAccounts();
  await adapter.fetchTransactions(new Date('2026-08-01T00:00:00.000Z'));
  assert.equal(http.callsTo('POST', '/auth').length, 1);
  const dataCalls = http.calls.filter((c) => c.method === 'GET');
  assert.ok(dataCalls.length > 0);
  assert.ok(dataCalls.every((c) => c.options?.headers?.['X-API-KEY'] === 'key-1'));
  assert.deepEqual(http.callsTo('POST', '/auth')[0]?.options?.body, { clientId: 'cid', clientSecret: 'super-secret' });
});

test('never passes credentials or the api key to the snapshot sink', async () => {
  const { snapshots, adapter } = build();
  await adapter.fetchAccounts();
  await adapter.fetchTransactions(new Date('2026-08-01T00:00:00.000Z'));
  await adapter.fetchBills();
  assert.ok(snapshots.length >= 5);
  const text = JSON.stringify(snapshots);
  assert.equal(text.includes('super-secret'), false);
  assert.equal(text.includes('key-1'), false);
  assert.ok(snapshots.some((s) => s.endpoint === '/items/item-1'));
});

test('fetchTransactions uses the date window and the account kind for the sign', async () => {
  const { http, adapter } = build();
  const txs = await adapter.fetchTransactions(new Date('2026-08-01T10:00:00.000Z'));
  assert.ok(http.callsTo('GET', 'dateFrom=2026-08-01&dateTo=2026-10-26').length === 2);
  const byId = Object.fromEntries(txs.map((t) => [t.externalId, t]));
  assert.equal(byId['tx-1']?.amount, 15000);
  assert.equal(byId['tx-2']?.amount, -9990);
});

test('fetchTransactions follows the cursor across pages', async () => {
  const routes = baseRoutes([
    {
      method: 'GET',
      match: /\/v2\/transactions\?after=abc$/,
      respond: () => ok({ results: [{ ...pluggyBankCredit, id: 'tx-1b' }], next: null }),
    },
    {
      method: 'GET',
      match: /\/v2\/transactions\?accountId=acc-bank-1/,
      respond: () => ok({ results: [pluggyBankCredit], next: '?after=abc' }),
    },
  ]);
  const { adapter } = build(routes);
  const txs = await adapter.fetchTransactions(new Date('2026-08-01T00:00:00.000Z'));
  assert.deepEqual(txs.filter((t) => t.accountExternalId === 'acc-bank-1').map((t) => t.externalId), ['tx-1', 'tx-1b']);
});

test('re-authenticates once when the cached key is rejected', async () => {
  let accountCalls = 0;
  let authCalls = 0;
  const routes: FakeRoute[] = [
    ...baseRoutes().filter((r) => !(r.method === 'POST' && r.match === '/auth') && !String(r.match).includes('accounts')),
    { method: 'POST', match: '/auth', respond: () => ok({ apiKey: `key-${++authCalls}` }) },
    {
      method: 'GET',
      match: /\/accounts\?itemId=item-1$/,
      respond: (_url, options) => {
        accountCalls++;
        return options?.headers?.['X-API-KEY'] === 'key-1' && accountCalls === 2
          ? { status: 403, body: { message: 'expired' } }
          : ok({ results: [pluggyBankAccount] });
      },
    },
  ];
  const { adapter } = build(routes);
  await adapter.fetchAccounts();
  await adapter.fetchAccounts();
  assert.equal(authCalls, 2);
});

test('raises SourceHttpError for a failing endpoint', async () => {
  const routes = baseRoutes([{ method: 'GET', match: '/items/item-1', respond: () => ({ status: 500, body: { message: 'boom' } }) }]);
  const { adapter } = build(routes);
  await assert.rejects(adapter.fetchAccounts(), (e: Error) => e instanceof SourceHttpError && (e as SourceHttpError).status === 500);
});

test('skips unsupported account types and reports them once', async () => {
  const routes = baseRoutes([
    {
      method: 'GET',
      match: /\/accounts\?itemId=item-1$/,
      respond: () => ok({ results: [pluggyBankAccount, { ...pluggyBankAccount, id: 'acc-x', type: 'INVESTMENT', subtype: 'FUND' }] }),
    },
  ]);
  const { adapter } = build(routes);
  const { accounts } = await adapter.fetchAccounts();
  assert.deepEqual(accounts.map((a) => a.externalId), ['acc-bank-1']);
  const warnings = adapter.drainWarnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /Bank A: skipped an account/);
  assert.deepEqual(adapter.drainWarnings(), []);
});

test('fetchBills reads only credit card accounts and all pages', async () => {
  const routes = baseRoutes([
    { method: 'GET', match: /\/bills\?accountId=acc-card-1&page=2$/, respond: () => ok({ page: 2, totalPages: 2, results: [{ ...pluggyBill, id: 'bill-2' }] }) },
    { method: 'GET', match: /\/bills\?accountId=acc-card-1&page=1$/, respond: () => ok({ page: 1, totalPages: 2, results: [pluggyBill] }) },
  ]);
  const { http, adapter } = build(routes);
  const bills = await adapter.fetchBills();
  assert.deepEqual(bills.map((b) => b.externalId), ['bill-1', 'bill-2']);
  assert.equal(http.callsTo('GET', 'acc-bank-1').filter((c) => c.url.includes('/bills')).length, 0);
});
