import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { addAsset, deleteAsset, netWorth, setAssetValue, updateAsset, valueOn } from '../../src/api/networth.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-15T15:00:00Z');
const T = NOW.toISOString();

const account = (id: string, kind: CanonicalAccount['kind'], balance: number): CanonicalAccount => ({
  id, institution: 'Bank', kind, name: id, last4: null, balance, balanceSourceId: 'pluggy', balanceAsOf: T, creditLimit: kind === 'credit_card' ? 1_000_000 : null,
  availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [],
});
const tx = (id: string, accountId: string, day: string, amount: number): CanonicalTransaction => ({
  id, accountId, occurredAt: `${day}T15:00:00Z`, amount, description: id, descriptionRaw: null, status: 'posted', installment: null, category: 'X', state: 'confirmed', sourceIds: ['pluggy'], excluded: false,
});

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  // Today: 1.000 in the bank. In October 300 came in and 100 went out; in September 200 went out. The card owes 400 now: a 500 purchase in October and a 100 payment.
  store.replaceCanonicalAccounts([account('chk', 'checking', 100000), account('card', 'credit_card', 40000)], [], T);
  const list = [tx('in', 'chk', '2026-10-05', 30000), tx('out', 'chk', '2026-10-10', -10000), tx('sep', 'chk', '2026-09-10', -20000), tx('buy', 'card', '2026-10-02', -50000), tx('pay', 'card', '2026-10-12', 10000)];
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), T);
  return store;
}

test('today is the sum of the bank balances minus what the cards owe', () => {
  const view = netWorth(seeded(), NOW);
  assert.deepEqual([view.assets, view.liabilities, view.net], [100000, 40000, 60000]);
});

test('earlier month ends undo the later transactions', () => {
  const view = netWorth(seeded(), NOW);
  const at = (day: string) => view.history.find((p) => p.day === day)!;
  // End of September: bank = 1.000 - (300 - 100) = 800; the card had no debt yet (the 500 purchase and the 100 payment came after).
  assert.deepEqual([at('2026-09-30').assets, at('2026-09-30').liabilities], [80000, 0]);
  // End of August: bank = 800 + 200 = 1.000 (the 200 spent in September is undone).
  assert.equal(at('2026-08-31')?.assets, undefined, 'no month before the first transaction');
  assert.equal(view.history.at(-1)?.day, '2026-10-15');
  assert.deepEqual([view.history.at(-1)?.assets, view.history.at(-1)?.liabilities], [100000, 40000]);
});

test('manual assets count from their first value and a debt counts as a liability', () => {
  const store = seeded();
  const car = addAsset(store, { name: 'Carro', kind: 'asset', value: 5_000_000, day: '2026-09-20' }, NOW);
  const loan = addAsset(store, { name: 'Financiamento', kind: 'liability', value: 2_000_000, day: '2026-10-01' }, NOW);
  assert.ok(car.ok && loan.ok);
  const view = netWorth(store, NOW);
  assert.deepEqual([view.assets, view.liabilities, view.net], [5_100_000, 2_040_000, 3_060_000]);
  const sep = view.history.find((p) => p.day === '2026-09-30')!;
  assert.deepEqual([sep.assets, sep.liabilities], [80000 + 5_000_000, 0], 'the loan has no value in September yet');
  if (car.ok) {
    setAssetValue(store, car.value.id, { day: '2026-10-10', value: 4_800_000 }, NOW);
    assert.equal(netWorth(store, NOW).assets, 4_900_000);
    assert.equal(valueOn(store.listAssets().find((a) => a.id === car.value.id)!.values, '2026-09-30'), 5_000_000);
    updateAsset(store, car.value.id, { archived: true });
    assert.equal(netWorth(store, NOW).assets, 100000, 'an archived item leaves the totals');
  }
});

test('checks on names, days, values and ids', () => {
  const store = seeded();
  assert.equal(addAsset(store, { name: '', kind: 'asset' }, NOW).ok, false);
  assert.equal(addAsset(store, { name: 'X', kind: 'thing' }, NOW).ok, false);
  const ok = addAsset(store, { name: 'Casa', kind: 'asset' }, NOW);
  assert.ok(ok.ok);
  assert.equal(addAsset(store, { name: 'casa', kind: 'asset' }, NOW).ok, false);
  const id = ok.ok ? ok.value.id : 0;
  assert.equal(setAssetValue(store, id, { day: '2026-12-01', value: 1 }, NOW).ok, false, 'not in the future');
  assert.equal(setAssetValue(store, id, { day: '2026-10-01', value: -1 }, NOW).ok, false);
  assert.equal(setAssetValue(store, id, { day: '2026-10-01', value: 1.5 }, NOW).ok, false);
  assert.equal(setAssetValue(store, 99, { day: '2026-10-01', value: 1 }, NOW).ok, false);
  assert.equal(addAsset(store, { name: 'Bad', kind: 'asset', value: -5 }, NOW).ok, false);
  assert.equal(store.listAssets().some((a) => a.name === 'Bad'), false, 'a failed value does not leave the item behind');
  assert.equal(deleteAsset(store, id).ok, true);
  assert.equal(deleteAsset(store, id).ok, false);
});

test('the routes work', () => {
  const store = seeded();
  const call = (method: string, path: string, payload?: unknown) => apiRoute(method, path, new URLSearchParams(), store, NOW, payload === undefined ? '' : JSON.stringify(payload));
  assert.equal(call('GET', '/api/networth')?.status, 200);
  const made = call('POST', '/api/assets', { name: 'Poupança', kind: 'asset', value: 100000 });
  assert.equal(made?.status, 200);
  const id = (made?.body as { id: number }).id;
  assert.equal(call('PUT', `/api/assets/${id}/values`, { day: '2026-10-14', value: 120000 })?.status, 200);
  assert.equal(call('PUT', `/api/assets/${id}`, { name: 'Poupança Y' })?.status, 200);
  assert.equal(call('DELETE', `/api/assets/${id}`)?.status, 200);
});
