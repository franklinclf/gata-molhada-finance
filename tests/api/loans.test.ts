import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { calendar } from '../../src/api/calendar.ts';
import { createLoan, deleteLoan, loansView, matchInstallments, scheduleOf } from '../../src/api/loans.ts';
import { netWorth } from '../../src/api/networth.ts';
import { outlook } from '../../src/api/outlook.ts';
import { detectRecurring } from '../../src/api/recurring.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { spending } from '../../src/api/views.ts';
import { runReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { Loan } from '../../src/store/store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-28T15:00:00Z');
const T = NOW.toISOString();

// principal 3000,00, total 3250,00 in 6 installments: 541,67 x4 and 541,66 x2.
const LOAN = { name: 'Reforma', principal: 300000, total: 325000, installments: 6, firstDue: '2026-10-10', takenOn: '2026-09-05' };
const loan = (extra: Partial<Loan> = {}): Loan => ({ id: 1, accountId: 'acc', interestManualId: null, ...LOAN, ...extra });

function seeded(debits: Array<[string, string, number]> = [], kind: 'checking' | 'credit_card' = 'checking') {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.upsertSourceAccounts('pluggy', [
    { externalId: 'a1', externalItemId: 'i1', institution: 'Banco Azul', kind, name: 'Conta', last4: null, balance: 500000, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null },
    { externalId: 'a2', externalItemId: 'i2', institution: 'Banco Gol', kind: 'credit_card', name: 'Cartao', last4: '1234', balance: 0, creditLimit: 500000, availableLimit: 500000, minimumPayment: null, dueDate: '2026-11-10' },
  ], T);
  store.upsertSourceTransactions('pluggy', [
    { externalId: 'cash', accountExternalId: 'a1', occurredAt: '2026-09-05T15:00:00Z', amount: 300000, description: 'Crédito em conta', descriptionRaw: null, status: 'posted', installment: null, category: null },
    { externalId: 'mercado', accountExternalId: 'a1', occurredAt: '2026-10-12T15:00:00Z', amount: -7000, description: 'MERCADO', descriptionRaw: null, status: 'posted', installment: null, category: null },
    ...debits.map(([id, day, amount]) => ({ externalId: id, accountExternalId: 'a1', occurredAt: `${day}T15:00:00Z`, amount, description: `DEBITO ${id}`, descriptionRaw: null, status: 'posted' as const, installment: null, category: null })),
  ], T);
  runReconciliation(store, { now: () => NOW });
  const account = store.listCanonicalAccounts().find((a) => a.kind !== 'credit_card')!;
  return { store, accountId: account.id };
}

