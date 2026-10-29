import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalTransaction } from '../../src/core/canonical.ts';
import { removeCategory, setTransactionCategory } from '../../src/api/mutations.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { createRule, deleteRule, exportRules, importRules, listRules, previewRule, reorderRules, updateRule } from '../../src/api/rules.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-28T15:00:00Z');
const T = NOW.toISOString();

const tx = (id: string, description: string, amount: number, category: string | null = 'Services'): CanonicalTransaction => ({
  id, accountId: 'chk', occurredAt: '2026-10-20T15:00:00Z', amount, description, descriptionRaw: null, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pluggy'], excluded: false,
});

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.replaceCanonicalAccounts([{ id: 'chk', institution: 'Bank', kind: 'checking', name: 'Conta', last4: null, balance: 0, balanceSourceId: 'pluggy', balanceAsOf: T, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [] }], [], T);
  const list = [tx('u1', 'UBER *TRIP HELP.U SA', -2490), tx('u2', 'Uber Eats Pedido', -4500), tx('m1', 'MERCADO CENTRAL', -8000), tx('pay', 'Pagamento de fatura', -90000, 'Credit card payment')];
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), T);
  return store;
}

const contains = (text: string) => ({ match: 'all', items: [{ field: 'description', operator: 'contains', value: text }] });
const body = (name: string, text: string, category: string, extra: Record<string, unknown> = {}) => ({ name, conditions: contains(text), actions: { category }, ...extra });
const byId = (store: ReturnType<typeof seeded>) => new Map(effectiveTransactions(store, { includeHidden: true }).map((t) => [t.id, t]));

test('a rule sets the category of every transaction it matches, and the first rule by priority wins', () => {
  const store = seeded();
  assert.equal(createRule(store, body('Uber', 'uber', 'Transporte por aplicativo'), NOW).ok, true);
  assert.equal(createRule(store, body('Uber Eats', 'uber eats', 'Delivery de comida'), NOW).ok, true);
  assert.equal(byId(store).get('u2')?.category, 'Transporte por aplicativo', 'the older rule has the lower priority number, so it wins');
  const rules = listRules(store);
  assert.deepEqual(rules.map((r) => [r.name, r.matches]), [['Uber', 2], ['Uber Eats', 1]]);
  assert.deepEqual(reorderRules(store, [rules[1]!.id, rules[0]!.id], NOW), { ok: true, value: {} });
  assert.equal(byId(store).get('u2')?.category, 'Delivery de comida');
  assert.equal(byId(store).get('u1')?.category, 'Transporte por aplicativo');
  assert.equal(byId(store).get('u1')?.categoryOrigin, 'rule');
});

test('the owner\'s own choice on a transaction beats a rule', () => {
  const store = seeded();
  createRule(store, body('Uber', 'uber', 'Transporte por aplicativo'), NOW);
  setTransactionCategory(store, 'u1', 'Lazer e esportes', false, NOW);
  assert.equal(byId(store).get('u1')?.category, 'Lazer e esportes');
  assert.equal(byId(store).get('u2')?.category, 'Transporte por aplicativo');
});

test('a rule on text does not turn a card payment into spending', () => {
  const store = seeded();
  createRule(store, { name: 'Tudo que saiu', conditions: { match: 'all', items: [{ field: 'direction', operator: 'equals', value: 'out' }] }, actions: { category: 'Outros gastos' } }, NOW);
  const pay = byId(store).get('pay')!;
  assert.equal(pay.role, 'card_payment');
  assert.equal(pay.category, 'Pagamento de fatura');
  assert.equal(byId(store).get('m1')?.category, 'Outros gastos');
});

test('inactive rules do nothing, and a rule that points to a deleted category is switched off', () => {
  const store = seeded();
  const made = createRule(store, body('Mercado', 'mercado', 'Compras da casa', { active: false }), NOW);
  assert.ok(made.ok);
  assert.equal(byId(store).get('m1')?.category, 'Services');
  updateRule(store, made.ok ? made.value.id : 0, { active: true }, NOW);
  assert.equal(byId(store).get('m1')?.category, 'Compras da casa');
  assert.deepEqual(removeCategory(store, 'Compras da casa'), { ok: true });
  assert.equal(store.listRules()[0]?.active, false);
  assert.equal(byId(store).get('m1')?.category, 'Services');
});

