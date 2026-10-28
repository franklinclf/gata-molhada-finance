import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { proveByBills } from '../../src/reconcile/bill-proof.ts';
import { cards } from '../../src/api/views.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-28T15:00:00Z');

const card: CanonicalAccount = {
  id: 'c1', institution: 'Bank', kind: 'credit_card', name: 'Card', last4: '4014', balance: 30943, balanceSourceId: 'pierre', balanceAsOf: NOW.toISOString(),
  creditLimit: 150000, availableLimit: 119057, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pierre', externalId: 'ext-c1', role: 'member' }],
};

const tx = (id: string, day: string, amount: number, description: string, state: CanonicalTransaction['state'] = 'single_source', category: string | null = null): CanonicalTransaction => ({
  id, accountId: 'c1', occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: state === 'stale_pending' ? 'pending' : 'posted', installment: null, category, state, sourceIds: ['pluggy'], excluded: state === 'stale_pending',
});

function setup(list: CanonicalTransaction[], bills: Array<{ due: string; closing: string; total: number }>) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pierre', bills.map((b, i) => ({ externalId: `b${i}`, accountExternalId: 'ext-c1', dueDate: b.due, closingDate: b.closing, total: b.total, minimumPayment: null })), NOW.toISOString());
  store.replaceCanonicalAccounts([card], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, [], NOW.toISOString());
  return store;
}

const state = (store: ReturnType<typeof setup>, id: string) => store.listCanonicalTransactions({ includeExcluded: true }).find((t) => t.id === id)!;

// Bills close on the 1st and are due on the 15th. The September cycle (Aug 2 to Sep 1 is the earlier bill; Sep 2 to Oct 1 is the October bill).
const BILLS = [
  { due: '2026-09-15', closing: '2026-09-01', total: 3991 },
  { due: '2026-10-15', closing: '2026-10-01', total: 22128 },
];

test('set-aside pending charges that add up exactly to the missing part of a closed bill are restored', () => {
  const store = setup(
    [
      tx('start', '2026-08-05', -100, 'Coffee'),
      tx('pay-sep', '2026-09-14', 3991, 'Pagamento recebido', 'confirmed', 'Credit card payment'),
      tx('tiktok', '2026-09-05', -6463, 'EBN*TikTok Shop', 'stale_pending'),
      tx('pharmacy', '2026-09-05', -4879, 'Farmacia', 'stale_pending'),
      tx('market', '2026-09-09', -2124, 'Amazon Marketplace', 'stale_pending'),
      tx('music', '2026-09-17', -2390, 'Spotify', 'stale_pending'),
      tx('food', '2026-09-17', -1350, 'iFood Club', 'stale_pending'),
      tx('prime', '2026-09-18', -1390, 'Amazon Prime', 'stale_pending'),
      tx('books', '2026-09-23', -3532, 'Amazon BR', 'stale_pending'),
      tx('pay-oct', '2026-10-15', 22128, 'Pagamento recebido', 'confirmed', 'Credit card payment'),
    ],
    BILLS,
  );
  const ids = proveByBills(store, NOW);
  assert.equal(ids.length, 7);
  assert.ok(['tiktok', 'pharmacy', 'market', 'music', 'food', 'prime', 'books'].every((id) => state(store, id).state === 'billed' && !state(store, id).excluded));
});

test('a charge that repeats a month later after a proven one is restored, including in the open cycle', () => {
  const store = setup(
    [
      tx('start', '2026-08-05', -100, 'Coffee'),
      tx('tiktok-sep', '2026-09-05', -6463, 'EBN*TikTok Shop', 'stale_pending'),
      tx('tiktok-oct', '2026-10-05', -6463, 'EBN*TikTok Shop', 'stale_pending'),
      tx('stranger', '2026-10-06', -7777, 'Unknown thing', 'stale_pending'),
      tx('pay-oct', '2026-10-15', 6463, 'Pagamento recebido', 'confirmed', 'Credit card payment'),
    ],
    [{ due: '2026-09-15', closing: '2026-09-01', total: 100 }, { due: '2026-10-15', closing: '2026-10-01', total: 6463 }],
  );
  const ids = proveByBills(store, NOW);
  assert.deepEqual(ids.sort(), ['tiktok-oct', 'tiktok-sep']);
  assert.equal(state(store, 'stranger').state, 'stale_pending');
  assert.equal(state(store, 'stranger').excluded, true);
});

