import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { billCheck, setBillCheckDismissed } from '../../src/api/bill-check.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

const card: CanonicalAccount = {
  id: 'card1', institution: 'Bank A', kind: 'credit_card', name: 'Card', last4: '0101', balance: 0, balanceSourceId: 'pluggy', balanceAsOf: NOW.toISOString(), creditLimit: 500000,
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

test('among several groups of the same size that add up, the one nearest the closing day is offered', () => {
  const store = setup(BILLS, [
    tx('start', '2026-07-01', -100),
    tx('aug', '2026-07-20', -50000),
    tx('sep', '2026-09-02', -79204),
    // Two charges of 796: one three days before the closing, one on the closing day itself.
    tx('early', '2026-09-05', -796),
    tx('late', '2026-09-08', -796),
    tx('oct', '2026-10-02', -67204),
  ]);
  const item = billCheck(store, NOW).items[0]!;
  assert.equal(item.suggestion.kind, 'move');
  if (item.suggestion.kind === 'move') assert.deepEqual(item.suggestion.moves.map((m) => m.description), ['late']);
});

test('a charge is never pulled out of a neighbour bill that is itself short', () => {
  // October's bill is 1500 larger than its charges, and September's is also short: September has nothing to give.
  const store = setup(BILLS, [
    tx('start', '2026-07-01', -100),
    tx('aug', '2026-07-20', -50000),
    tx('sep', '2026-09-02', -79000),
    tx('edge', '2026-09-08', -1000),
    tx('oct', '2026-10-02', -66500),
  ]);
  const octItem = billCheck(store, NOW).items.find((i) => i.cycleKey === '2026-10')!;
  assert.deepEqual(octItem.suggestion, { kind: 'missing', amount: 1500 });
});

test('a card payment listed twice with two texts, or as a pending and a posted copy, is offered for cleaning, and two real payments are not', () => {
  const pay = (id: string, day: string, description: string, over: Partial<CanonicalTransaction> = {}) => ({ ...tx(id, day, 50000, over), description, category: 'Pagamento de fatura' });
  const store = setup(BILLS, [
    tx('start', '2026-07-01', -100),
    pay('p1', '2026-10-15', 'Pagamento recebido', { status: 'pending' }),
    pay('p2', '2026-10-15', 'PAGTO. POR DEB EM C/C', { status: 'pending' }),
    pay('q1', '2026-09-14', 'Pagamento recebido'),
    pay('q2', '2026-09-14', 'Pagamento recebido'),
  ]);
  const { duplicatePayments } = billCheck(store, NOW);
  assert.equal(duplicatePayments.length, 1, 'only the pair with different texts; two equal real payments are left alone');
  assert.deepEqual(duplicatePayments[0]!.members.map((m) => m.description), ['Pagamento recebido', 'PAGTO. POR DEB EM C/C']);
});

test('a gap equal to an installment the bank never listed, placed by the app in the next bill, says so', () => {
  const phone = (id: string, day: string, number: number) => tx(id, day, -1000, { description: 'Phone', installment: { number, total: 6 } });
  // Installment 2 never came. The app counts it in September, but the bank billed it in October.
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('aug', '2026-07-20', -49000), phone('p1', '2026-07-25', 1), tx('sep', '2026-09-02', -80000), tx('oct', '2026-10-02', -66000), phone('p3', '2026-10-03', 3)]);
  const items = billCheck(store, NOW).items;
  const oct = items.find((i) => i.cycleKey === '2026-10')!;
  assert.equal(oct.suggestion.kind, 'missing');
  const unlisted = oct.suggestion.kind === 'missing' ? oct.suggestion.unlisted : undefined;
  assert.deepEqual(unlisted?.map((u) => [u.description, u.number, u.total, u.amount, u.cycleKey]), [['Phone', 2, 6, 1000, '2026-09']]);
  assert.equal(items.find((i) => i.cycleKey === '2026-09')?.suggestion.kind, 'extra');
});