test('saving checks the rule: blank value, bad regex, duplicate name, missing category', () => {
  const store = seeded();
  assert.equal(createRule(store, body('A', '  ', 'X'), NOW).ok, false);
  assert.equal(createRule(store, { name: 'B', conditions: { match: 'all', items: [{ field: 'description', operator: 'regex', value: 'a*' }] }, actions: { category: 'X' } }, NOW).ok, false);
  assert.equal(createRule(store, { name: 'C', conditions: contains('x'), actions: {} }, NOW).ok, false);
  assert.ok(createRule(store, body('D', 'x', 'X'), NOW).ok);
  const again = createRule(store, body('d', 'y', 'X'), NOW);
  assert.deepEqual([again.ok, again.ok ? 0 : again.status], [false, 409]);
});

test('preview counts what a rule would match and change without saving anything', () => {
  const store = seeded();
  const preview = previewRule(store, body('x', 'uber', 'Transporte por aplicativo'));
  assert.ok(preview.ok);
  if (preview.ok) {
    assert.deepEqual([preview.value.matched, preview.value.willChange, preview.value.sample.length], [2, 2, 2]);
    assert.equal(preview.value.sample[0]?.newCategory, 'Transporte por aplicativo');
  }
  assert.equal(store.listRules().length, 0);
});

test('export and import by category name: refused over existing rules unless confirmed, bad rules skipped and reported', () => {
  const store = seeded();
  createRule(store, body('Uber', 'uber', 'Transporte por aplicativo'), NOW);
  const file = JSON.parse(JSON.stringify(exportRules(store)));
  assert.equal(file.format, 'gmf-rules');
  const other = seeded();
  const withBad = { ...file, rules: [...file.rules, { name: 'Ruim', conditions: contains(''), actions: { category: 'X' } }, { ...file.rules[0] }] };
  const done = importRules(other, withBad, NOW);
  assert.ok(done.ok);
  if (done.ok) assert.deepEqual([done.value.imported, done.value.skipped.map((s) => s.name)], [1, ['Ruim', 'Uber']]);
  const again = importRules(other, file, NOW);
  assert.deepEqual([again.ok, again.ok ? 0 : again.status], [false, 409]);
  const allBad = importRules(other, { format: 'gmf-rules', overwrite: true, rules: [{ name: 'Ruim', conditions: contains(''), actions: { category: 'X' } }] }, NOW);
  assert.ok(allBad.ok && allBad.value.imported === 0);
  assert.equal(other.listRules().length, 1, 'when nothing in the file is usable, the current rules stay');
  assert.equal(importRules(other, { format: 'other', rules: [] }, NOW).ok, false);
});

test('the routes list, create, update and delete rules', () => {
  const store = seeded();
  const call = (method: string, path: string, payload?: unknown) => apiRoute(method, path, new URLSearchParams(), store, NOW, payload === undefined ? '' : JSON.stringify(payload));
  const created = call('POST', '/api/rules', body('Uber', 'uber', 'Transporte por aplicativo'));
  assert.equal(created?.status, 200);
  const id = (created?.body as { id: number }).id;
  assert.equal((call('GET', '/api/rules')?.body as { items: unknown[] }).items.length, 1);
  assert.equal(call('PUT', `/api/rules/${id}`, { active: false })?.status, 200);
  assert.equal(call('POST', '/api/rules/preview', body('x', 'mercado', 'Compras'))?.status, 200);
  assert.equal(call('GET', '/api/rules/export')?.status, 200);
  assert.equal(call('DELETE', `/api/rules/${id}`)?.status, 200);
  assert.equal(call('DELETE', `/api/rules/${id}`)?.status, 404);
  assert.equal(deleteRule(store, 99).ok, false);
});
