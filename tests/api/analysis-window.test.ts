import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import type { Freshness } from '../../src/core/types.ts';
import { budgetsFor } from '../../src/api/budgets.ts';
import { calendar } from '../../src/api/calendar.ts';
import { explore, type ExplorerQuery } from '../../src/api/explorer.ts';
import { netWorth } from '../../src/api/networth.ts';
import { detectRecurring } from '../../src/api/recurring.ts';
import { categoryTrend } from '../../src/api/trends.ts';
import { cashFlow, dataHealth, freshness, spending } from '../../src/api/views.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-11-06T15:00:00Z');
const T = NOW.toISOString();

const account = (id: string, kind: CanonicalAccount['kind'], balance: number, overrides: Partial<CanonicalAccount> = {}): CanonicalAccount => ({
  id, institution: 'Bank', kind, name: id, last4: kind === 'credit_card' ? id.slice(-4) : null, balance, balanceSourceId: 'pluggy', balanceAsOf: T, creditLimit: kind === 'credit_card' ? 1_000_000 : null,
  availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pluggy', externalId: `ext-${id}`, role: 'member' }], ...overrides,
});
const tx = (id: string, accountId: string, day: string, amount: number, extra: Partial<CanonicalTransaction> = {}): CanonicalTransaction => ({
  id, accountId, occurredAt: `${day}T15:00:00Z`, amount, description: id, descriptionRaw: null, status: 'posted', installment: null, category: 'Compras', state: 'confirmed', sourceIds: ['pluggy'], excluded: false, ...extra,
});

function build(accounts: CanonicalAccount[], list: CanonicalTransaction[]) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.replaceCanonicalAccounts(accounts, [], T);
  store.replaceCanonicalTransactions(list, list.map((t) => ({ sourceId: 'pluggy', externalId: `e-${t.id}`, transactionId: t.id, matchPass: 0 })), T);
  return store;
}

/** A bank account and a card holding purchases from before the start, from today's month and from the future. */
function mixed() {
  return build(
    [account('chk', 'checking', 500_000), account('card0001', 'credit_card', 40_000)],
    [
      tx('before', 'card0001', '2025-12-20', -3000),
      tx('jan', 'card0001', '2026-01-10', -2000),
      tx('today-buy', 'card0001', '2026-11-03', -1500, { category: 'Mercado' }),
      tx('refund', 'card0001', '2026-11-05', 500, { category: 'Mercado' }),
      tx('planned', 'card0001', '2026-11-20', -4000, { category: 'Mercado' }),
      tx('bank-before', 'chk', '2025-11-10', -7000),
      tx('bank-out', 'chk', '2026-11-04', -2500),
      tx('bank-future', 'chk', '2026-11-09', -9000, { description: 'Aluguel agendado' }),
      tx('salary', 'chk', '2026-11-02', 100_000, { category: 'Renda', description: 'Salario' }),
      tx('invest', 'chk', '2026-11-04', -10_000, { description: 'Aplicacao CDB', category: 'Investimentos' }),
    ],
  );
}

const base: ExplorerQuery = { kind: 'all', sort: 'date_desc', limit: 500, offset: 0 };

test('spending equals the explorer net spending for the same period', () => {
  const store = mixed();
  const range = { from: '2025-12-01', to: '2026-11-06' };
  const view = spending(store, range, 'category', NOW);
  const sums = explore(store, { ...base, ...range, netSpending: true }, NOW).sums;
  assert.equal(view.total, sums.expense - sums.income);
  // 2.000 (Jan) + 1.500 + 2.500 on the bank - 500 refund
  assert.equal(view.total, 5500);
});

test('nothing before 2026-01-01 or dated ahead enters spending or cash flow', () => {
  const store = mixed();
  const range = { from: '2025-01-01', to: '2026-11-06' };
  const spent = spending(store, range, 'merchant', NOW);
  assert.ok(!spent.daily.some((d) => d.day < '2026-01-01' || d.day > '2026-11-06'));
  assert.equal(spent.daily.length, 4, 'jan, today-buy, bank-out and the refund');
  const flow = cashFlow(store, range, NOW);
  assert.ok(!flow.days.some((d) => d.day < '2026-01-01' || d.day > '2026-11-06'));
  assert.deepEqual([flow.inflow, flow.outflow], [100_000, 2500]);
});

test('the current month of the budget does not count planned installments', () => {
  const store = mixed();
  const view = budgetsFor(store, '2026-11', NOW);
  assert.equal(view.lines.find((l) => l.name === 'Mercado')?.actual, 1000, 'purchase 1.500 minus refund 500, not the 4.000 planned for the 20th');
});

