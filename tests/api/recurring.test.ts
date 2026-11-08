import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { calendar } from '../../src/api/calendar.ts';
import { scheduledDays } from '../../src/api/projection.ts';
import { dayInMonth, detectRecurring, ignoreRecurring, markRecurring } from '../../src/api/recurring.ts';
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
  assert.deepEqual([salary?.direction, salary?.nextDay, salary?.late], ['in', '2026-11-13', false]);
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

test('a merchant the owner marks is listed from its first charge, with the word the owner chose', () => {
  const store = seeded([tx('r1', 'JOSE ALUGUEIS', '2026-10-05', -150000), tx('s1', 'ACADEMIA XYZ', '2026-10-08', -9900)]);
  assert.deepEqual(detectRecurring(store, NOW), [], 'one charge is not enough for the app to detect anything');
  assert.deepEqual(markRecurring(store, 'out|jose alugueis', 'recurring', NOW), { ok: true });
  assert.deepEqual(markRecurring(store, 'out|academia xyz', 'subscription', NOW), { ok: true });
  const items = detectRecurring(store, NOW);
  assert.deepEqual(items.map((i) => [i.name, i.label, i.manual, i.occurrences, i.dayOfMonth, i.nextDay]), [
    ['Jose Alugueis', 'recurring', true, 1, 5, '2026-11-05'],
    ['Academia Xyz', 'subscription', true, 1, 8, '2026-11-08'],
  ]);
  assert.equal(items[1]?.amount, 9900);
});

test('"none" hides a detected item, and clearing the mark goes back to what the app decides', () => {
  const store = seeded(monthly('Netflix', [-4490, -4490, -4490, -4490, -4490, -4490]));
  assert.equal(detectRecurring(store, NOW).length, 1);
  markRecurring(store, 'out|netflix', 'none', NOW);
  assert.equal(detectRecurring(store, NOW).length, 0);
  markRecurring(store, 'out|netflix', null, NOW);
  assert.equal(detectRecurring(store, NOW).length, 1);
  markRecurring(store, 'out|netflix', 'subscription', NOW);
  const item = detectRecurring(store, NOW)[0]!;
  assert.deepEqual([item.label, item.manual, item.occurrences], ['subscription', true, 6]);
});

test('a charge in the subscription category is called a subscription without the owner saying so, and the mark route checks its input', () => {
  const store = seeded(monthly('Spotify', [-2390, -2390, -2390, -2390, -2390, -2390]).map((t) => ({ ...t, category: 'Assinaturas e streaming' })));
  assert.deepEqual([detectRecurring(store, NOW)[0]?.label, detectRecurring(store, NOW)[0]?.manual], ['subscription', false]);
  assert.equal(apiRoute('PUT', '/api/recurring/mark', new URLSearchParams(), store, NOW, JSON.stringify({ key: 'out|spotify', label: 'weird' }))?.status, 400);
  assert.equal(apiRoute('PUT', '/api/recurring/mark', new URLSearchParams(), store, NOW, JSON.stringify({ key: 'nope', label: 'none' }))?.status, 400);
  assert.equal(apiRoute('PUT', '/api/recurring/mark', new URLSearchParams(), store, NOW, JSON.stringify({ key: 'out|spotify', label: 'none' }))?.status, 200);
});

const outlookOf = (store: ReturnType<typeof seeded>, now: Date) => apiRoute('GET', '/api/outlook', new URLSearchParams(), store, now)?.body as { expectedIn: { total: number; source: string }; dueOut: { recurring: number }; committed: { subscriptions: number; subscriptionCount: number; fixed: number; fixedCount: number } };

test('an employer that pays twice a month gives two monthly credits, each expected after its last one', () => {
  const pay: Array<[string, number]> = [['05-06', 410000], ['05-21', 180000], ['06-05', 410000], ['06-20', 175000], ['07-06', 410000], ['07-19', 185000], ['08-05', 410000], ['08-20', 180000], ['09-04', 410000], ['09-21', 182000], ['10-05', 410000]];
  const store = seeded(pay.map(([day, amount], i) => tx(`p${i}`, 'SALARIO EMPRESA FICTICIA LTDA', `2026-${day}`, amount, 'chk', { category: 'Salary' })));
  const items = detectRecurring(store, NOW);
  assert.deepEqual(items.map((i) => [i.key, i.dayOfMonth, i.amount, i.kind, i.nextDay, i.late]), [
    ['in|salario empresa ficticia', 20, 180000, 'fixed', '2026-10-20', false],
    ['in|salario empresa ficticia', 5, 410000, 'fixed', '2026-11-05', false],
  ]);
  const view = outlookOf(store, NOW);
  assert.deepEqual([view.expectedIn.source, view.expectedIn.total], ['recurring', 180000], 'the one of the 20th has not come yet this month');
});

