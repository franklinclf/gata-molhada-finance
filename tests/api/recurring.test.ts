import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { calendar } from '../../src/api/calendar.ts';
import { dayInMonth, detectRecurring, ignoreRecurring } from '../../src/api/recurring.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-20T15:00:00Z');
const T = NOW.toISOString();

const account = (id: string, kind: CanonicalAccount['kind'], balance: number): CanonicalAccount => ({
  id, institution: 'Banco', kind, name: id, last4: null, balanceSourceId: 'pluggy', balance, balanceAsOf: T, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [],
});
const tx = (id: string, description: string, day: string, amount: number, accountId = 'chk', extra: Partial<CanonicalTransaction> = {}): CanonicalTransaction => ({
  id, accountId, occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment: null, category: 'Casa e utilidades', state: 'confirmed', sourceIds: [], excluded: false, ...extra,
});

function seeded(list: CanonicalTransaction[]) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.replaceCanonicalAccounts([account('chk', 'checking', 500000), account('card', 'credit_card', 0)], [], T);
  store.replaceCanonicalTransactions(list, [], T);
  return store;
}

const monthly = (name: string, amounts: number[], day = '05', account = 'chk') => amounts.map((a, i) => tx(`${name}-${i}`, name, `2026-${String(5 + i).padStart(2, '0')}-${day}`, a, account));

test('a charge that comes back each month with the same amount is recurring, and the next day is expected', () => {
  const store = seeded([...monthly('Netflix', [-4490, -4490, -4490, -4490, -4490, -4490]), tx('x1', 'MERCADO CENTRAL', '2026-10-03', -8000)]);
  const items = detectRecurring(store, NOW);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0]?.name, items[0]?.kind, items[0]?.amount, items[0]?.occurrences, items[0]?.dayOfMonth], ['Netflix', 'fixed', 4490, 6, 5]);
  assert.deepEqual([items[0]?.lastDay, items[0]?.nextDay, items[0]?.late, items[0]?.account], ['2026-10-05', '2026-11-05', false, 'bank']);
});

test('a utility bill with a moving amount is recurring and variable; a shop with random amounts and days is not', () => {
  const store = seeded([...monthly('ENERGISA', [-18000, -21000, -16500, -24000, -19500, -22000], '12'), tx('r1', 'PADARIA', '2026-05-02', -3000), tx('r2', 'PADARIA', '2026-06-20', -9000), tx('r3', 'PADARIA', '2026-07-03', -1200), tx('r4', 'PADARIA', '2026-09-30', -7000)]);
  const items = detectRecurring(store, NOW);
  assert.deepEqual(items.map((i) => [i.name, i.kind]), [['Energisa', 'variable']]);
});

test('a cancelled subscription, installments, pending and ignored items are left out', () => {
  const list = [
    ...monthly('Antigo', [-1000, -1000, -1000], '10').map((t) => ({ ...t, occurredAt: t.occurredAt.replace('2026-0', '2026-0') })),
    ...monthly('Parcelado', [-5000, -5000, -5000, -5000, -5000, -5000], '08').map((t, i) => ({ ...t, installment: { number: i + 1, total: 6 } })),
    ...monthly('Pendente', [-2000, -2000, -2000, -2000], '09').map((t) => ({ ...t, status: 'pending' as const })),
    ...monthly('Ginastica', [-9000, -9000, -9000, -9000, -9000, -9000], '15'),
  ];
  const store = seeded(list);
  assert.deepEqual(detectRecurring(store, NOW).map((i) => i.name), ['Ginastica']);
  assert.deepEqual(ignoreRecurring(store, 'out|ginastica', true, NOW), { ok: true });
  assert.deepEqual(detectRecurring(store, NOW), []);
  assert.equal(ignoreRecurring(store, 'x', true, NOW).ok, false);
});

test('income that repeats is found too, and a recurring item whose day passed is late', () => {
  const store = seeded([...monthly('SALARIO ACME', [500000, 500000, 500000, 500000, 500000, 500000], '14')]);
  const [salary] = detectRecurring(store, NOW);
  assert.deepEqual([salary?.direction, salary?.nextDay, salary?.late], ['in', '2026-11-14', false]);
  const lateStore = seeded(monthly('Aluguel', [-120000, -120000, -120000, -120000], '03').slice(0, 4));
  const [rent] = detectRecurring(lateStore, new Date('2026-09-20T15:00:00Z'));
  assert.equal(rent?.nextDay, '2026-09-03');
  assert.equal(rent?.late, true);
});

test('the same day of the month is clamped to short months', () => {
  assert.equal(dayInMonth('2026-02', 31), '2026-02-28');
  assert.equal(dayInMonth('2026-10', 31), '2026-10-31');
});

test('the calendar shows what went through, what is expected, and a projected balance from today', () => {
  const list = [...monthly('Netflix', [-4490, -4490, -4490, -4490, -4490, -4490]), ...monthly('SALARIO ACME', [300000, 300000, 300000, 300000, 300000], '28'), tx('today', 'PIX', '2026-10-20', -1000)];
  const store = seeded(list);
  const view = calendar(store, '2026-11', NOW);
  assert.equal(view.bankBalance, 500000);
  assert.equal(view.days.length, 30);
  const day = (d: string) => view.days.find((x) => x.day === d)!;
  assert.deepEqual(day('2026-11-05').projected.map((p) => [p.name, p.amount, p.direction]), [['Netflix', 4490, 'out']]);
  const october = calendar(store, '2026-10', NOW);
  const o = (d: string) => october.days.find((x) => x.day === d)!;
  assert.equal(o('2026-10-20').outflow, 1000, 'what really happened today');
  assert.equal(o('2026-10-10').balance, null, 'no projection for the past');
  assert.deepEqual(o('2026-10-28').projected.map((p) => [p.name, p.direction]), [['Salario Acme', 'in']]);
  assert.equal(o('2026-10-28').balance, 500000 + 300000);
  assert.equal(day('2026-11-05').balance, 500000 + 300000 - 4490);
});

test('an open card bill is projected on its due day, and the routes answer', () => {
  const store = seeded([tx('p1', 'Loja', '2026-10-10', -30000, 'card')]);
  const call = (path: string, query = '') => apiRoute('GET', path, new URLSearchParams(query), store, NOW);
  assert.equal(call('/api/calendar', 'month=2026-10')?.status, 200);
  assert.equal(call('/api/calendar', 'month=2026-13')?.status, 400);
  assert.equal(call('/api/recurring')?.status, 200);
  assert.equal(apiRoute('POST', '/api/recurring/ignore', new URLSearchParams(), store, NOW, JSON.stringify({ key: 'out|x', ignored: true }))?.status, 200);
});
