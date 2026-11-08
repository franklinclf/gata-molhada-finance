import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { cashFlow, spending } from '../../src/api/views.ts';
import { cyclesFor } from '../../src/api/cycles.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');
const T = NOW.toISOString();

const account = (id: string, institution: string, kind: CanonicalAccount['kind'] = 'checking'): CanonicalAccount => ({
  id, institution, kind, name: id, last4: kind === 'credit_card' ? '4321' : null, balance: 0, balanceSourceId: 'pluggy', balanceAsOf: T, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: kind === 'credit_card' ? '2026-10-15' : null, limitGroupId: null, refs: [{ sourceId: 'pluggy', externalId: `ext-${id}`, role: 'member' }],
});
const tx = (id: string, accountId: string, day: string, amount: number, description: string, category: string | null, extra: Partial<CanonicalTransaction> = {}): CanonicalTransaction => ({
  id, accountId, occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pluggy'], excluded: false, ...extra,
});

function seeded(list: CanonicalTransaction[]) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.replaceCanonicalAccounts([account('a', 'Banco Azul'), account('b', 'Banco Verde'), account('c', 'Banco Roxo'), account('card', 'Banco Azul', 'credit_card')], [], T);
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: t.id, transactionId: t.id, matchPass: 0 })), T);
  return store;
}
const byId = (store: ReturnType<typeof seeded>) => new Map(effectiveTransactions(store).map((t) => [t.id, t]));

