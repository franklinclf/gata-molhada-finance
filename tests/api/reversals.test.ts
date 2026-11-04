import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { explore } from '../../src/api/explorer.ts';
import { setReversal } from '../../src/api/mutations.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-28T15:00:00Z');

const account: CanonicalAccount = {
  id: 'a1', institution: 'Bank', kind: 'credit_card', name: 'Card', last4: '1111', balance: 0, balanceSourceId: 'pluggy', balanceAsOf: NOW.toISOString(),
  creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [],
};

const tx = (id: string, day: string, amount: number, description: string, category: string | null = null): CanonicalTransaction => ({
  id, accountId: 'a1', occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pluggy'], excluded: false,
});

function seeded(list: CanonicalTransaction[]) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.replaceCanonicalAccounts([account], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), NOW.toISOString());
  return store;
}
const reversalOf = (store: ReturnType<typeof seeded>, id: string) => effectiveTransactions(store, { includeExcluded: true }).find((t) => t.id === id)?.reversal ?? null;

test('a credit that says it is an estorno pairs with the purchase of the same amount, and takes its category', () => {
  const store = seeded([tx('buy', '2026-10-18', -2490, 'Rappi*Rappi Brasil Int', 'Delivery de comida'), tx('other', '2026-10-17', -2490, 'Padaria Sol'), tx('back', '2026-10-19', 2490, 'Estorno de compra', 'Renda')]);
  assert.deepEqual([reversalOf(store, 'buy')?.side, reversalOf(store, 'buy')?.otherId, reversalOf(store, 'back')?.side], ['charge', 'back', 'refund']);
  assert.equal(reversalOf(store, 'other'), null, 'the later purchase of that amount is the one returned, not an older one');
  assert.equal(effectiveTransactions(store).find((t) => t.id === 'back')?.category, 'Delivery de comida');
});

test('a credit that says nothing pairs only with the same text and amount a few days before, and never a transfer between people', () => {
  const store = seeded([
    tx('ride', '2026-07-05', -2359, '99 PAY BALANCE PAYMENT'), tx('release', '2026-07-05', 2359, '99 PAY BALANCE PAYMENT'),
    { ...tx('sent', '2026-07-01', -5000, 'Transferência enviada|Maria') }, { ...tx('got', '2026-07-02', 5000, 'Transferência Recebida|Joao') },
  ]);
  assert.equal(reversalOf(store, 'ride')?.otherId, 'release');
  assert.equal(reversalOf(store, 'sent'), null);
  assert.equal(reversalOf(store, 'got'), null);
});

test('the owner can pair two entries by hand, and undo a pair so that it does not come back', () => {
  const store = seeded([tx('buy', '2026-10-01', -9000, 'Loja X'), tx('credit', '2026-10-10', 4000, 'Crédito loja')]);
  assert.equal(reversalOf(store, 'buy'), null);
  assert.deepEqual(setReversal(store, 'credit', 'buy', NOW), { ok: true });
  const linked = reversalOf(store, 'buy')!;
  assert.deepEqual([linked.otherId, linked.partial, linked.amount, linked.byUser], ['credit', true, 4000, true]);
  assert.deepEqual(setReversal(store, 'buy', null, NOW), { ok: true });
  assert.equal(reversalOf(store, 'buy'), null);
  assert.equal(setReversal(store, 'buy', 'buy', NOW).ok, false);
  const twoDebits = seeded([tx('a', '2026-10-01', -100, 'A'), tx('b', '2026-10-02', -100, 'B')]);
  assert.equal(setReversal(twoDebits, 'a', 'b', NOW).ok, false);
});

test('an automatic pair that the owner undoes stays undone', () => {
  const store = seeded([tx('buy', '2026-10-18', -2490, 'Rappi*Rappi Brasil Int'), tx('back', '2026-10-19', 2490, 'Estorno de compra')]);
  assert.ok(reversalOf(store, 'buy'));
  setReversal(store, 'back', null, NOW);
  assert.equal(reversalOf(store, 'buy'), null);
  assert.equal(reversalOf(store, 'back'), null);
});

test('the list shows the refund on the row of its purchase, and the sums still count both', () => {
  const store = seeded([tx('buy', '2026-10-18', -2490, 'Rappi*Rappi Brasil Int'), tx('back', '2026-10-19', 2490, 'Estorno de compra'), tx('plain', '2026-10-20', -1000, 'Mercado')]);
  const view = explore(store, { kind: 'all', sort: 'date_desc', limit: 50, offset: 0 }, NOW);
  assert.deepEqual(view.items.map((t) => t.id).sort(), ['buy', 'plain']);
  assert.equal(view.total, 2);
  assert.deepEqual([view.sums.expense, view.sums.income], [3490, 2490]);
  const incomeOnly = explore(store, { kind: 'income', sort: 'date_desc', limit: 50, offset: 0 }, NOW);
  assert.deepEqual(incomeOnly.items.map((t) => t.id), ['back'], 'alone in the result, the refund stays visible');
});
