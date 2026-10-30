import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { billCheck } from '../../src/api/bill-check.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

const card: CanonicalAccount = {
  id: 'card1', institution: 'Bank A', kind: 'credit_card', name: 'Card', last4: '0576', balance: 0, balanceSourceId: 'pluggy', balanceAsOf: NOW.toISOString(), creditLimit: 500000,
  availableLimit: 400000, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pluggy', externalId: 'ext-card1', role: 'member' }],
};
const tx = (id: string, day: string, amount: number, over: Partial<CanonicalTransaction> = {}): CanonicalTransaction => ({
  id, accountId: 'card1', occurredAt: `${day}T15:00:00Z`, amount, description: id, descriptionRaw: null, status: 'posted', installment: null, category: 'Compras', state: 'confirmed', sourceIds: ['pluggy'], excluded: false, ...over,
});

function setup(bills: Array<[string, string, string, number]>, list: CanonicalTransaction[]) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', bills.map(([externalId, dueDate, closingDate, total]) => ({ externalId, accountExternalId: 'ext-card1', dueDate, closingDate, total, minimumPayment: null })), NOW.toISOString());
  store.replaceCanonicalAccounts([card], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), NOW.toISOString());
  return store;
}

const BILLS: Array<[string, string, string, number]> = [
  ['b-aug', '2026-08-15', '2026-08-08', 50000],
  ['b-sep', '2026-09-15', '2026-09-08', 80000],
  ['b-oct', '2026-10-15', '2026-10-08', 68000],
];

test('a charge at the edge of a closing that fixes both bills is offered as one move, not twice', () => {
  const store = setup(BILLS, [
    tx('start', '2026-07-01', -100),
    tx('aug', '2026-07-20', -50000),
    tx('sep', '2026-09-02', -80000),
    // Two Uber rides on the closing day, billed in October by the bank.
    tx('uber1', '2026-09-08', -358),
    tx('uber2', '2026-09-08', -438),
    tx('oct', '2026-10-02', -67204),
  ]);
  const { items } = billCheck(store, NOW);
  assert.equal(items.length, 1, 'the October side is explained by the same move');
  const item = items[0]!;
  assert.equal(item.cycleKey, '2026-09');
  assert.equal(item.gap, 796);
  assert.equal(item.suggestion.kind, 'move');
  if (item.suggestion.kind === 'move') {
    assert.deepEqual(item.suggestion.moves.map((m) => [m.description, m.toCycleKey]).sort(), [['uber1', '2026-10'], ['uber2', '2026-10']]);
  }
});

test('a bill larger than its charges, with nothing near a closing to explain it, is reported as missing', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('aug', '2026-07-20', -50000), tx('sep', '2026-09-02', -80000), tx('oct', '2026-10-02', -60000)]);
  const item = billCheck(store, NOW).items[0]!;
  assert.deepEqual([item.cycleKey, item.gap, item.suggestion], ['2026-10', -8000, { kind: 'missing', amount: 8000 }]);
});

test('a bill smaller than its charges, with no edge charge that explains it, is reported as extra', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('aug', '2026-07-20', -50000), tx('sep', '2026-09-02', -80000), tx('oct', '2026-10-02', -69500)]);
  const item = billCheck(store, NOW).items[0]!;
  assert.deepEqual([item.cycleKey, item.gap, item.suggestion], ['2026-10', 1500, { kind: 'extra', amount: 1500 }]);
});

test('a charge already moved by the owner is not offered again, and bills that match produce nothing', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('aug', '2026-07-20', -50000), tx('sep', '2026-09-02', -80000), tx('oct', '2026-10-02', -68000)]);
  assert.deepEqual(billCheck(store, NOW).items, []);
});

test('pending entries set aside as stale are listed so the owner can look at them', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('old', '2026-09-20', -2000, { status: 'pending', state: 'stale_pending', excluded: true })]);
  const { setAside } = billCheck(store, NOW);
  assert.deepEqual(setAside.map((t) => [t.description, t.amount]), [['old', -2000]]);
});
