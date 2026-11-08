import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { explore, type ExplorerQuery } from '../../src/api/explorer.ts';
import { estimatedTransactions } from '../../src/api/installments.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { cyclesFor } from '../../src/api/cycles.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { cards, spending } from '../../src/api/views.ts';
import { compareMonths } from '../../src/api/compare.ts';
import { transactionsCsv } from '../../src/api/export.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

const card: CanonicalAccount = {
  id: 'c1', institution: 'Bank A', kind: 'credit_card', name: 'Card', last4: '1234', balance: 0, balanceSourceId: 'pierre', balanceAsOf: '2026-10-27T14:00:00Z',
  creditLimit: 500000, availableLimit: 400000, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pierre', externalId: 'ext-c1', role: 'member' }],
};

function tx(id: string, day: string, amount: number, description: string, installment: { number: number; total: number } | null = null, category: string | null = 'Compras'): CanonicalTransaction {
  return { id, accountId: 'c1', occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment, category, state: 'confirmed', sourceIds: ['pierre'], excluded: false };
}

// Bills close on the 8th and are due on the 15th; July to October are published and paid, so the open bill is the one due in November.
function seeded(list: CanonicalTransaction[]) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pierre', ['2026-07', '2026-08', '2026-09', '2026-10'].map((m, i) => ({ externalId: `b${i}`, accountExternalId: 'ext-c1', dueDate: `${m}-15`, closingDate: `${m}-08`, total: 50000, minimumPayment: null })), NOW.toISOString());
  store.replaceCanonicalAccounts([card], [], NOW.toISOString());
  const payments = ['2026-07', '2026-08', '2026-09', '2026-10'].map((m) => tx(`pay-${m}`, `${m}-14`, 50000, 'Pagamento recebido', null, 'Pagamento de cartão de crédito'));
  store.replaceCanonicalTransactions([tx('start', '2026-06-01', -100, 'Coffee'), ...payments, ...list], [], NOW.toISOString());
  return store;
}

const series = (description: string, total: number, amount: number, charges: Array<[number, string]>, category = 'Compras') => charges.map(([n, day]) => tx(`${description}-${n}`, day, -amount, description, { number: n, total }, category));

const query = (extra: Partial<ExplorerQuery> = {}): ExplorerQuery => ({ kind: 'all', sort: 'date_asc', limit: 500, offset: 0, ...extra });

// 5 x 200,00: numbers 1, 3 and 4 were charged; 2 was billed in August and never listed, 5 is still to come in December.
const sofa = () => seeded(series('Sofa', 5, 20000, [[1, '2026-07-02'], [3, '2026-09-02'], [4, '2026-10-12']], 'Casa'));

test('a billed installment that was never listed becomes an estimated charge in its bill, and a future one is planned', () => {
  const rows = estimatedTransactions(sofa(), NOW);
  assert.deepEqual(rows.map((t) => [t.id.replace(/^est_ip_[0-9a-f]+_/, 'est_'), t.description, t.amount, t.category, t.billCycle, t.status]), [
    ['est_2', 'Sofa 2/5', -20000, 'Casa', '2026-08', 'posted'],
    ['est_5', 'Sofa 5/5', -20000, 'Casa', '2026-12', 'pending'],
  ]);
  const [august, december] = rows;
  assert.equal(august!.accountId, 'c1');
  assert.equal(august!.estimated, true);
  assert.equal(august!.title, 'Sofa 2/5');
  assert.deepEqual([august!.role, august!.excluded, august!.sourceIds, august!.installment], [null, false, [], { number: 2, total: 5 }]);
  // The date is the nearest seen charge (the earlier one on a tie) moved by whole months into the bill of the slot.
  assert.equal(august!.occurredAt.slice(0, 10), '2026-08-02');
  assert.equal(december!.occurredAt.slice(0, 10), '2026-11-12');
  // The id is stable between reads.
  assert.deepEqual(estimatedTransactions(sofa(), NOW).map((t) => t.id), rows.map((t) => t.id));
  assert.match(august!.id, /^est_ip_[0-9a-f]{12}_2$/);
});

