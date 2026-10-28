import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { installments } from '../../src/api/installments.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

const card: CanonicalAccount = {
  id: 'c1', institution: 'Bank A', kind: 'credit_card', name: 'Card', last4: '1234', balance: 0, balanceSourceId: 'pierre', balanceAsOf: '2026-10-27T14:00:00Z',
  creditLimit: 500000, availableLimit: 400000, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pierre', externalId: 'ext-c1', role: 'member' }],
};

function tx(id: string, day: string, amount: number, description: string, installment: { number: number; total: number } | null = null, category: string | null = 'Compras'): CanonicalTransaction {
  return { id, accountId: 'c1', occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment, category, state: 'confirmed', sourceIds: ['pierre'], excluded: false };
}

function seeded(list: CanonicalTransaction[]) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  // Bills close on the 8th and are due on the 15th. August and September are paid; October closed on the 8th and was paid too.
  store.upsertSourceBills('pierre', ['2026-07', '2026-08', '2026-09', '2026-10'].map((m, i) => ({ externalId: `b${i}`, accountExternalId: 'ext-c1', dueDate: `${m}-15`, closingDate: `${m}-08`, total: 50000, minimumPayment: null })), NOW.toISOString());
  store.replaceCanonicalAccounts([card], [], NOW.toISOString());
  const payments = ['2026-07', '2026-08', '2026-09', '2026-10'].map((m) => tx(`pay-${m}`, `${m}-14`, 50000, 'Pagamento recebido', null, 'Pagamento de cartão de crédito'));
  store.replaceCanonicalTransactions([tx('start', '2026-06-01', -100, 'Coffee'), ...payments, ...list], [], NOW.toISOString());
  return store;
}

const series = (description: string, total: number, amount: number, charges: Array<[number, string]>) => charges.map(([n, day]) => tx(`${description}-${n}`, day, -amount, description, { number: n, total }));

test('each purchase lists its installments with the bill they are in and whether that bill is paid', () => {
  // 4 of 6 charged on the 14th of July, August, September and October (the October one is in the bill due in November).
  const store = seeded(series('Phone', 6, 10000, [[1, '2026-07-02'], [2, '2026-08-02'], [3, '2026-09-02'], [4, '2026-10-12']]));
  const v = installments(store, NOW);
  assert.equal(v.purchases.length, 1);
  const p = v.purchases[0]!;
  assert.deepEqual(p.slots.map((s) => [s.number, s.cycle, s.status, s.inferred]), [
    [1, '2026-07', 'paid', false],
    [2, '2026-08', 'paid', false],
    [3, '2026-09', 'paid', false],
    [4, '2026-11', 'open', false],
    [5, '2026-12', 'future', true],
    [6, '2027-01', 'future', true],
  ]);
  assert.deepEqual([p.paid, p.billed, p.open, p.future, p.remaining, p.finished, p.lastCycle], [3, 0, 1, 2, 30000, false, '2027-01']);
  assert.equal(p.card, 'Bank A •••• 1234');
});

test('a number that was not seen between two charges is placed by counting months', () => {
  const store = seeded(series('Sofa', 5, 20000, [[1, '2026-07-02'], [3, '2026-09-02'], [4, '2026-10-12']]));
  const p = installments(store, NOW).purchases[0]!;
  const second = p.slots[1]!;
  assert.deepEqual([second.number, second.cycle, second.status, second.inferred], [2, '2026-08', 'paid', true]);
});

test('an installment before the first one we hold counts as paid', () => {
  const store = seeded(series('Bike', 12, 5000, [[10, '2026-08-02'], [11, '2026-09-02'], [12, '2026-10-02']]));
  const p = installments(store, NOW).purchases[0]!;
  assert.deepEqual(p.slots.slice(0, 3).map((s) => [s.status, s.inferred]), [['paid', true], ['paid', true], ['paid', true]]);
  assert.equal(p.finished, true);
});

test('finished purchases go last, and the totals count only what is still to be paid', () => {
  const store = seeded([
    ...series('Phone', 6, 10000, [[4, '2026-10-02']]),
    ...series('Bike', 12, 5000, [[12, '2026-10-02']]),
  ]);
  const v = installments(store, NOW);
  assert.deepEqual(v.purchases.map((p) => [p.description, p.finished]), [['Phone', false], ['Bike', true]]);
  assert.equal(v.remainingTotal, 20000);
  assert.equal(v.thisCycle, 10000);
});

test('months add up the installments of every purchase, split by status', () => {
  const store = seeded([...series('Phone', 6, 10000, [[3, '2026-09-02'], [4, '2026-10-12']]), ...series('Sofa', 3, 7000, [[2, '2026-09-02'], [3, '2026-10-12']])]);
  const v = installments(store, NOW);
  const nov = v.months.find((m) => m.cycle === '2026-11')!;
  assert.deepEqual([nov.open, nov.count], [17000, 2]);
  const dec = v.months.find((m) => m.cycle === '2026-12')!;
  assert.deepEqual([dec.future, dec.count], [10000, 1]);
  assert.equal(v.nextCycle, 10000);
});

test('hidden cards and purchases without an installment mark are not listed', () => {
  const store = seeded([...series('Phone', 6, 10000, [[4, '2026-10-12']]), tx('plain', '2026-10-10', -9999, 'Lunch')]);
  assert.equal(installments(store, NOW).purchases.length, 1);
  store.setAccountHidden('c1', true, NOW.toISOString());
  assert.equal(installments(store, NOW).purchases.length, 0);
});

test('installments whose description carries the number ("Store 5/6") are one purchase', () => {
  const store = seeded([tx('a', '2026-09-02', -99900, 'Jim.Com* Instituto 4/6', { number: 4, total: 6 }), tx('b', '2026-10-12', -99900, 'Jim.Com* Instituto 5/6', { number: 5, total: 6 })]);
  const v = installments(store, NOW);
  assert.equal(v.purchases.length, 1);
  assert.equal(v.purchases[0]!.description, 'Jim.Com* Instituto');
});