test('the trend starts at the first month the app holds data for and ends with Sem categoria', () => {
  const store = build([account('chk', 'checking', 0)], [tx('a', 'chk', '2026-02-10', -1000), tx('b', 'chk', '2026-02-11', -300, { category: null }), tx('c', 'chk', '2026-03-05', -2000, { category: 'Mercado' })]);
  const view = categoryTrend(store, new Date('2026-03-20T15:00:00Z'), 6);
  assert.deepEqual(view.months, ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(view.rows.map((r) => r.name), ['Mercado', 'Compras', 'Sem categoria']);
});

test('cash flow leaves investments out and reports the net invested apart; card payments still count', () => {
  const store = build(
    [account('chk', 'checking', 0)],
    [
      tx('apply', 'chk', '2026-11-02', -200_000, { description: 'Aplicacao CDB', category: 'Investimentos' }),
      tx('redeem', 'chk', '2026-11-03', 50_000, { description: 'Resgate CDB', category: 'Investimentos' }),
      tx('billpay', 'chk', '2026-11-04', -80_000, { description: 'Pagamento de fatura', category: 'Pagamento de fatura' }),
      tx('own', 'chk', '2026-11-04', -1000, { description: 'Transferencia mesma titularidade', category: 'Transferência entre minhas contas' }),
      tx('pay', 'chk', '2026-11-05', 30_000, { description: 'Salario', category: 'Renda' }),
    ],
  );
  const flow = cashFlow(store, { from: '2026-11-01', to: '2026-11-06' }, NOW);
  assert.deepEqual([flow.inflow, flow.outflow, flow.net, flow.invested], [30_000, 80_000, -50_000, 150_000]);
});

test('the last point of the net worth chart is the headline number, even with entries dated ahead', () => {
  const store = build(
    [account('chk', 'checking', 100_000), account('card0001', 'credit_card', 40_000)],
    [tx('in', 'chk', '2026-10-05', 30_000), tx('future-bank', 'chk', '2026-11-20', 25_000), tx('buy', 'card0001', '2026-10-02', -50_000), tx('planned', 'card0001', '2026-12-02', -30_000)],
  );
  const view = netWorth(store, NOW);
  assert.equal(view.history.at(-1)!.net, view.net);
  assert.deepEqual([view.history.at(-1)!.assets, view.history.at(-1)!.liabilities], [view.assets, view.liabilities]);
  // End of October: nothing dated ahead was ever in the balances, so it is not undone.
  const october = view.history.find((p) => p.day === '2026-10-31')!;
  assert.equal(october.assets, 100_000);
});

const bill = (store: ReturnType<typeof build>, closing: string, due: string, total: number) =>
  store.upsertSourceBills('pluggy', [{ externalId: `b-${due}`, accountExternalId: 'ext-card0001', dueDate: due, closingDate: closing, total, minimumPayment: null }], T);

test('an open bill past its due date is expected today and marked late', () => {
  const store = build(
    [account('chk', 'checking', 500_000), account('card0001', 'credit_card', 20_000)],
    [tx('old', 'card0001', '2026-09-10', -50_000), tx('paid', 'card0001', '2026-10-05', 50_000, { description: 'Pagamento recebido' }), tx('buy', 'card0001', '2026-10-20', -20_000)],
  );
  // The bill that closed on 31/10 is not published yet and was due on 05/11, so the open cycle is already past its due date.
  bill(store, '2026-09-30', '2026-10-05', 50_000);
  const view = calendar(store, '2026-11', NOW);
  const bills = view.days.flatMap((d) => d.projected.map((p) => ({ ...p, day: d.day }))).filter((p) => p.kind === 'bill');
  assert.deepEqual(bills.map((b) => [b.day, b.late]), [['2026-11-06', true]]);
});

test('a charge dated ahead does not push the next expected date of a recurring item', () => {
  const rent = ['2026-07-09', '2026-08-09', '2026-09-09', '2026-10-09', '2026-11-09'].map((d) => tx(`rent-${d}`, 'chk', d, -150_000, { description: 'Aluguel Apt', category: 'Moradia' }));
  const store = build([account('chk', 'checking', 500_000)], rent);
  const item = detectRecurring(store, NOW).find((r) => r.name.startsWith('Aluguel'));
  assert.equal(item?.nextDay, '2026-11-09');
  const view = calendar(store, '2026-11', NOW);
  assert.ok(view.days.find((d) => d.day === '2026-11-09')!.projected.some((p) => p.name.startsWith('Aluguel')));
});

test('health warns when the app owes more on a card than the bank says, and stays quiet within tolerance', () => {
  const owing = (balance: number) => {
    const store = build(
      [account('chk', 'checking', 0), account('card0001', 'credit_card', balance)],
      [tx('start', 'card0001', '2026-08-01', -100), tx('buy', 'card0001', '2026-09-10', -100_000), tx('open', 'card0001', '2026-11-02', -5000)],
    );
    bill(store, '2026-09-30', '2026-10-05', 100_000);
    return store;
  };
  const bad = dataHealth(owing(30_000), NOW).filter((i) => i.id.startsWith('debt-'));
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.message, /banco informa/);
  assert.deepEqual(dataHealth(owing(105_000), NOW).filter((i) => i.id.startsWith('debt-')), []);
});