test('the date of a slot in the open bill is not ahead of today', () => {
  // Charged on 09-30 (bill due in October); one month later is the 30th, in the open bill, but today is the 27th.
  const store = seeded(series('Desk', 3, 9000, [[1, '2026-09-30']]));
  const open = estimatedTransactions(store, NOW).find((t) => t.billCycle === '2026-11')!;
  assert.equal(open.description, 'Desk 2/3');
  assert.deepEqual([open.status, open.occurredAt.slice(0, 10)], ['posted', '2026-10-27']);
  // The slot of a bill that has not come keeps its own date.
  assert.deepEqual(estimatedTransactions(store, NOW).filter((t) => t.status === 'pending').map((t) => t.occurredAt.slice(0, 10)), ['2026-11-30']);
});

test('an installment that is already a charge is not listed again', () => {
  const store = seeded([tx('plain', '2026-08-02', -20001, 'Sofa', null, 'Casa'), ...series('Sofa', 5, 20000, [[2, '2026-09-02'], [3, '2026-10-12']], 'Casa')]);
  // 1 came as a plain charge in its bill: it is that installment, so only the number to come is left to estimate.
  assert.deepEqual(estimatedTransactions(store, NOW).map((t) => t.description), ['Sofa 4/5', 'Sofa 5/5']);
  const again = seeded([...series('Sofa', 5, 20000, [[1, '2026-07-02'], [3, '2026-09-02'], [4, '2026-10-12']], 'Casa'), tx('plain-2', '2026-08-03', -20000, 'Sofa', null, 'Casa')]);
  assert.deepEqual(estimatedTransactions(again, NOW).map((t) => t.description), ['Sofa 5/5']);
});

test('hidden cards and ignored charges do not make estimated rows', () => {
  const store = sofa();
  store.setAccountHidden('c1', true, NOW.toISOString());
  assert.equal(estimatedTransactions(store, NOW).length, 0);
  assert.equal(estimatedTransactions(store, NOW, { includeHidden: true }).length, 2);
});

test('a card with no bill yet has no cycles to place a slot in, so nothing is estimated', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.replaceCanonicalAccounts([card], [], NOW.toISOString());
  store.replaceCanonicalTransactions(series('Sofa', 5, 20000, [[1, '2026-07-02'], [3, '2026-09-02']]), [], NOW.toISOString());
  assert.equal(estimatedTransactions(store, NOW).length, 0);
});

test('the list shows the estimated charges, and the ones of bills to come only with the future option', () => {
  const store = sofa();
  const plain = explore(store, query(), NOW);
  assert.deepEqual(plain.items.filter((t) => t.estimated).map((t) => t.description), ['Sofa 2/5']);
  const ahead = explore(store, query({ future: true }), NOW);
  assert.deepEqual(ahead.items.filter((t) => t.estimated).map((t) => t.description), ['Sofa 2/5', 'Sofa 5/5']);
  // Even with a bill chosen or an end day, a plan for a bill that has not come needs the option.
  assert.equal(explore(store, query({ to: '2026-12-31' }), NOW).items.filter((t) => t.estimated).length, 1);
  assert.equal(plain.sums.expense, ahead.sums.expense - 20000);
});

test('filters, search and totals handle the estimated rows', () => {
  const store = sofa();
  const total = (q: Partial<ExplorerQuery>) => explore(store, query(q), NOW).items.filter((t) => t.estimated).length;
  assert.equal(total({ q: 'sofa 2/5' }), 1);
  assert.equal(total({ q: '200,00' }), 1);
  assert.equal(total({ categories: ['Casa'] }), 1);
  assert.equal(total({ categories: ['Outra'] }), 0);
  assert.equal(total({ accountIds: ['c1'] }), 1);
  assert.equal(total({ institutions: ['Bank A'] }), 1);
  assert.equal(total({ kind: 'income' }), 0);
  assert.equal(total({ min: 25000 }), 0);
  assert.equal(total({ status: 'pending', future: true }), 1);
  assert.equal(total({ from: '2026-08-01', to: '2026-08-31' }), 1);
  assert.equal(total({ cycle: '2026-08' }), 1);
  assert.equal(total({ cycle: '2026-09' }), 0);
  const result = explore(store, query({ categories: ['Casa'] }), NOW);
  assert.equal(result.sums.expense, 20000 * 4);
  assert.equal(result.facets.categories.find((f) => f.name === 'Casa')!.count, 4);
});