test('nothing is restored when the pieces do not add up, when several combinations fit, or when the bill is already explained', () => {
  const base = [tx('start', '2026-08-05', -100, 'Coffee'), tx('pay', '2026-10-15', 22128, 'Pagamento recebido', 'confirmed', 'Credit card payment')];
  const noMatch = setup([...base, tx('a', '2026-09-05', -5000, 'A', 'stale_pending'), tx('b', '2026-09-06', -6000, 'B', 'stale_pending')], BILLS);
  assert.deepEqual(proveByBills(noMatch, NOW), []);

  // 22.128 can be made several ways (10.000 + 12.128, 5.000 + 5.000 + 12.128, 5.000 + 17.128), so nothing is proven.
  const ambiguous = setup(
    [...base, tx('a', '2026-09-05', -10000, 'A', 'stale_pending'), tx('b', '2026-09-06', -5000, 'B', 'stale_pending'), tx('c', '2026-09-07', -5000, 'C', 'stale_pending'), tx('d', '2026-09-08', -12128, 'D', 'stale_pending'), tx('e', '2026-09-09', -17128, 'E', 'stale_pending')],
    BILLS,
  );
  assert.deepEqual(proveByBills(ambiguous, NOW), []);

  const explained = setup([...base, tx('buy', '2026-09-10', -22128, 'Big purchase', 'confirmed'), tx('ghost', '2026-09-12', -3000, 'Ghost', 'stale_pending')], BILLS);
  assert.deepEqual(proveByBills(explained, NOW), []);
});

test('restored charges count in the cycle, and a bill that was explained by them is no longer short', () => {
  const store = setup(
    [
      tx('start', '2026-08-05', -100, 'Coffee'),
      tx('a', '2026-09-05', -22128, 'Split bill', 'stale_pending'),
      tx('pay', '2026-10-15', 22128, 'Pagamento recebido', 'confirmed', 'Credit card payment'),
    ],
    BILLS,
  );
  const before = cards(store, NOW, {}, '2026-10').cards[0]!;
  assert.equal(before.posted, 0);
  proveByBills(store, NOW);
  assert.equal(cards(store, NOW, {}, '2026-10').cards[0]!.posted, 22128);
});

test('hidden transactions that are not pending set-asides, and non-card accounts, are left alone', () => {
  const store = setup([tx('start', '2026-08-05', -100, 'Coffee'), tx('ignored', '2026-09-05', -22128, 'X', 'ignored')], BILLS);
  assert.deepEqual(proveByBills(store, NOW), []);
});

test('the Amazon card case: the open bill is the issuer balance minus installments of later bills, once the installments are known', () => {
  const list = [
    tx('start', '2026-08-05', -100, 'Coffee'),
    tx('pay-sep', '2026-09-14', 3991, 'Pagamento recebido', 'confirmed', 'Credit card payment'),
    tx('tiktok-sep', '2026-09-05', -6463, 'EBN*TikTok Shop', 'stale_pending'),
    tx('pharmacy', '2026-09-05', -4879, 'Farmacia', 'stale_pending'),
    tx('market-sep', '2026-09-09', -2124, 'Amazon Marketplace', 'stale_pending'),
    tx('music', '2026-09-17', -2390, 'Spotify', 'stale_pending'),
    tx('food-sep', '2026-09-17', -1350, 'iFood Club', 'stale_pending'),
    tx('prime-sep', '2026-09-18', -1390, 'Amazon Prime', 'stale_pending'),
    tx('books', '2026-09-23', -3532, 'Amazon BR', 'stale_pending'),
    tx('pay-oct', '2026-10-15', 22128, 'Pagamento recebido', 'confirmed', 'Credit card payment'),
    tx('tiktok-oct', '2026-10-05', -6463, 'EBN*TikTok Shop', 'stale_pending'),
    tx('market-oct', '2026-10-09', -2124, 'Amazon Marketplace', 'stale_pending'),
    tx('prime-oct', '2026-10-17', -1390, 'Amazon Prime', 'stale_pending'),
    tx('food-oct', '2026-10-17', -1350, 'iFood Club', 'confirmed'),
  ];
  const store = setup(list, BILLS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), NOW.toISOString());
  proveByBills(store, NOW);

  // The statement says: TikTok 3 of 3, Amazon Prime 4 of 12, Marketplace 7 of 11.
  store.setInstallmentOverride('tiktok-oct', { number: 3, total: 3 }, NOW.toISOString());
  store.setInstallmentOverride('prime-oct', { number: 4, total: 12 }, NOW.toISOString());
  store.setInstallmentOverride('market-oct', { number: 7, total: 11 }, NOW.toISOString());

  const row = cards(store, NOW).cards[0]!;
  // 13,50 iFood + 64,63 + 13,90 + 21,24 = 113,27, and 8 x 13,90 + 4 x 21,24 = 196,16 still to come.
  assert.deepEqual([row.futureInstallments, row.posted, row.total], [19616, 11327, 11327]);
  assert.equal(row.balance, 30943);
});