test('the total is split in whole cents, the first installments take the extra cent, and the day clamps to the month end', () => {
  const schedule = scheduleOf(loan());
  assert.deepEqual(schedule.map((s) => s.amount), [54167, 54167, 54167, 54167, 54166, 54166]);
  assert.equal(schedule.reduce((s, i) => s + i.amount, 0), 325000);
  assert.deepEqual(schedule.map((s) => s.day), ['2026-10-10', '2026-11-10', '2026-12-10', '2027-01-10', '2027-02-10', '2027-03-10']);
  assert.deepEqual(scheduleOf(loan({ firstDue: '2026-01-31', installments: 4, total: 400000 })).map((s) => s.day), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(scheduleOf(loan({ installments: 1 })).map((s) => s.amount), [325000]);
});

const row = (id: string, day: string, amount: number, extra: Record<string, unknown> = {}) => ({ id, accountId: 'acc', amount, occurredAt: `${day}T15:00:00Z`, role: null, excluded: false, state: 'confirmed' as const, ...extra });

test('an installment takes the debit within 2 cents and from 3 days before to 7 days after, the closest day first', () => {
  const m = (rows: ReturnType<typeof row>[]) => [...matchInstallments(loan(), rows)];
  assert.deepEqual(m([row('a', '2026-10-10', -54169)]), [[1, 'a']], '2 cents off is fine');
  assert.deepEqual(m([row('a', '2026-10-10', -54170)]), [], '3 cents off is not');
  assert.deepEqual(m([row('a', '2026-10-07', -54167)]), [[1, 'a']]);
  assert.deepEqual(m([row('a', '2026-10-06', -54167)]), []);
  assert.deepEqual(m([row('a', '2026-10-17', -54167)]), [[1, 'a']]);
  assert.deepEqual(m([row('a', '2026-10-18', -54167)]), []);
  assert.deepEqual(m([row('far', '2026-10-17', -54167), row('near', '2026-10-11', -54167)]), [[1, 'near']]);
  assert.deepEqual(m([row('a', '2026-10-10', 54167)]), [], 'a credit is not a payment');
});

test('a transaction pays one installment only, and pending, excluded, other-account and role rows are ignored', () => {
  // Two installments a month apart share no window, so the reuse is tested across loans with the same set.
  const used = new Set<string>();
  const rows = [row('a', '2026-10-10', -54167)];
  assert.equal(matchInstallments(loan({ id: 1 }), rows, used).size, 1);
  assert.equal(matchInstallments(loan({ id: 2 }), rows, used).size, 0);
  for (const bad of [row('x', '2026-10-10', -54167, { state: 'stale_pending' }), row('x', '2026-10-10', -54167, { excluded: true }), row('x', '2026-10-10', -54167, { accountId: 'other' }), row('x', '2026-10-10', -54167, { role: 'card_payment' })]) {
    assert.equal(matchInstallments(loan(), [bad]).size, 0);
  }
});

test('creating a loan books the interest as a manual transaction, and deleting the loan removes it', () => {
  const { store, accountId } = seeded();
  const made = createLoan(store, { ...LOAN, accountId }, NOW);
  assert.ok(made.ok);
  const saved = store.listLoans()[0]!;
  const manual = store.listManualTransactions().find((m) => m.id === saved.interestManualId)!;
  assert.deepEqual([manual.amount, manual.description, manual.category, manual.day, manual.accountId], [-25000, 'Juros do empréstimo Reforma', 'Empréstimos e financiamentos', '2026-09-05', accountId]);
  assert.deepEqual(deleteLoan(store, saved.id, NOW), { ok: true, value: {} });
  assert.deepEqual([store.listLoans().length, store.listManualTransactions().length], [0, 0]);
  assert.equal(deleteLoan(store, saved.id, NOW).ok, false);
  const free = createLoan(store, { ...LOAN, total: LOAN.principal, accountId }, NOW);
  assert.ok(free.ok);
  assert.equal(store.listLoans()[0]!.interestManualId, null, 'no interest, no manual transaction');
});

test('validation errors', () => {
  const { store, accountId } = seeded();
  const card = store.listCanonicalAccounts().find((a) => a.kind === 'credit_card')!.id;
  const bad = (patch: Record<string, unknown>) => createLoan(store, { ...LOAN, accountId, ...patch }, NOW);
  for (const patch of [{ accountId: card }, { accountId: 'nope' }, { name: '' }, { name: 'x'.repeat(61) }, { principal: 0 }, { total: 100 }, { installments: 0 }, { installments: 121 }, { installments: 1.5 }, { firstDue: '2026-02-31' }, { firstDue: 'x' }, { takenOn: '2026-11-01' }, { takenOn: '2025-12-31' }, { takenOn: '2026-13-01' }]) {
    const r = bad(patch);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.ok ? 0 : r.status, 400);
  }
  assert.deepEqual([store.listLoans().length, store.listManualTransactions().length], [0, 0], 'nothing is saved on error');
});

test('the view marks installments paid, due, late and future, and the debit leaves spending', () => {
  const { store, accountId } = seeded([['p1', '2026-10-10', -54167]]);
  createLoan(store, { ...LOAN, accountId, firstDue: '2026-09-10' }, NOW);
  // Installments: 09-10 (nothing matches, 48 days ago: late), 10-10 (paid), 11-10 (future).
  const [v] = loansView(store, NOW).items;
  assert.deepEqual(v!.schedule.map((s) => s.status), ['late', 'paid', 'future', 'future', 'future', 'future']);
  assert.deepEqual([v!.paidCount, v!.interest, v!.remaining, v!.next], [1, 25000, 325000 - 54167, { day: '2026-09-10', amount: 54167, late: true }]);
  const t = effectiveTransactions(store, { includeHidden: true }).find((x) => x.description === 'DEBITO p1')!;
  assert.deepEqual([t.role, t.category, t.title], ['loan_payment', 'Pagamento de empréstimo', 'Pagamento de empréstimo']);
  // Spending holds the market and the interest, not the installment.
  assert.equal(spending(store, { from: '2026-09-01', to: '2026-10-31' }, 'category', NOW).total, 7000 + 25000);
  // Without the loan the same debit is ordinary spending.
  const lonely = seeded([['p1', '2026-10-10', -54167]]);
  assert.equal(spending(lonely.store, { from: '2026-09-01', to: '2026-10-31' }, 'category', NOW).total, 7000 + 54167);
});

