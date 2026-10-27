import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { addDays, addMonthsToDay, cyclesFor, isCardPayment } from '../../src/api/cycles.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { cards } from '../../src/api/views.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

function account(id: string, overrides: Partial<CanonicalAccount> = {}): CanonicalAccount {
  return {
    id, institution: 'Bank A', kind: 'credit_card', name: `Card ${id}`, last4: id.slice(-4), balance: 28090, balanceSourceId: 'pierre',
    balanceAsOf: '2026-10-27T14:00:00Z', creditLimit: 500000, availableLimit: 400000, minimumPayment: null, dueDate: '2026-10-15', limitGroupId: null,
    refs: [{ sourceId: 'pierre', externalId: `ext-${id}`, role: 'member' }],
    ...overrides,
  };
}

function tx(id: string, accountId: string, day: string, amount: number, category: string | null = 'Compras'): CanonicalTransaction {
  return { id, accountId, occurredAt: `${day}T15:00:00Z`, amount, description: id, descriptionRaw: null, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pierre'], excluded: false };
}

function setup(options: { payments?: boolean } = {}) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills(
    'pierre',
    [
      { externalId: 'b-sep', accountExternalId: 'ext-card1', dueDate: '2026-09-15', closingDate: '2026-09-08', total: 80000, minimumPayment: null },
      { externalId: 'b-oct', accountExternalId: 'ext-card1', dueDate: '2026-10-15', closingDate: '2026-10-08', total: 68000, minimumPayment: null },
    ],
    NOW.toISOString(),
  );
  const card1 = account('card1');
  const list = [
    tx('buy-aug', 'card1', '2026-08-20', -50000),
    tx('buy-sep', 'card1', '2026-09-02', -80000),
    tx('buy-oct', 'card1', '2026-10-02', -68000),
    tx('buy-open', 'card1', '2026-10-10', -600),
    tx('refund-open', 'card1', '2026-10-12', 100),
  ];
  if (options.payments !== false) {
    list.push(tx('pay-sep', 'card1', '2026-09-15', 80000, 'Pagamento de cartão de crédito'));
    list.push(tx('pay-oct', 'card1', '2026-10-15', 68000, 'Pagamento de cartão de crédito'));
    // The same payment reported twice by another source counts once.
    list.push(tx('pay-oct-dup', 'card1', '2026-10-15', 68000, 'Credit card payment'));
  }
  store.replaceCanonicalAccounts([card1], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, [], NOW.toISOString());
  return { store, card1 };
}

test('helpers: month arithmetic keeps the day or clamps to the month end', () => {
  assert.equal(addMonthsToDay('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsToDay('2026-10-08', 1), '2026-11-08');
  assert.equal(addMonthsToDay('2026-01-15', -2), '2025-11-15');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(isCardPayment('Credit card payment'), true);
  assert.equal(isCardPayment('Pagamento de cartão de crédito'), true);
  assert.equal(isCardPayment('Compras'), false);
  assert.equal(isCardPayment(null), false);
});

test('cycles: paid bills, an open cycle after the last closing, and a payment reported twice counted once', () => {
  const { store, card1 } = setup();
  const cycles = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27');
  assert.deepEqual(cycles.map((c) => [c.key, c.status]), [['2026-09', 'paid'], ['2026-10', 'paid'], ['2026-11', 'open']]);
  const oct = cycles[1]!;
  assert.deepEqual([oct.from, oct.to, oct.dueDate, oct.billTotal, oct.charges, oct.paid, oct.outstanding], ['2026-09-09', '2026-10-08', '2026-10-15', 68000, 68000, 68000, 0]);
  const open = cycles[2]!;
  assert.deepEqual([open.from, open.to, open.dueDate, open.billTotal, open.charges, open.credits], ['2026-10-09', '2026-11-08', '2026-11-15', null, 600, 100]);
});

test('cycles: an unpaid bill is unpaid before the due date and overdue after it', () => {
  const { store, card1 } = setup({ payments: false });
  const txs = effectiveTransactions(store);
  assert.equal(cyclesFor(store, card1, txs, '2026-10-12')[1]!.status, 'unpaid');
  const late = cyclesFor(store, card1, txs, '2026-10-27')[1]!;
  assert.deepEqual([late.status, late.outstanding], ['overdue', 68000]);
});

test('cycles: a payment smaller than the bill leaves it partial', () => {
  const { store, card1 } = setup({ payments: false });
  store.replaceCanonicalTransactions(
    [tx('buy-oct', 'card1', '2026-10-02', -68000), tx('part', 'card1', '2026-10-14', 20000, 'Pagamento de cartão de crédito')],
    [],
    NOW.toISOString(),
  );
  const oct = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-14')[1]!;
  assert.deepEqual([oct.status, oct.paid, oct.outstanding], ['partial', 20000, 48000]);
});

test('cycles: a card without bills has no cycles', () => {
  const { store } = setup();
  assert.deepEqual(cyclesFor(store, account('other', { refs: [{ sourceId: 'pierre', externalId: 'none', role: 'member' }] }), [], '2026-10-27'), []);
});

test('cards view: the open cycle is the default and ignores bills that were already paid', () => {
  const { store } = setup();
  const v = cards(store, NOW);
  assert.equal(v.cycle, 'open');
  assert.deepEqual(v.cycles, ['2026-10', '2026-09']);
  const row = v.cards[0]!;
  assert.deepEqual([row.cycle?.key, row.posted, row.estimated, row.total, row.outstanding], ['2026-11', 500, true, 28090, 0]);
  assert.equal(v.totals.cycleTotal, 28090);
  assert.equal(v.totals.outstanding, 0);
  assert.equal(row.nextDueDate, '2026-11-15');
});

test('cards view: choosing a closed cycle shows its bill', () => {
  const { store } = setup();
  const v = cards(store, NOW, {}, '2026-10');
  assert.deepEqual([v.cards[0]!.cycle?.key, v.cards[0]!.total, v.totals.cycleTotal], ['2026-10', 68000, 68000]);
});

test('cards view: an unpaid closed bill is outstanding, due first, and not mixed into the open cycle', () => {
  const { store } = setup({ payments: false });
  const v = cards(store, NOW);
  const row = v.cards[0]!;
  assert.deepEqual([row.outstanding, row.nextDueDate], [148000, '2026-09-15']);
  assert.equal(row.total, Math.max(28090 - 148000, 500));
  assert.equal(v.totals.outstanding, 148000);
});

test('cards view: cards on a shared limit count the open cycle once', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const a = account('cardA', { balance: 335600, limitGroupId: 'g1', refs: [] });
  const b = account('cardB', { balance: 335600, limitGroupId: 'g1', refs: [] });
  store.replaceCanonicalAccounts([a, b], [{ id: 'g1', institution: 'Bank A', creditLimit: 500000, memberIds: ['cardA', 'cardB'] }], NOW.toISOString());
  const v = cards(store, NOW);
  assert.equal(v.cards.length, 2);
  assert.equal(v.totals.reportedByIssuer, 335600);
  assert.equal(v.limitGroups[0]!.openEstimate, 335600);
});

test('hidden cards drop out of the totals and the limit', () => {
  const { store } = setup();
  store.setAccountHidden('card1', true, NOW.toISOString());
  const v = cards(store, NOW);
  assert.equal(v.cards.length, 0);
  assert.deepEqual([v.totals.cycleTotal, v.totals.creditLimit, v.totals.used], [0, 0, 0]);
  assert.equal(cards(store, NOW, { includeHidden: true }).cards.length, 1);
});
