import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createManual, deleteManual, isManualId, updateManual } from '../../src/api/manual.ts';
import { setIgnored, setTransactionCategory } from '../../src/api/mutations.ts';
import { transactionDetail } from '../../src/api/detail.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import * as views from '../../src/api/views.ts';
import { runReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-28T15:00:00Z');
const T = NOW.toISOString();

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.upsertSourceAccounts('pluggy', [{ externalId: 'a1', externalItemId: 'i1', institution: 'Banco Gol', kind: 'credit_card', name: 'Gol Card', last4: '9747', balance: 10000, creditLimit: 500000, availableLimit: 490000, minimumPayment: null, dueDate: '2026-11-10' }], T);
  store.upsertSourceTransactions('pluggy', [{ externalId: 't1', accountExternalId: 'a1', occurredAt: '2026-10-10T15:00:00Z', amount: -5000, description: 'LOJA', descriptionRaw: null, status: 'posted', installment: null, category: 'Shopping' }], T);
  runReconciliation(store, { now: () => NOW });
  return { store, accountId: store.listCanonicalAccounts()[0]!.id };
}

test('a transaction typed in joins the canonical ones and survives a new reconciliation', () => {
  const { store, accountId } = seeded();
  const made = createManual(store, { accountId, day: '2026-10-20', amount: -6085, description: 'Real Debrid', category: 'Assinaturas e streaming' }, NOW);
  assert.ok(made.ok);
  const id = made.ok ? made.value.id : '';
  assert.ok(isManualId(id));
  const find = () => effectiveTransactions(store, { includeHidden: true }).find((t) => t.id === id);
  assert.deepEqual([find()?.amount, find()?.category, find()?.sourceIds, find()?.state], [-6085, 'Assinaturas e streaming', [], 'confirmed']);
  runReconciliation(store, { now: () => NOW });
  assert.ok(find(), 'a later sync and reconciliation keep it');
  const spend = views.spending(store, { from: '2026-10-01', to: '2026-10-31' }, 'category', NOW);
  assert.equal(spend.total, 5000 + 6085);
});

test('editing, recategorizing and deleting', () => {
  const { store, accountId } = seeded();
  const made = createManual(store, { accountId, day: '2026-10-20', amount: -213, description: 'IOF' }, NOW);
  const id = made.ok ? made.value.id : '';
  assert.deepEqual(updateManual(store, id, { amount: -300, description: 'IOF internacional' }, NOW), { ok: true, value: {} });
  assert.deepEqual([effectiveTransactions(store, { includeHidden: true }).find((t) => t.id === id)?.amount, store.listManualTransactions()[0]?.description], [-300, 'IOF internacional']);
  assert.deepEqual(setTransactionCategory(store, id, 'Impostos e taxas', false, NOW), { ok: true });
  assert.equal(effectiveTransactions(store, { includeHidden: true }).find((t) => t.id === id)?.category, 'Impostos e taxas');
  assert.equal(setIgnored(store, id, true, NOW).ok, false, 'delete it instead');
  assert.ok(transactionDetail(store, id, NOW), 'the drawer opens without a source record');
  assert.equal(deleteManual(store, id, NOW).ok, true);
  assert.equal(effectiveTransactions(store, { includeHidden: true }).some((t) => t.id === id), false);
  assert.equal(deleteManual(store, id, NOW).ok, false);
});

test('checks on account, day, amount and text', () => {
  const { store, accountId } = seeded();
  const bad = (extra: Record<string, unknown>) => createManual(store, { accountId, day: '2026-10-20', amount: -100, description: 'X', ...extra }, NOW).ok;
  assert.equal(bad({ accountId: 'nope' }), false);
  assert.equal(bad({ day: '2026-02-30' }), false);
  assert.equal(bad({ day: '2025-12-31' }), false, 'before the data starts');
  assert.equal(bad({ day: '2026-11-02' }), false, 'future');
  assert.equal(bad({ amount: 0 }), false);
  assert.equal(bad({ amount: 12.5 }), false);
  assert.equal(bad({ description: '   ' }), false);
  assert.equal(bad({ description: 'x'.repeat(201) }), false);
  assert.equal(bad({}), true);
});

test('the routes create, edit and delete', () => {
  const { store, accountId } = seeded();
  const call = (method: string, path: string, payload?: unknown) => apiRoute(method, path, new URLSearchParams(), store, NOW, payload === undefined ? '' : JSON.stringify(payload));
  const made = call('POST', '/api/manual-transactions', { accountId, day: '2026-10-21', amount: 4500, description: 'Estorno em dinheiro' });
  assert.equal(made?.status, 200);
  const id = (made?.body as { id: string }).id;
  assert.equal(call('PUT', `/api/manual-transactions/${id}`, { notes: 'combinado por mensagem' })?.status, 200);
  assert.equal(call('PUT', '/api/manual-transactions/man_999', { notes: 'x' })?.status, 404);
  assert.equal(call('DELETE', `/api/manual-transactions/${id}`)?.status, 200);
});
