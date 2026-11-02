import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FakeAdapter, type FakeData } from '../support/fake-adapter.ts';
import { createResetter } from '../../src/sync/reset.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { SourceAccount, SourceTransaction } from '../../src/core/types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-20T12:00:00.000Z');
// Every reading gets its own timestamp, as in real life: what a read did not return is told apart by an older one.
let clock = NOW.getTime();
const tick = () => new Date((clock += 60_000));

const account: SourceAccount = { externalId: 'a1', externalItemId: null, institution: 'Bank', kind: 'checking', name: 'Conta', last4: null, balance: 1000, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null };
const tx = (id: string, day: string): SourceTransaction => ({ externalId: id, accountExternalId: 'a1', occurredAt: `${day}T15:00:00Z`, amount: -1000, description: id, descriptionRaw: null, status: 'posted', installment: null, category: null });

async function finished(r: ReturnType<typeof createResetter>) {
  for (let i = 0; i < 200 && r.state().running; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  return r.state();
}

function setup(data: FakeData) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const adapter = new FakeAdapter('pluggy', data);
  const log: string[] = [];
  const resetter = createResetter({ store, adapter, now: tick, backup: () => (log.push('backup'), '/data/backups/x.sqlite'), categorize: async () => (log.push('categorize'), 'IA: 3 descrições') });
  return { store, data, resetter, log };
}

test('a soft reset reads everything again, rebuilds, forgets what the AI decided by itself and categorizes again', async () => {
  const { store, data, resetter, log } = setup({ accounts: [account], transactions: [tx('keep', '2026-10-10'), tx('gone', '2026-10-12')] });
  store.saveAiCategory({ matchKey: 'a', sample: 'A', category: 'Lazer e esportes', confidence: 'high', status: 'applied', model: 'm', taxonomy: 't', decidedAt: NOW.toISOString() });
  store.saveAiCategory({ matchKey: 'b', sample: 'B', category: 'Saúde', confidence: 'high', status: 'accepted', model: 'm', taxonomy: 't', decidedAt: NOW.toISOString() });
  assert.deepEqual(resetter.start('soft'), { started: true });
  assert.deepEqual(resetter.start('soft'), { started: false, reason: 'another reset is still running' });
  const done = await finished(resetter);
  assert.equal(done.result, 'completed');
  assert.match(done.summary ?? '', /2 transações, 1 contas/);
  assert.deepEqual(log, ['categorize'], 'a soft reset makes no copy');
  assert.deepEqual([...store.listAiCategories().keys()], ['b'], 'only what the owner accepted is kept');
  data.transactions = [tx('keep', '2026-10-10')];
  resetter.start('soft');
  await finished(resetter);
  assert.deepEqual(store.listSourceTransactions('pluggy').map((t) => t.externalId), ['keep'], 'what the source stopped returning goes, as in any read');
  assert.ok(store.listCanonicalTransactions({ includeExcluded: true }).length >= 1);
});

test('a soft reset keeps the records when most of them stop coming back (it looks like a bad read) and says so, a hard one does not', async () => {
  const many = Array.from({ length: 12 }, (_, i) => tx(`t${i}`, '2026-10-10'));
  const { store, data, resetter } = setup({ accounts: [account], transactions: many });
  resetter.start('soft');
  await finished(resetter);
  data.transactions = [tx('t0', '2026-10-10')];
  resetter.start('soft');
  const done = await finished(resetter);
  assert.equal(store.listSourceTransactions('pluggy').length, 12);
  assert.match(done.summary ?? '', /none were removed/);
});

test('a hard reset copies the database first and removes what the source no longer returns, even when most of it is gone', async () => {
  const many = Array.from({ length: 12 }, (_, i) => tx(`t${i}`, '2026-10-10'));
  const { store, data, resetter, log } = setup({ accounts: [account], transactions: many });
  resetter.start('hard');
  await finished(resetter);
  data.transactions = [tx('t0', '2026-10-10')];
  resetter.start('hard');
  const done = await finished(resetter);
  assert.equal(done.result, 'completed');
  assert.deepEqual(log.filter((l) => l === 'backup').length, 2);
  assert.deepEqual(store.listSourceTransactions('pluggy').map((t) => t.externalId), ['t0']);
});

test('a read that fails leaves the saved records untouched and says why', async () => {
  const { store, data, resetter } = setup({ accounts: [account], transactions: [tx('a', '2026-10-10'), tx('b', '2026-10-11')] });
  resetter.start('hard');
  await finished(resetter);
  class Down extends FakeAdapter {
    override async fetchTransactions(): Promise<never> {
      throw new Error('Pluggy is down');
    }
  }
  const failing = createResetter({ store, adapter: new Down('pluggy', data), now: tick });
  failing.start('hard');
  const done = await finished(failing);
  assert.deepEqual([done.result, done.error], ['failed', 'transactions: Pluggy is down']);
  assert.equal(store.listSourceTransactions('pluggy').length, 2);
});
