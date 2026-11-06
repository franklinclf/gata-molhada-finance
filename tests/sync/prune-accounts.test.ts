import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FakeAdapter, type FakeData } from '../support/fake-adapter.ts';
import { syncSource } from '../../src/sync/sync.ts';
import { SourceHttpError } from '../../src/core/http.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { SourceAccount, SourceTransaction } from '../../src/core/types.ts';

// Pruning and failures are judged account by account: one account that fails or comes back empty never costs another its records.

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

test('a small account that comes back empty keeps its records and is named in a warning, while the big one is still cleaned', async () => {
  const big = Array.from({ length: 10 }, (_, i) => tx(`big${i}`, '2026-10-10', 'a1'));
  const { store, adapter, data } = setup({ accounts: [account('a1'), account('a2')], transactions: [...big, tx('card1', '2026-10-11', 'a2'), tx('card2', '2026-10-12', 'a2')] });
  await syncSource(adapter, { store, now }, SINCE);
  // a2 is a sixth of the rows, so the old source-wide guard would not have stopped its removal.
  data.transactions = big.slice(1);
  const result = await syncSource(adapter, { store, now }, SINCE);
  assert.deepEqual(ids(store).filter((id) => id.startsWith('card')), ['card1', 'card2']);
  assert.equal(ids(store).includes('big0'), false, 'the account that answered is cleaned as before');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /Bank \/ a2: nenhuma transação voltou/);
});

test('a hard reset also keeps an account that came back empty', async () => {
  const { store, adapter, data } = setup({ accounts: [account('a1'), account('a2')], transactions: [tx('x1', '2026-10-10', 'a1'), tx('x2', '2026-10-10', 'a2')] });
  await syncSource(adapter, { store, now }, SINCE);
  data.transactions = [tx('x1', '2026-10-10', 'a1')];
  const result = await syncSource(adapter, { store, now }, SINCE, { fullWindow: true });
  assert.deepEqual(ids(store), ['x1', 'x2']);
  assert.match(result.warnings.join(' '), /Bank \/ a2/);
});

test('the guard against a partial read applies to each account, not to the whole source', async () => {
  const a1 = Array.from({ length: 12 }, (_, i) => tx(`p${i}`, '2026-10-10', 'a1'));
  const a2 = Array.from({ length: 40 }, (_, i) => tx(`q${i}`, '2026-10-10', 'a2'));
  const { store, adapter, data } = setup({ accounts: [account('a1'), account('a2')], transactions: [...a1, ...a2] });
  await syncSource(adapter, { store, now }, SINCE);
  // a1 keeps 2 of 12 (most gone); a2 is complete. The whole source lost 10 of 52, under half, which the old guard let through.
  data.transactions = [...a1.slice(0, 2), ...a2];
  const result = await syncSource(adapter, { store, now }, SINCE);
  assert.equal(ids(store).filter((id) => id.startsWith('p')).length, 12);
  assert.match(result.warnings.join(' '), /Bank \/ a1: .*nenhum dos 10 foi removido/);
});

test('an account whose read failed is left alone, the others are saved and cleaned, and the warning names the failed one', async () => {
  const { store, data } = setup({ accounts: [account('a1'), account('a2')], transactions: [tx('x1', '2026-10-10', 'a1'), tx('old1', '2026-10-11', 'a1'), tx('x2', '2026-10-10', 'a2')] });
  await syncSource(new FakeAdapter('pluggy', data), { store, now }, SINCE);
  class OneFails extends FakeAdapter {
    async fetchTransactionRead() {
      return {
        transactions: [tx('x1', '2026-10-10', 'a1'), tx('new1', '2026-10-13', 'a1')],
        readAccountIds: ['a1'],
        failed: [{ accountId: 'a2', label: 'Bank / a2', error: new SourceHttpError(500, 'https://x.test/v2/transactions?accountId=a2&token=s') }],
      };
    }
  }
  const result = await syncSource(new OneFails('pluggy', data), { store, now }, SINCE);
  assert.deepEqual(ids(store), ['new1', 'x1', 'x2'], 'a1 got its new record and lost the one the provider dropped; a2 kept everything');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.failedAccounts, ['Bank / a2']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /^Bank \/ a2: .*HTTP 500 from https:\/\/x\.test\/v2\/transactions/);
  assert.equal(result.warnings[0]?.includes('token'), false);
});

test('when every account fails the read is an error and nothing is removed, even in a hard reset', async () => {
  const { store, data } = setup({ accounts: [account('a1')], transactions: [tx('x1', '2026-10-10')] });
  await syncSource(new FakeAdapter('pluggy', data), { store, now }, SINCE);
  class AllFail extends FakeAdapter {
    async fetchTransactionRead() {
      return { transactions: [], readAccountIds: [], failed: [{ accountId: 'a1', label: 'Bank / a1', error: new Error('down') }] };
    }
  }
  const result = await syncSource(new AllFail('pluggy', data), { store, now }, SINCE, { fullWindow: true });
  assert.deepEqual(result.errors, ['transactions: down']);
  assert.deepEqual(ids(store), ['x1']);
});
