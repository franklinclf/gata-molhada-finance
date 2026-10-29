import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalTransaction } from '../../src/core/canonical.ts';
import { acceptRuleSuggestion, dismissRuleSuggestion, suggestRules } from '../../src/api/rule-suggestions.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-20T15:00:00Z');
const T = NOW.toISOString();

const tx = (id: string, description: string, amount: number, category: string, day = '2026-10-05'): CanonicalTransaction => ({
  id, accountId: 'chk', occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: [], excluded: false,
});

function seeded(list: CanonicalTransaction[]) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.replaceCanonicalAccounts([{ id: 'chk', institution: 'Banco', kind: 'checking', name: 'Conta', last4: null, balance: 0, balanceSourceId: 'pluggy', balanceAsOf: T, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [] }], [], T);
  store.replaceCanonicalTransactions(list, [], T);
  return store;
}

const uber = [
  tx('u1', 'DL*UberRides', -2000, 'Transporte por aplicativo'),
  tx('u2', 'DL*UberRidesSao PauloBRA', -2500, 'Transporte por aplicativo'),
  tx('u3', 'Uber UBER *TRIP HELP.U SA', -1800, 'Transporte por aplicativo'),
  tx('u4', 'UBER * PENDING', -2100, 'Lazer e esportes'),
  tx('u5', 'DL*UberRides', -2200, 'Transporte por aplicativo'),
  tx('u6', 'DL*UberRides', -1900, 'Transporte por aplicativo'),
  tx('u7', 'DL*UberRides', -2300, 'Transporte por aplicativo'),
  tx('u8', 'DL*UberRides', -2400, 'Transporte por aplicativo'),
  tx('u9', 'DL*UberRides', -2600, 'Transporte por aplicativo'),
  tx('u10', 'DL*UberRides', -2700, 'Transporte por aplicativo'),
];

test('a merchant that almost always has one category gets a rule suggested, ranked by what it would fix', () => {
  const store = seeded([...uber, tx('m1', 'MERCADO A', -1000, 'Supermercado'), tx('m2', 'MERCADO A', -1000, 'Supermercado'), tx('m3', 'MERCADO A', -1000, 'Supermercado')]);
  const [first, ...rest] = suggestRules(store);
  assert.deepEqual(first, { merchant: 'Uber', category: 'Transporte por aplicativo', count: 10, descriptions: 4, differing: 1 });
  assert.deepEqual(rest, [], 'one text, nothing to fix: not worth a rule');
});

test('too few, too mixed, people, bill payments and dismissed merchants are left out', () => {
  const store = seeded([
    tx('a1', 'LOJA X', -100, 'Compras online'), tx('a2', 'LOJA X', -100, 'Compras online'),
    ...Array.from({ length: 6 }, (_, i) => tx(`b${i}`, 'LOJA Y', -100, i < 3 ? 'Compras online' : 'Lazer e esportes')),
    ...Array.from({ length: 4 }, (_, i) => tx(`c${i}`, i % 2 ? 'LOJA Z' : 'Loja Z ', -100, 'Pets')),
  ]);
  assert.deepEqual(suggestRules(store).map((s) => s.merchant), ['Loja Z']);
  assert.deepEqual(dismissRuleSuggestion(store, 'loja z', NOW), { ok: true, value: {} });
  assert.deepEqual(suggestRules(store), []);
});

test('accepting creates a rule that sets the category for every variant, and the suggestion goes away', () => {
  const store = seeded(uber);
  assert.equal(acceptRuleSuggestion(store, 'Uber', 'Lazer e esportes', NOW).ok, false, 'a stale or changed suggestion is refused');
  const made = acceptRuleSuggestion(store, 'Uber', 'Transporte por aplicativo', NOW);
  assert.ok(made.ok);
  assert.equal(store.listRules()[0]?.name, 'Estabelecimento: Uber');
  assert.equal(effectiveTransactions(store, { includeHidden: true }).find((t) => t.id === 'u4')?.category, 'Transporte por aplicativo', 'the odd one out follows the rule');
  assert.deepEqual(suggestRules(store), []);
});

test('the routes list, accept and dismiss', () => {
  const store = seeded(uber);
  const call = (method: string, path: string, payload?: unknown) => apiRoute(method, path, new URLSearchParams(), store, NOW, payload === undefined ? '' : JSON.stringify(payload));
  assert.equal((call('GET', '/api/rules/suggestions')?.body as { items: unknown[] }).items.length, 1);
  assert.equal(call('POST', '/api/rules/suggestions/dismiss', { merchant: 'Uber' })?.status, 200);
  assert.equal((call('GET', '/api/rules/suggestions')?.body as { items: unknown[] }).items.length, 0);
  assert.equal(call('POST', '/api/rules/suggestions/accept', { merchant: 'Uber', category: 'X' })?.status, 409);
});