test('a due installment shows as due until 5 days pass', () => {
  const { store, accountId } = seeded();
  createLoan(store, { ...LOAN, accountId, firstDue: '2026-10-25' }, NOW);
  assert.equal(loansView(store, NOW).items[0]!.schedule[0]!.status, 'due');
});

test('the loan is a recurring item that ends with its last installment', () => {
  const { store, accountId } = seeded();
  createLoan(store, { ...LOAN, accountId, firstDue: '2026-10-25', installments: 2 }, NOW);
  const item = detectRecurring(store, NOW).find((r) => r.key.startsWith('loan:'))!;
  assert.ok(item);
  assert.deepEqual([item.name, item.direction, item.kind, item.account, item.label, item.manual, item.regular, item.late], ['Empréstimo Reforma', 'out', 'fixed', 'bank', 'recurring', true, true, false]);
  assert.deepEqual([item.amount, item.dayOfMonth, item.nextDay, item.endsOn], [162500, 25, '2026-10-25', '2026-11-25']);
  assert.deepEqual(item.remaining!.map((s) => s.day), ['2026-10-25', '2026-11-25']);
});

test('outlook and calendar project the open installments with their own amounts and stop at the last one', () => {
  const { store, accountId } = seeded();
  // Installments of 541,67 (x4) and 541,66 (x2) from 2026-10-30.
  createLoan(store, { ...LOAN, accountId, firstDue: '2026-10-30' }, NOW);
  const item = detectRecurring(store, NOW).find((r) => r.key.startsWith('loan:'))!;
  assert.equal(item.endsOn, '2027-03-30');
  assert.deepEqual([item.amount, item.remaining!.length], [54167, 6]);
  const out = outlook(store, NOW);
  assert.deepEqual(out.timeline.filter((e) => e.name === 'Empréstimo Reforma').map((e) => [e.day, e.amount]), [['2026-10-30', 54167]], 'until the end of the month');
  assert.equal(out.committed.fixed, 54167, 'it weighs once in the committed fixed items');
  const march = calendar(store, '2027-03', new Date('2027-03-01T15:00:00Z'));
  assert.deepEqual(march.days.flatMap((d) => d.projected.filter((p) => p.name === 'Empréstimo Reforma' && d.day > '2027-03-01').map((p) => [d.day, p.amount])), [['2027-03-30', 54166]], 'the last one is 541,66');
  const april = calendar(store, '2027-04', new Date('2027-03-01T15:00:00Z'));
  assert.equal(april.days.some((d) => d.projected.some((p) => p.name === 'Empréstimo Reforma')), false, 'nothing after the last installment');
});

test('net worth lists the remaining installments as a liability', () => {
  const { store, accountId } = seeded([['p1', '2026-10-10', -54167]]);
  createLoan(store, { ...LOAN, accountId }, NOW);
  const item = netWorth(store, NOW).items.find((i) => i.name === 'Empréstimo Reforma (parcelas restantes)')!;
  assert.deepEqual([item.value, item.liability], [325000 - 54167, true]);
});

test('the routes list, create and delete', () => {
  const { store, accountId } = seeded();
  const call = (method: string, path: string, payload?: unknown) => apiRoute(method, path, new URLSearchParams(), store, NOW, payload === undefined ? '' : JSON.stringify(payload));
  assert.equal(call('POST', '/api/loans', { ...LOAN, accountId, total: 1 })?.status, 400);
  const made = call('POST', '/api/loans', { ...LOAN, accountId });
  assert.equal(made?.status, 200);
  const listed = call('GET', '/api/loans')!.body as { items: Array<{ id: number }>; generatedAt: string };
  assert.equal(listed.items.length, 1);
  assert.ok(listed.generatedAt);
  assert.equal(call('PUT', '/api/loans')?.status, 405);
  assert.equal(call('DELETE', `/api/loans/${listed.items[0]!.id}`)?.status, 200);
  assert.equal(call('DELETE', '/api/loans/99')?.status, 404);
});