test('a Pix that arrives with a cut name is the other side of a move the source marked as between own accounts', () => {
  const store = seeded([
    tx('out', 'a', '2026-09-16', -187310, 'Transferência enviada|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('in', 'b', '2026-09-16', 187310, 'PIX RECEBIDO - REM  Ana Paula Ribeir 16/09 - DOCTO: 123456', 'Transfer - PIX'),
  ]);
  const t = byId(store).get('in')!;
  assert.deepEqual([t.role, t.category, t.title], ['own_transfer', 'Transferência entre minhas contas', 'Transferência de suas contas']);
  assert.equal(cashFlow(store, { from: '2026-09-01', to: '2026-09-30' }, NOW).inflow, 0, 'not income');
});

test('a Pix sent with no name at all is the other side of an own move marked a day earlier on another account', () => {
  const store = seeded([
    tx('top-up', 'c', '2026-06-03', 128000, 'pix receive top up', 'Same person transfer'),
    tx('salary', 'a', '2026-06-04', 128000, 'Salário REMUNERACAO/SALARIO', 'Salary'),
    tx('sent', 'a', '2026-06-04', -128000, 'Pix enviado Pix enviado', 'Transfer - PIX'),
  ]);
  const rows = byId(store);
  assert.equal(rows.get('sent')?.role, 'own_transfer');
  assert.equal(rows.get('salary')?.role, null, 'the salary itself stays income');
  assert.equal(spending(store, { from: '2026-06-01', to: '2026-06-30' }, 'category', NOW).total, 0, 'not spending');
});

test('a mirror is used once, never on the same account, never too far apart, and the owner\'s choice stands', () => {
  const store = seeded([
    // Both sides marked: they pair with each other, so the Pix to a friend for the same amount keeps no role.
    tx('own-out', 'a', '2026-05-19', -54321, 'Transferência enviada|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('own-in', 'b', '2026-05-19', 54321, 'Transferência Recebida|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('friend', 'c', '2026-05-19', -54321, 'Transferência enviada|Bruno Teixeira Lima', 'Transfers'),
    // One marked side, two role-less candidates: only one of them takes it.
    tx('lone', 'a', '2026-07-21', -73150, 'Transferência enviada|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('first', 'b', '2026-07-21', 73150, 'PIX RECEBIDO - REM  Ana Paula Ribeir 21/07', 'Transfer - PIX'),
    tx('second', 'c', '2026-07-22', 73150, 'PIX RECEBIDO - REM  Carla Souza 22/07', 'Transfer - PIX'),
    // Same account, or three days apart: not a mirror.
    tx('same-out', 'a', '2026-08-01', -12000, 'Transferência enviada|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('same-in', 'a', '2026-08-01', 12000, 'Pix recebido', 'Transfer - PIX'),
    tx('far-out', 'a', '2026-08-10', -13000, 'Transferência enviada|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('far-in', 'b', '2026-08-13', 13000, 'Pix recebido', 'Transfer - PIX'),
    // The owner said what this one is.
    tx('chosen-out', 'a', '2026-08-20', -14000, 'Transferência enviada|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('chosen-in', 'b', '2026-08-20', 14000, 'Pix recebido', 'Transfer - PIX'),
  ]);
  store.setCategoryOverride('chosen-in', 'Presentes', T);
  const rows = byId(store);
  assert.equal(rows.get('friend')?.role, null);
  assert.deepEqual([rows.get('first')?.role, rows.get('second')?.role], ['own_transfer', null]);
  assert.deepEqual([rows.get('same-in')?.role, rows.get('far-in')?.role], [null, null]);
  assert.deepEqual([rows.get('chosen-in')?.role, rows.get('chosen-in')?.category], [null, 'Presentes']);
});

test('card installments of balance added to the account are an own move: out of spending, still in the bill', () => {
  const store = seeded([1, 2, 3].map((n) => tx(`loan-${n}`, 'card', `2026-0${6 + n}-14`, -50000, 'Saldo adicionado na sua conta do Nubank', 'Transfers', { installment: { number: n, total: 3 } })));
  store.upsertSourceBills('pluggy', [8, 9, 10].map((m) => ({ externalId: `bill-${m}`, accountExternalId: 'ext-card', dueDate: `2026-${String(m).padStart(2, '0')}-20`, closingDate: `2026-${String(m).padStart(2, '0')}-13`, total: 50000, minimumPayment: null })), T);
  const rows = byId(store);
  assert.deepEqual([...rows.values()].map((t) => t.role), ['own_transfer', 'own_transfer', 'own_transfer']);
  assert.equal(spending(store, { from: '2026-07-01', to: '2026-09-30' }, 'category', NOW).total, 0);
  const card = store.listCanonicalAccounts().find((a) => a.id === 'card')!;
  const cycles = cyclesFor(store, card, [...rows.values()], '2026-10-27');
  assert.equal(cycles.reduce((s, c) => s + c.charges, 0), 150000, 'the bill keeps the installments');
});

test('a card purchase labelled as an investment is a purchase, and a role label never names a category on its own', () => {
  const store = seeded([
    tx('course', 'card', '2026-09-30', -30000, 'Cursoplus *Cursoplus', 'Investments'),
    tx('chosen', 'card', '2026-10-02', -100, 'Ig*Corretora', 'Shopping'),
    tx('darf', 'a', '2026-10-05', -3518, 'Pagamento de boleto RECEITA FED-DARF SIMPLES-CB', 'Fixed income'),
    tx('fund', 'a', '2026-10-06', -9000, 'Pagamento de boleto XYZ', 'Fixed income'),
    tx('yield', 'a', '2026-10-07', 1, 'Rendimentos REND PAGO APLIC AUT', 'Proceeds interests and dividends'),
    tx('rdb', 'a', '2026-10-08', -200000, 'Aplicação RDB', 'Investments'),
  ]);
  store.setCategoryOverride('chosen', 'Investimentos', T);
  const rows = byId(store);
  assert.deepEqual([rows.get('course')?.role, rows.get('course')?.category], [null, null]);
  assert.equal(rows.get('chosen')?.role, 'investment', 'the owner can still call a card charge an investment');
  assert.deepEqual([rows.get('darf')?.role, rows.get('darf')?.category], [null, 'Impostos e taxas']);
  assert.deepEqual([rows.get('fund')?.role, rows.get('fund')?.category], [null, null]);
  assert.equal(rows.get('yield')?.category, 'Renda');
  assert.deepEqual([rows.get('rdb')?.role, rows.get('rdb')?.category], ['investment', 'Investimentos']);
  assert.equal(spending(store, { from: '2026-09-01', to: '2026-10-31' }, 'category', NOW).groups.some((g) => g.name === 'Investimentos'), false);
});

test('the closest pair is matched first, so an earlier unrelated credit does not take the mirror from the real other side', () => {
  const store = seeded([
    tx('out', 'a', '2026-03-10', -10000, 'Transferência enviada|Ana Paula Ribeiro Costa', 'Same person transfer'),
    // Two days earlier than the move, on another account: it comes first in time, but it is the farther one.
    tx('stranger', 'c', '2026-03-08', 10000, 'PIX RECEBIDO - REM  Maria Souza Lima 08/03', 'Transfer - PIX'),
    tx('real', 'b', '2026-03-10', 10000, 'PIX RECEBIDO - REM  Ana Paula Ribeir 10/03', 'Transfer - PIX'),
  ]);
  const rows = byId(store);
  assert.deepEqual([rows.get('real')?.role, rows.get('stranger')?.role], ['own_transfer', null]);
});

test('a marked move that already has its opposite on the same account takes no mirror on another account', () => {
  const store = seeded([
    // Money in and out of one account on the same day, both marked: they are each other\'s other side.
    tx('in-a', 'a', '2026-02-20', 100000, 'Transferência Recebida|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('out-a', 'a', '2026-02-20', -100000, 'Transferência enviada|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('pix-b', 'b', '2026-02-21', 100000, 'PIX RECEBIDO - REM  Bruno Teixeira Lima 21/02', 'Transfer - PIX'),
  ]);
  assert.equal(byId(store).get('pix-b')?.role, null, 'income from someone else stays income');
});

test('the mirror is found when the view is limited to one account', () => {
  const store = seeded([
    tx('out', 'a', '2026-09-16', -187310, 'Transferência enviada|Ana Paula Ribeiro Costa', 'Same person transfer'),
    tx('in', 'b', '2026-09-16', 187310, 'PIX RECEBIDO - REM  Ana Paula Ribeir 16/09 - DOCTO: 123456', 'Transfer - PIX'),
  ]);
  const scoped = effectiveTransactions(store, { accountId: 'b' });
  assert.deepEqual(scoped.map((t) => [t.id, t.role]), [['in', 'own_transfer']]);
});
