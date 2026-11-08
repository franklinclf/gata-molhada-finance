import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { setTransactionCycle, setTransactionStatus } from '../../src/api/mutations.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-30T12:00:00Z');

const account = (id: string, kind: CanonicalAccount['kind']): CanonicalAccount => ({
  id, institution: 'Bank', kind, name: id, last4: null, balance: 0, balanceSourceId: 'pluggy', balanceAsOf: NOW.toISOString(), creditLimit: null, availableLimit: null,
  minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pluggy', externalId: `ext-${id}`, role: 'member' }],
});
const tx = (id: string, accountId: string, over: Partial<CanonicalTransaction> = {}): CanonicalTransaction => ({
  id, accountId, occurredAt: '2026-10-05T15:00:00Z', amount: -7835, description: id, descriptionRaw: null, status: 'pending', installment: null, category: null,
  state: 'single_source', sourceIds: ['pluggy'], excluded: false, ...over,
});

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  const list = [tx('card-charge', 'card'), tx('bank-old', 'bank', { state: 'stale_pending', excluded: true })];
  store.replaceCanonicalAccounts([account('card', 'credit_card'), account('bank', 'checking')], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), NOW.toISOString());
  return store;
}

test('the status the owner sets wins over the source, and clearing it goes back', () => {
  const store = seeded();
  store.setTransactionOverride('card-charge', { status: 'posted' }, NOW.toISOString());
  const t = effectiveTransactions(store).find((x) => x.id === 'card-charge')!;
  assert.deepEqual([t.status, t.statusByUser], ['posted', true]);
  store.setTransactionOverride('card-charge', { status: null }, NOW.toISOString());
  const back = effectiveTransactions(store).find((x) => x.id === 'card-charge')!;
  assert.deepEqual([back.status, back.statusByUser], ['pending', false]);
  assert.equal(store.listTransactionOverrides().size, 0, 'an override with nothing left is removed');
});

test('calling a set-aside pending entry posted brings it back into the totals', () => {
  const store = seeded();
  assert.equal(effectiveTransactions(store).some((t) => t.id === 'bank-old'), false);
  store.setTransactionOverride('bank-old', { status: 'posted' }, NOW.toISOString());
  const back = effectiveTransactions(store).find((t) => t.id === 'bank-old');
  assert.deepEqual([back?.status, back?.state, back?.excluded], ['posted', 'single_source', false]);
});

test('setting the bill leaves the status alone, and the other way round', () => {
  const store = seeded();
  store.setTransactionOverride('card-charge', { status: 'posted' }, NOW.toISOString());
  store.setTransactionOverride('card-charge', { cycleKey: '2026-10' }, NOW.toISOString());
  assert.deepEqual(store.listTransactionOverrides().get('card-charge'), { status: 'posted', cycleKey: '2026-10' });
  store.setTransactionOverride('card-charge', { status: null }, NOW.toISOString());
  assert.deepEqual(store.listTransactionOverrides().get('card-charge'), { status: null, cycleKey: '2026-10' });
});

test('the mutations check their input, and only a card charge can be moved to a bill', () => {
  const store = seeded();
  assert.deepEqual(setTransactionStatus(store, 'nope', 'posted', NOW), { ok: false, status: 404, error: 'not_found' });
  assert.equal((setTransactionStatus(store, 'card-charge', 'done', NOW) as { status: number }).status, 400);
  assert.equal((setTransactionCycle(store, 'card-charge', '10/2026', NOW) as { status: number }).status, 400);
  assert.equal((setTransactionCycle(store, 'bank-old', '2026-10', NOW) as { status: number }).status, 400);
  assert.deepEqual(setTransactionCycle(store, 'card-charge', '2026-10', NOW), { ok: true });
  assert.equal(effectiveTransactions(store).find((t) => t.id === 'card-charge')?.billCycle, '2026-10');
});

test('a pending card charge shows as posted once the bill that holds it is published', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', [{ externalId: 'b-oct', accountExternalId: 'ext-card', dueDate: '2026-10-15', closingDate: '2026-10-08', total: 30000, minimumPayment: null }], NOW.toISOString());
  const forecast = (month: string) => ({ operation: null, mcc: null, payer: null, receiver: null, billForecast: month });
  const source = (externalId: string, occurredAt: string, parties?: ReturnType<typeof forecast>) => ({ externalId, accountExternalId: 'ext-card', occurredAt, amount: -1000, description: externalId, descriptionRaw: null, status: 'pending' as const, installment: null, category: null, parties });
  store.upsertSourceTransactions('pluggy', [
    source('e-forecast', '2026-10-02T15:00:00Z', forecast('2026-10')),
    source('e-dated', '2026-10-03T15:00:00Z'),
    source('e-after', '2026-10-20T15:00:00Z'),
    source('e-next', '2026-10-07T15:00:00Z', forecast('2026-11')),
    source('e-word', '2026-10-04T15:00:00Z', forecast('2026-10')),
  ], NOW.toISOString());
  const days: Record<string, string> = { forecast: '2026-10-02', dated: '2026-10-03', after: '2026-10-20', next: '2026-10-07', word: '2026-10-04' };
  const list = Object.entries(days).map(([n, day]) => tx(n, 'card', { description: n, occurredAt: `${day}T15:00:00Z` }));
  store.replaceCanonicalAccounts([account('card', 'credit_card')], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), NOW.toISOString());
  store.setTransactionOverride('word', { status: 'pending' }, NOW.toISOString());
  const read = Object.fromEntries(effectiveTransactions(store).map((t) => [t.id, [t.status, t.statusByBill, t.statusByUser]]));
  assert.deepEqual(read.forecast, ['posted', true, false], 'the bank puts it on a published bill');
  assert.deepEqual(read.dated, ['posted', true, false], 'no word from the bank: dated on or before the last closing');
  assert.deepEqual(read.after, ['pending', false, false], 'dated after the last closing, so it is still on the open bill');
  assert.deepEqual(read.next, ['pending', false, false], 'the bank expects it on a bill that is not published');
  assert.deepEqual(read.word, ['pending', false, true], 'the owner called it pending');
});
