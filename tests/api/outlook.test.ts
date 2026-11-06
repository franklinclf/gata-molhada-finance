import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { outlook } from '../../src/api/outlook.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { cards } from '../../src/api/views.ts';
import { toolByName } from '../../src/ai/analyst-tools.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
// Wednesday 14 October 2026: the month ends on the 31st, 18 days left counting today.
const NOW = new Date('2026-10-14T15:00:00Z');
const T = NOW.toISOString();

const account = (id: string, kind: CanonicalAccount['kind'], balance: number, extra: Partial<CanonicalAccount> = {}): CanonicalAccount => ({
  id, institution: id === 'cardA' ? 'Alfa' : id === 'cardB' ? 'Beta' : 'Banco', kind, name: id, last4: null, balanceSourceId: 'pluggy', balance, balanceAsOf: T, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pluggy', externalId: `ext-${id}`, role: 'member' }], ...extra,
});
const tx = (id: string, description: string, day: string, amount: number, accountId = 'chk', extra: Partial<CanonicalTransaction> = {}): CanonicalTransaction => ({
  id, accountId, occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment: null, category: 'Casa e utilidades', state: 'confirmed', sourceIds: ['pluggy'], excluded: false, ...extra,
});
const monthly = (name: string, amount: number, day: string, months = ['05', '06', '07', '08', '09', '10'], accountId = 'chk') => months.map((m) => tx(`${name}-${m}`, name, `2026-${m}-${day}`, amount, accountId));

interface Setup {
  balance?: number;
  bills?: Array<{ card: 'A' | 'B'; due: string; closing: string; total: number }>;
  list?: CanonicalTransaction[];
}

function seeded({ balance = 1_000_000, bills = [], list = [] }: Setup = {}) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.replaceCanonicalAccounts([account('chk', 'checking', balance), account('cardA', 'credit_card', 0), account('cardB', 'credit_card', 0)], [], T);
  store.upsertSourceBills('pluggy', bills.map((b, i) => ({ externalId: `b${i}`, accountExternalId: `ext-card${b.card}`, dueDate: b.due, closingDate: b.closing, total: b.total, minimumPayment: null })), T);
  store.replaceCanonicalTransactions([tx('start-a', 'Cafe', '2026-07-01', -100, 'cardA'), tx('start-b', 'Cafe', '2026-07-01', -100, 'cardB'), ...list], [], T);
  return store;
}

// Card A closes on the 5th and is due on the 12th. Its September bill was paid; the October one (300,00) was not.
// Card B closes on the 20th and is due on the 28th. Its September bill was paid; the open cycle holds a 120,00 purchase.
const BILLS: Setup['bills'] = [
  { card: 'A', due: '2026-09-12', closing: '2026-09-05', total: 20000 },
  { card: 'A', due: '2026-10-12', closing: '2026-10-05', total: 30000 },
  { card: 'B', due: '2026-09-28', closing: '2026-09-20', total: 15000 },
];

const base = (): CanonicalTransaction[] => [
  tx('a-sep', 'Mercado', '2026-08-20', -20000, 'cardA'),
  tx('a-oct', 'Mercado', '2026-09-20', -30000, 'cardA'),
  tx('pay-a-sep', 'Pagamento recebido', '2026-09-11', 20000, 'cardA', { category: 'Credit card payment' }),
  tx('b-sep', 'Restaurante', '2026-09-10', -15000, 'cardB'),
  tx('pay-b-sep', 'Pagamento recebido', '2026-09-27', 15000, 'cardB', { category: 'Credit card payment' }),
  tx('b-open', 'Livraria', '2026-10-10', -12000, 'cardB'),
];

test('bills of cards that close on different days land on their own due dates, and the paid ones are left out', () => {
  const store = seeded({ bills: BILLS, list: base() });
  const v = outlook(store, NOW);
  assert.equal(v.balance, 1_000_000);
  const bills = v.timeline.filter((e) => e.kind === 'bill');
  // Card A's unpaid October bill is overdue (due the 12th) so it is placed today; card B's open bill is due the 28th.
  assert.deepEqual(bills.map((e) => [e.name, e.day, e.amount, e.late]), [['Fatura Alfa cardA', '2026-10-14', 30000, true], ['Fatura Beta cardB', '2026-10-28', 12000, false]]);
  assert.equal(v.dueOut.bills, 42000);
  // Same definition of "to pay" as the Faturas screen.
  assert.equal(v.dueOut.bills, cards(store, NOW).totals.toPay);
  assert.equal(v.free.value, 1_000_000 - 42000);
  assert.equal(v.firstUncovered, null);
});

test('a bill that was paid does not count, and an overdue one counts today', () => {
  const paid = seeded({ bills: BILLS, list: [...base(), tx('pay-a-oct', 'Pagamento recebido', '2026-10-12', 30000, 'cardA', { category: 'Credit card payment' })] });
  assert.deepEqual(outlook(paid, NOW).timeline.filter((e) => e.kind === 'bill').map((e) => [e.name, e.amount]), [['Fatura Beta cardB', 12000]]);
  const overdue = outlook(seeded({ bills: BILLS, list: base() }), NOW);
  const late = overdue.timeline.find((e) => e.name === 'Fatura Alfa cardA')!;
  assert.equal(late.day, overdue.today);
  assert.equal(late.late, true);
});

