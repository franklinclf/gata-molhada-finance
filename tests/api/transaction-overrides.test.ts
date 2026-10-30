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