test('a missing amount that matches no installment has no unlisted hint', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('aug', '2026-07-20', -50000), tx('sep', '2026-09-02', -80000), tx('oct', '2026-10-02', -60000)]);
  const s = billCheck(store, NOW).items[0]!.suggestion;
  assert.equal('unlisted' in s, false);
});

test('a hidden card does not show up in the check', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('aug', '2026-07-20', -50000), tx('sep', '2026-09-02', -80000), tx('oct', '2026-10-02', -60000)]);
  assert.equal(billCheck(store, NOW).items.length, 1);
  store.setAccountHidden('card1', true, NOW.toISOString());
  const view = billCheck(store, NOW);
  assert.deepEqual([view.items, view.duplicatePayments, view.setAside], [[], [], []]);
});

const pay = (id: string, day: string, amount: number) => ({ ...tx(id, day, amount), category: 'Pagamento de fatura' });

test('a bill that starts before DATA_START is not judged, because its purchases were deleted', () => {
  const store = setup(
    [
      ['b-dec', '2025-12-15', '2025-12-08', 50000],
      ['b-jan', '2026-01-15', '2026-01-08', 60000],
      ['b-feb', '2026-02-15', '2026-02-08', 70000],
    ],
    [tx('start', '2025-11-01', -100), tx('dec', '2025-11-20', -40000), tx('jan', '2025-12-20', -50000), tx('feb', '2026-01-20', -60000)],
  );
  // December and January are short by 10000 each, but their cycles start before 2026-01-01. Only February (from 2026-01-09) counts.
  assert.deepEqual(billCheck(store, NOW).items.map((i) => [i.cycleKey, i.gap]), [['2026-02', -10000]]);
});

test('a gap equal to what the owner ignored is said so, with the records to put back, even in a cycle before DATA_START', () => {
  const bills: Array<[string, string, string, number]> = [['b-jan', '2026-01-15', '2026-01-08', 60000], ['b-feb', '2026-02-15', '2026-02-08', 70000]];
  const store = setup(bills, [
    tx('start', '2025-11-01', -100),
    // A charge of 1754 that the owner ignored, and its refund, which is still counted: the bank bills both.
    tx('gone', '2025-12-30', -1754, { state: 'ignored', excluded: true }),
    tx('refund', '2026-01-05', 1754),
    tx('jan', '2025-12-20', -60000),
    tx('feb', '2026-01-20', -70000),
  ]);
  const [item, ...rest] = billCheck(store, NOW).items;
  assert.equal(rest.length, 0);
  assert.deepEqual([item!.cycleKey, item!.gap], ['2026-01', -1754]);
  assert.deepEqual(item!.suggestion, { kind: 'ignored', amount: 1754, records: [{ transactionId: 'gone', day: '2025-12-30', amount: -1754, description: 'gone' }] });
  assert.equal(item!.old, false, 'a record to put back is shown whatever the age');
});

test('an ignored record that does not add up to the gap is left out of the suggestion', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('aug', '2026-07-20', -50000), tx('sep', '2026-09-02', -80000), tx('oct', '2026-10-02', -60000), tx('gone', '2026-10-03', -500, { state: 'ignored', excluded: true })]);
  assert.deepEqual(billCheck(store, NOW).items[0]!.suggestion, { kind: 'missing', amount: 8000 });
});