test('a bill chosen in the list adds up to what the bill totals say, with the estimated charge counted once', () => {
  const store = sofa();
  const accounts = store.listCanonicalAccounts();
  const real = effectiveTransactions(store, {}, accounts);
  const august = cyclesFor(store, accounts[0]!, real, '2026-10-27').find((c) => c.key === '2026-08')!;
  // The bill totals never see the estimated rows: the charge of the bill is only what was listed, and the plan adds the rest.
  assert.equal(august.charges, 0);
  const view = cards(store, NOW, {}, '2026-08');
  assert.equal(view.cards[0]!.plannedInstallments, 20000);
  assert.equal(view.cards[0]!.posted, 0);
  const listed = explore(store, query({ cycle: '2026-08' }), NOW);
  assert.equal(listed.items.filter((t) => t.amount < 0 && !t.role).reduce((s, t) => s - t.amount, 0), view.cards[0]!.plannedInstallments + view.cards[0]!.posted);
  // Reading the list twice, or the estimated rows, changes nothing in the bills.
  estimatedTransactions(store, NOW);
  assert.equal(cards(store, NOW, {}, '2026-08').cards[0]!.plannedInstallments, 20000);
  assert.equal(cards(store, NOW).totals.futureInstallments, 20000);
});

test('the spending views count the estimated charges by their date, and leave out the ones of bills to come', () => {
  const store = sofa();
  const august = spending(store, { from: '2026-08-01', to: '2026-08-31' }, 'category', NOW);
  assert.equal(august.total, 20000);
  assert.deepEqual(august.groups.map((g) => [g.name, g.amount]), [['Casa', 20000]]);
  // The one of the bill that has not come is a plan: the spending views leave it out, whatever the range.
  assert.equal(spending(store, { from: '2026-11-01', to: '2026-12-31' }, 'category', NOW).total, 0);
  // Before the first day the app holds, nothing counts.
  assert.equal(spending(store, { from: '2025-01-01', to: '2025-12-31' }, 'category', NOW).total, 0);
  const compare = compareMonths(store, '2026-08', NOW);
  assert.equal(compare.total.current, 20000);
});

test('an estimated charge opens a read-only explanation, and cannot be edited', () => {
  const store = sofa();
  const id = estimatedTransactions(store, NOW)[0]!.id;
  const reply = apiRoute('GET', `/api/transactions/${id}`, new URLSearchParams(), store, NOW, '');
  assert.equal(reply?.status, 200);
  const body = reply!.body as { transaction: { description: string }; purchase: { total: number }; number: number; cycle: { key: string } | null };
  assert.deepEqual([body.transaction.description, body.purchase.total, body.number, body.cycle?.key], ['Sofa 2/5', 5, 2, '2026-08']);
  assert.equal(apiRoute('GET', '/api/transactions/est_ip_000000000000_9', new URLSearchParams(), store, NOW, '')?.status, 404);
  const edit = apiRoute('PUT', `/api/transactions/${id}/category`, new URLSearchParams(), store, NOW, JSON.stringify({ category: 'Outra' }));
  assert.equal(edit?.status, 404);
  const bulk = apiRoute('POST', '/api/transactions/bulk', new URLSearchParams(), store, NOW, JSON.stringify({ ids: [id], ignored: true }));
  assert.equal(bulk?.status, 404);
});

test('the CSV marks an estimated charge', () => {
  const rows = explore(sofa(), query(), NOW).items;
  const csv = transactionsCsv(rows, (iso) => iso.slice(0, 10));
  assert.match(csv, /Sofa 2\/5;.*;estimada;/);
});