test('a bill due after the month ends is shown but is not taken from the free amount', () => {
  const store = seeded({ bills: BILLS, list: [...base(), tx('a-open', 'Farmacia', '2026-10-08', -40000, 'cardA')] });
  const v = outlook(store, NOW);
  // Card A's open cycle closes on the 5th of November and is due on the 12th: after the month.
  const after = v.timeline.filter((e) => e.afterMonth);
  assert.deepEqual(after.map((e) => [e.name, e.day, e.amount]), [['Fatura Alfa cardA', '2026-11-12', 40000]]);
  assert.equal(v.afterMonth.total, 40000);
  assert.equal(v.afterMonth.count, 1);
  assert.equal(v.afterMonth.firstDay, '2026-11-12');
  assert.equal(v.dueOut.bills, 30000 + 12000);
  assert.equal(v.free.value, 1_000_000 - 42000);
});

test('the timeline flags the first payment that the projected balance does not cover, with the cumulative need', () => {
  const store = seeded({ balance: 35000, bills: BILLS, list: base() });
  const v = outlook(store, NOW);
  assert.equal(v.free.value, 35000 - 42000);
  assert.deepEqual(v.timeline.map((e) => [e.name, e.balanceBefore, e.balanceAfter, e.covered, e.shortfall, e.cumulativeOut]), [
    ['Fatura Alfa cardA', 35000, 5000, true, 0, 30000],
    ['Fatura Beta cardB', 5000, -7000, false, 7000, 42000],
  ]);
  assert.equal(v.firstUncovered?.name, 'Fatura Beta cardB');
  assert.deepEqual(v.lowest, { day: '2026-10-28', value: -7000 });
  assert.equal(v.free.perDay, null);
});

test('without registered income the recurring credits are the income, and what already arrived this month is not expected again', () => {
  // Salary on the 20th; rent leaves the account on the 5th, already paid this month; the gym on the 25th is still to come.
  const list = [...base(), ...monthly('SALARIO ACME', 500000, '20', ['05', '06', '07', '08', '09']), ...monthly('ALUGUEL', -150000, '05'), ...monthly('ACADEMIA', -9000, '25', ['05', '06', '07', '08', '09'])];
  const v = outlook(seeded({ bills: BILLS, list }), NOW);
  assert.equal(v.expectedIn.source, 'recurring');
  assert.deepEqual(v.expectedIn.items.map((e) => [e.name, e.day, e.amount]), [['Salario Acme', '2026-10-20', 500000]]);
  assert.deepEqual(v.dueOut.items.filter((e) => e.kind === 'recurring').map((e) => [e.name, e.day, e.amount]), [['Academia', '2026-10-25', 9000]]);
  assert.equal(v.free.value, 1_000_000 + 500000 - 42000 - 9000);
  assert.equal(v.committed.income.amount, 500000);
  assert.equal(v.committed.income.source, 'recurring');
  // The rent is a fixed item (150000) and the gym too (9000): 159000 of 500000.
  assert.equal(v.committed.fixed, 159000);
  assert.equal(v.committed.share, 159000 / 500000);
});

test('registered income wins over the estimate, and with neither the income is unknown instead of invented', () => {
  const store = seeded({ bills: BILLS, list: [...base(), ...monthly('SALARIO ACME', 500000, '20', ['05', '06', '07', '08', '09'])] });
  store.saveIncome({ name: 'Salario', amount: 420000, dayOfMonth: 22, fromMonth: null, untilMonth: null }, T);
  const v = outlook(store, NOW);
  assert.equal(v.expectedIn.source, 'registered');
  assert.deepEqual(v.expectedIn.items.map((e) => [e.name, e.day, e.amount]), [['Salario', '2026-10-22', 420000]]);
  assert.equal(v.committed.income.amount, 420000);

  const none = outlook(seeded({ bills: BILLS, list: base() }), NOW);
  assert.equal(none.expectedIn.source, 'none');
  assert.equal(none.expectedIn.total, 0);
  assert.equal(none.committed.income.amount, null);
  assert.equal(none.committed.share, null);
});

test('installments and subscriptions weigh on the committed share', () => {
  const list = [
    ...base(),
    ...monthly('SALARIO ACME', 500000, '20', ['05', '06', '07', '08', '09']),
    ...monthly('NETFLIX.COM', -4590, '08', ['05', '06', '07', '08', '09', '10'], 'cardA').map((t) => ({ ...t, category: 'Assinaturas e streaming' })),
    ...['07', '08', '09', '10'].map((m, i) => tx(`phone-${m}`, 'Celular', `2026-${m}-07`, -10000, 'cardA', { installment: { number: i + 1, total: 6 } })),
  ];
  const v = outlook(seeded({ bills: BILLS, list }), NOW);
  assert.equal(v.committed.subscriptions, 4590);
  assert.equal(v.committed.subscriptionCount, 1);
  assert.ok(v.committed.installments >= 10000, `installments ${v.committed.installments}`);
  assert.equal(v.committed.total, v.committed.installments + 4590 + v.committed.fixed);
  assert.ok(v.committed.share !== null && v.committed.share > 0 && v.committed.share < 1);
  // The subscription is charged on the card, so it is inside the bill and not a separate payment from the account.
  assert.equal(v.dueOut.items.some((e) => e.kind === 'recurring'), false);
});

test('the outlook answers over the API, and the analyst tool shows the same free amount', () => {
  const store = seeded({ bills: BILLS, list: base() });
  const res = apiRoute('GET', '/api/outlook', new URLSearchParams(), store, NOW);
  assert.equal(res?.status, 200);
  const body = res?.body as ReturnType<typeof outlook>;
  assert.equal(body.free.value, 958000);
  assert.equal(apiRoute('POST', '/api/outlook', new URLSearchParams(), store, NOW, '{}')?.status, 405);
  const tool = toolByName.get('outlook')!.run(store, NOW, {}) as { livreParaGastar: { valor: number } };
  assert.equal(tool.livreParaGastar.valor, 9580);
  store.setAccountHidden('cardA', true, T);
  assert.equal(outlook(store, NOW).dueOut.bills, 12000);
});