test('a marked item with two unrelated days is not given a day between them, and is not late the next month', () => {
  const store = seeded([tx('a', 'PETSHOP ALFA', '2026-09-26', -4590, 'card'), tx('b', 'PETSHOP ALFA', '2026-10-12', -4590, 'card')]);
  markRecurring(store, 'out|petshop alfa', 'recurring', NOW);
  const [item] = detectRecurring(store, new Date('2026-11-08T15:00:00Z'));
  assert.deepEqual([item?.dayOfMonth, item?.nextDay, item?.late, item?.regular], [12, '2026-11-12', false, false]);
  assert.equal(outlookOf(store, NOW).committed.fixedCount, 0, 'no monthly rhythm, so not a monthly weight');
});

test('a marked item with an irregular history counts a same-day pair once and is not a monthly subscription', () => {
  const store = seeded([tx('a', 'BARBEARIA GAMA', '2026-05-06', -7000, 'card'), tx('b', 'BARBEARIA GAMA', '2026-07-08', -7000, 'card'), tx('c', 'BARBEARIA GAMA', '2026-07-08', -12500, 'card'), tx('d', 'BARBEARIA GAMA', '2026-10-14', -6500, 'card')]);
  markRecurring(store, 'out|barbearia gama', 'subscription', NOW);
  const [item] = detectRecurring(store, NOW);
  assert.deepEqual([item?.occurrences, item?.amount, item?.regular, item?.late], [3, 7000, false, false]);
  assert.deepEqual([outlookOf(store, NOW).committed.subscriptions, outlookOf(store, NOW).committed.subscriptionCount], [0, 0]);
});

test('a marked item that stopped stays listed as stopped instead of vanishing, and is not expected', () => {
  const store = seeded([tx('a', 'OPERADORA BETA', '2026-02-03', -3815, 'card'), tx('b', 'IMOBILIARIA OMEGA', '2026-03-02', -90000)]);
  markRecurring(store, 'out|operadora beta', 'recurring', NOW);
  markRecurring(store, 'out|imobiliaria omega', 'recurring', NOW);
  const items = detectRecurring(store, NOW);
  assert.deepEqual(items.map((i) => [i.name, i.stale, i.late, i.manual]), [['Operadora Beta', true, false, true], ['Imobiliaria Omega', true, false, true]]);
  assert.equal(outlookOf(store, NOW).committed.fixedCount, 0);
  assert.equal(calendar(store, '2026-11', NOW).days.some((d) => d.projected.length > 0), false, 'nothing is projected for it');
  markRecurring(store, 'out|operadora beta', 'none', NOW);
  assert.deepEqual(detectRecurring(store, NOW).map((i) => i.name), ['Imobiliaria Omega'], 'removing the mark hides it');
});

test('rent paid by Pix in two months in a row is recurring, by the latest month\'s total, and is due in the outlook', () => {
  const rent = (category: string, october = -118000) => [
    tx('r1', 'Transferência enviada|Joana Prado Lins', '2026-09-03', -62000, 'chk', { category }),
    tx('r2', 'Transferência enviada|Joana Prado Lins', '2026-09-12', -62000, 'chk', { category }),
    tx('r3', 'Transferência enviada pelo Pix|Joana Prado Lins', '2026-10-12', october, 'chk', { category }),
  ];
  const store = seeded(rent('Aluguel'));
  const [item] = detectRecurring(store, NOW);
  assert.deepEqual([item?.name, item?.account, item?.amount, item?.kind, item?.dayOfMonth, item?.nextDay], ['Joana Prado Lins', 'bank', 118000, 'fixed', 12, '2026-11-12']);
  assert.equal(outlookOf(store, new Date('2026-11-08T15:00:00Z')).dueOut.recurring, 118000);
  assert.deepEqual(detectRecurring(seeded(rent('Transferências')), NOW), [], 'a Pix to a person is not rent by itself');
  assert.deepEqual(detectRecurring(seeded(rent('Aluguel', -50000)), NOW), [], 'nor when the two months differ');
});