test('consecutive bills with no purchases from the bank are one run, and a bill with purchases stays on its own', () => {
  const bills: Array<[string, string, string, number]> = [
    ['b-jun', '2026-06-15', '2026-06-08', 30000],
    ['b-jul', '2026-07-15', '2026-07-08', 40000],
    ['b-aug', '2026-08-15', '2026-08-08', 50000],
    ['b-sep', '2026-09-15', '2026-09-08', 60000],
    ['b-oct', '2026-10-15', '2026-10-08', 70000],
  ];
  // June has purchases and a gap of its own; July to October have none at all.
  const store = setup(bills, [tx('start', '2026-04-01', -100), tx('jun', '2026-05-20', -25000)]);
  const view = billCheck(store, NOW);
  assert.deepEqual(view.items.map((i) => [i.cycleKey, i.noPurchases]), [['2026-06', false]]);
  assert.equal(view.runs.length, 1);
  const run = view.runs[0]!;
  assert.deepEqual([run.fromKey, run.toKey, run.billTotal, run.ours, run.gap], ['2026-07', '2026-10', 220000, 0, -220000]);
  assert.deepEqual(run.bills.map((b) => b.cycleKey), ['2026-10', '2026-09', '2026-08', '2026-07'], 'newest first');
});

test('one bill with no purchases next to a bill with purchases is not a run', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('aug', '2026-07-20', -50000), tx('sep', '2026-09-02', -70000)]);
  const view = billCheck(store, NOW);
  assert.deepEqual(view.runs, []);
  assert.deepEqual(view.items.map((i) => [i.cycleKey, i.noPurchases]), [['2026-10', true], ['2026-09', false]]);
});

test('a paid bill from long ago is marked old, a recent or unpaid one is not', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100), tx('aug', '2026-07-20', -49000), tx('sep', '2026-09-02', -79000), pay('p-aug', '2026-08-15', 50000), pay('p-sep', '2026-09-15', 80000)]);
  const byKey = new Map(billCheck(store, NOW).items.map((i) => [i.cycleKey, i]));
  assert.equal(byKey.get('2026-08')?.old, true, 'paid and due 73 days ago');
  assert.equal(byKey.get('2026-09')?.old, false, 'paid but due 42 days ago');
  assert.equal(byKey.get('2026-10')?.old, false, 'not paid');
});

test('a dismissed bill leaves the check, comes back on request, and a run keeps only the bills that were not dismissed', () => {
  const bills: Array<[string, string, string, number]> = [
    ['b-aug', '2026-08-15', '2026-08-08', 50000],
    ['b-sep', '2026-09-15', '2026-09-08', 60000],
    ['b-oct', '2026-10-15', '2026-10-08', 70000],
  ];
  const store = setup(bills, [tx('start', '2026-06-01', -100)]);
  assert.equal(billCheck(store, NOW).runs[0]!.bills.length, 3);
  assert.deepEqual(setBillCheckDismissed(store, [{ accountId: 'card1', cycleKey: '2026-09' }], true, NOW), { ok: true });
  const after = billCheck(store, NOW);
  assert.deepEqual(after.dismissed.map((i) => i.cycleKey), ['2026-09']);
  assert.deepEqual(after.runs, [], 'the two bills left are no longer next to each other');
  assert.deepEqual(after.items.map((i) => i.cycleKey), ['2026-10', '2026-08']);
  setBillCheckDismissed(store, [{ accountId: 'card1', cycleKey: '2026-09' }], false, NOW);
  assert.deepEqual(billCheck(store, NOW).dismissed, []);
  assert.equal(billCheck(store, NOW).runs[0]!.bills.length, 3);
});

test('dismissing needs a card, a month and a yes or no', () => {
  const store = setup(BILLS, [tx('start', '2026-07-01', -100)]);
  const bad = (bills: unknown, dismissed: unknown) => setBillCheckDismissed(store, bills, dismissed, NOW);
  assert.deepEqual(bad([{ accountId: 'card1', cycleKey: '2026-09' }], 'yes'), { ok: false, status: 400, error: 'dismissed must be true or false' });
  assert.equal(bad([], true).ok, false);
  assert.equal(bad([{ accountId: 'card1', cycleKey: 'sep' }], true).ok, false);
  assert.deepEqual(bad([{ accountId: 'nope', cycleKey: '2026-09' }], true), { ok: false, status: 404, error: 'not_found' });
});