const fresh = (lastUpdatedAt: string): Freshness => ({ sourceId: 'pluggy', institution: 'Bank', lastUpdatedAt, observedAt: T });

test('a source read 26 hours ago is not late, one read 80 hours ago is', () => {
  const store = build([account('chk', 'checking', 0)], []);
  store.upsertFreshness(fresh('2026-11-05T13:00:00Z'));
  let view = freshness(store, NOW);
  assert.equal(view.sources[0]!.late, false);
  assert.ok(!view.health.some((h) => h.id.startsWith('stale-')));
  store.upsertFreshness(fresh('2026-11-03T07:00:00Z'));
  view = freshness(store, NOW);
  assert.equal(view.sources[0]!.late, true);
  assert.equal(view.sources[0]!.expectedEveryHours, 36);
  assert.ok(view.health.some((h) => h.id === 'stale-pluggy'));
});

test('a card with a recent bill and no transactions for a month is flagged while its bank still receives some', () => {
  const store = build(
    [account('chk', 'checking', 0), account('card0001', 'credit_card', 0, { institution: 'Bank' }), account('card0002', 'credit_card', 0, { institution: 'Bank' })],
    [tx('old-card-aug', 'card0001', '2026-08-20', -5000), tx('old-card-sep', 'card0001', '2026-09-08', -3000), tx('live-card', 'card0002', '2026-11-03', -5000), tx('live-bank', 'chk', '2026-11-04', -100)],
  );
  store.upsertSourceBills('pluggy', [{ externalId: 'b1', accountExternalId: 'ext-card0001', dueDate: '2026-09-15', closingDate: '2026-09-08', total: 5000, minimumPayment: null }], T);
  const silent = dataHealth(store, NOW).filter((i) => i.id.startsWith('silent-'));
  assert.deepEqual(silent.map((i) => i.id), ['silent-card0001']);
});

test('a savings account, a rarely used account and a card bought from once are not flagged next to an active account of the same bank', () => {
  const store = build(
    [account('chk', 'checking', 0), account('sav', 'savings', 0), account('chk-rare', 'checking', 0), account('card0001', 'credit_card', 0)],
    [
      tx('sav1', 'sav', '2026-06-10', 100), tx('sav2', 'sav', '2026-07-10', 100), tx('sav3', 'sav', '2026-08-10', 100),
      tx('r1', 'chk-rare', '2026-08-01', -100), tx('r2', 'chk-rare', '2026-08-05', -100), tx('r3', 'chk-rare', '2026-08-09', -100),
      tx('c1', 'card0001', '2026-09-03', -5000),
      tx('live', 'chk', '2026-11-04', -100),
    ],
  );
  store.upsertSourceBills('pluggy', [{ externalId: 'b1', accountExternalId: 'ext-card0001', dueDate: '2026-10-15', closingDate: '2026-10-08', total: 5000, minimumPayment: null }], T);
  assert.deepEqual(dataHealth(store, NOW).filter((i) => i.id.startsWith('silent-')), []);
});

test('a checking account with transactions in three of the four months before it went quiet is flagged', () => {
  const store = build(
    [account('chk', 'checking', 0), account('chk-old', 'checking', 0)],
    [tx('o1', 'chk-old', '2026-07-10', -100), tx('o2', 'chk-old', '2026-08-10', -100), tx('o3', 'chk-old', '2026-09-10', -100), tx('live', 'chk', '2026-11-04', -100)],
  );
  assert.deepEqual(dataHealth(store, NOW).filter((i) => i.id.startsWith('silent-')).map((i) => i.id), ['silent-chk-old']);
});