test('a gym membership is a subscription without the owner saying so', () => {
  const store = seeded(monthly('Academia Delta', [-10490, -10490, -10490, -10490, -10490, -10490]).map((t) => ({ ...t, category: 'Academia' })));
  assert.equal(detectRecurring(store, NOW)[0]?.label, 'subscription');
});

test('marking a payer that pays twice a month keeps both expected credits', () => {
  const pay: Array<[string, number]> = [['05-11', 410000], ['05-25', 250000], ['06-11', 410000], ['06-25', 250000], ['07-10', 410000], ['07-24', 250000], ['08-11', 410000], ['08-25', 250000], ['09-11', 410000], ['09-25', 250000], ['10-12', 410000]];
  const store = seeded(pay.map(([day, amount], i) => tx(`p${i}`, 'EMPRESA EXEMPLO SA', `2026-${day}`, amount, 'chk', { category: 'Salary' })));
  const before = detectRecurring(store, NOW).map((i) => [i.amount, i.dayOfMonth, i.regular]);
  markRecurring(store, 'in|empresa exemplo', 'recurring', NOW);
  const items = detectRecurring(store, NOW);
  assert.deepEqual(items.map((i) => [i.amount, i.dayOfMonth, i.regular]).sort(), before.sort());
  assert.deepEqual(items.map((i) => i.manual), [true, true]);
  assert.deepEqual([outlookOf(store, NOW).expectedIn.source, outlookOf(store, NOW).expectedIn.total], ['recurring', 250000], 'the credit of the 25th is still expected this month');
});

test('rent paid in parts keeps its item once the first part of the month is paid, with what is still due as the amount', () => {
  const rent = (...paid: Array<[string, number]>) => paid.map(([day, amount], i) => tx(`r${i}`, 'Transferência enviada|Joana Prado Lins', `2026-${day}`, amount, 'chk', { category: 'Aluguel' }));
  // 6,20 + 6,20 in September, 12,40 on 15/10, then the first 6,20 of November on the 4th.
  const store = seeded(rent(['09-03', -62000], ['09-12', -62000], ['10-15', -124000], ['11-04', -62000]));
  const now = new Date('2026-11-08T15:00:00Z');
  const [item] = detectRecurring(store, now);
  assert.deepEqual([item?.name, item?.amount, item?.rest, item?.dayOfMonth, item?.nextDay, item?.regular], ['Joana Prado Lins', 124000, 62000, 15, '2026-11-15', true]);
  assert.equal(outlookOf(store, now).dueOut.recurring, 62000, 'only the second part is still to leave');
  // Paid in full: nothing is left this month and the next whole rent is expected in December.
  const paid = seeded(rent(['09-03', -62000], ['09-12', -62000], ['10-15', -124000], ['11-04', -62000], ['11-06', -62000]));
  const [done] = detectRecurring(paid, now);
  assert.deepEqual([done?.amount, done?.rest, done?.nextDay], [124000, null, '2026-12-06']);
  assert.equal(outlookOf(paid, now).dueOut.recurring, 0);
});

test('scheduled days follow the rule, also when a moved day leaves its month', () => {
  // Day 1: 1/11/2026 is a Sunday, so the November one comes on Friday 30/10; 1/12/2026 is a Tuesday.
  assert.deepEqual(scheduledDays('2026-10-30', 1, '2026-10-01', '2026-12-30', 'previous').map((d) => [d.day, d.natural]), [['2026-10-30', '2026-11-01'], ['2026-12-01', '2026-12-01']]);
  // Without a rule the days are the plain days of the month.
  assert.deepEqual(scheduledDays('2026-11-01', 1, '2026-10-01', '2026-12-31').map((d) => d.day), ['2026-11-01', '2026-12-01']);
  // The next business day: 31/10/2026 is a Saturday and 2/11 a holiday, so it goes to 3/11.
  assert.deepEqual(scheduledDays('2026-11-03', 31, '2026-11-01', '2026-11-29', 'next').map((d) => [d.day, d.natural]), [['2026-11-03', '2026-10-31']]);
});
