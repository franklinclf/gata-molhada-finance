import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { forecast } from '../../src/api/forecast.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-28T15:00:00Z');

const card: CanonicalAccount = {
  id: 'c1', institution: 'Bank', kind: 'credit_card', name: 'Card', last4: '1234', balance: 60000, balanceSourceId: 'pierre', balanceAsOf: NOW.toISOString(),
  creditLimit: 500000, availableLimit: 400000, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pierre', externalId: 'ext-c1', role: 'member' }],
};

const tx = (id: string, day: string, amount: number, description: string, installment: { number: number; total: number } | null = null, category: string | null = null): CanonicalTransaction => ({
  id, accountId: 'c1', occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment, category, state: 'confirmed', sourceIds: ['pierre'], excluded: false,
});

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  // Bills close on the 8th and are due on the 15th, each one 500,00.
  store.upsertSourceBills('pierre', ['2026-07', '2026-08', '2026-09', '2026-10'].map((m, i) => ({ externalId: `b${i}`, accountExternalId: 'ext-c1', dueDate: `${m}-15`, closingDate: `${m}-08`, total: 50000, minimumPayment: null })), NOW.toISOString());
  const list: CanonicalTransaction[] = [tx('start', '2026-05-20', -100, 'Coffee')];
  ['06-20', '07-20', '08-20', '09-20', '10-20'].forEach((d, i) => list.push(tx(`netflix-${i}`, `2026-${d}`, -3990, 'NETFLIX.COM')));
  ['06-20', '07-20', '08-20', '09-20'].forEach((d, i) => list.push(tx(`phone-${i + 1}`, `2026-${d}`, -10000, 'Phone', { number: i + 1, total: 6 })));
  for (const m of ['07', '08', '09', '10']) list.push(tx(`pay-${m}`, `2026-${m}-14`, 50000, 'Pagamento recebido', null, 'Credit card payment'));
  store.replaceCanonicalAccounts([card], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, [], NOW.toISOString());
  return store;
}

test('the forecast splits each coming bill into installments, repeating charges and the usual spending', () => {
  const v = forecast(seeded(), NOW);
  assert.deepEqual(v.months.map((m) => m.key), ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
  // certain = installments + repeating charges; estimated adds the average of the usual spending.
  assert.deepEqual(v.months.slice(0, 3).map((m) => [m.installments, m.recurring, m.variable, m.certain, m.estimated]), [
    // The open bill already holds 500,00 by the issuer's balance, which is above installments plus repeating charges.
    [10000, 3990, 36010, 50000, 50000],
    [10000, 3990, 36010, 13990, 50000],
    [0, 3990, 36010, 3990, 40000],
  ]);
  assert.equal(v.months[0]!.open, true);
  assert.equal(v.months[1]!.open, false);
  assert.deepEqual(v.recurring.map((r) => [r.description, r.amount]), [['NETFLIX.COM', 3990]]);
  assert.deepEqual(v.basis, [{ card: 'Bank 1234', bills: 3, average: 36010 }]);
});

test('the open bill is never forecast below what it already holds', () => {
  const store = seeded();
  store.replaceCanonicalTransactions([...store.listCanonicalTransactions(), tx('big', '2026-10-25', -90000, 'Big purchase')], [], NOW.toISOString());
  store.replaceCanonicalAccounts([{ ...card, balance: 200000 }], [], NOW.toISOString());
  const open = forecast(store, NOW).months[0]!;
  assert.ok(open.known >= 90000);
  assert.ok(open.estimated >= open.known);
  assert.ok(open.certain >= open.known, 'the sure part of the open bill is never below what it already holds');
});

test('a card whose bill for the first month is already published uses that bill instead of an estimate', () => {
  const store = seeded();
  // A second card closes on the 25th and is due on the 5th: on the 28th its November bill is closed and published, while the first card still has November open.
  const other: CanonicalAccount = { ...card, id: 'c2', name: 'Other', last4: '5678', refs: [{ sourceId: 'pierre', externalId: 'ext-c2', role: 'member' }] };
  store.upsertSourceBills('pierre', [
    { externalId: 'o1', accountExternalId: 'ext-c2', dueDate: '2026-10-05', closingDate: '2026-09-25', total: 15000, minimumPayment: null },
    { externalId: 'o2', accountExternalId: 'ext-c2', dueDate: '2026-11-05', closingDate: '2026-10-25', total: 20000, minimumPayment: null },
  ], NOW.toISOString());
  store.replaceCanonicalAccounts([card, other], [], NOW.toISOString());
  const v = forecast(store, NOW);
  const november = v.months[0]!;
  assert.equal(november.key, '2026-11');
  const closed = november.cards.find((c) => c.id === 'c2')!;
  assert.deepEqual([closed.state, closed.certain, closed.estimated, closed.recurring, closed.variable], ['closed', 20000, 20000, 0, 0]);
  assert.equal(november.cards.find((c) => c.id === 'c1')!.state, 'open');
  assert.equal(november.open, true, 'the month still has an open bill');
  assert.equal(november.certain, november.cards.reduce((s, c) => s + c.certain, 0));
  assert.ok(november.known >= 20000);
  // December is the open month of the second card: estimated from its own history, not from the published bill.
  assert.equal(v.months[1]!.cards.find((c) => c.id === 'c2')!.state, 'open');
});

test('a charge that appears in fewer than three months, or changes amount, is not treated as repeating', () => {
  const store = seeded();
  store.replaceCanonicalTransactions(
    [
      ...store.listCanonicalTransactions().filter((t) => !t.id.startsWith('netflix')),
      tx('a1', '2026-07-20', -2000, 'GYM'), tx('a2', '2026-08-20', -2000, 'GYM'),
      tx('b1', '2026-07-21', -2000, 'POWER'), tx('b2', '2026-08-21', -3500, 'POWER'), tx('b3', '2026-09-21', -9000, 'POWER'),
    ],
    [],
    NOW.toISOString(),
  );
  assert.deepEqual(forecast(store, NOW).recurring, []);
});

test('the forecast answers over the API and skips hidden cards', () => {
  const store = seeded();
  const res = apiRoute('GET', '/api/cards/forecast', new URLSearchParams(), store, NOW);
  assert.equal(res?.status, 200);
  assert.equal((res?.body as { months: unknown[] }).months.length, 6);
  store.setAccountHidden('c1', true, NOW.toISOString());
  assert.deepEqual(forecast(store, NOW).months.map((m) => m.estimated), [0, 0, 0, 0, 0, 0]);
});
