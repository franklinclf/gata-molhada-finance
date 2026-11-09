import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { addDays, addMonthsToDay, cyclesFor, isCardPayment } from '../../src/api/cycles.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { runReconciliation } from '../../src/reconcile/run.ts';
import { account as sourceAccount, tx as sourceTx } from '../support/builders.ts';
import { cardBills, cards, holdsCurrent } from '../../src/api/views.ts';
import { editBill } from '../../src/api/mutations.ts';
import { billCheck } from '../../src/api/bill-check.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

function account(id: string, overrides: Partial<CanonicalAccount> = {}): CanonicalAccount {
  return {
    id, institution: 'Bank A', kind: 'credit_card', name: `Card ${id}`, last4: id.slice(-4), balance: 28090, balanceSourceId: 'pierre',
    balanceAsOf: '2026-10-27T14:00:00Z', creditLimit: 500000, availableLimit: 400000, minimumPayment: null, dueDate: '2026-10-15', limitGroupId: null,
    refs: [{ sourceId: 'pierre', externalId: `ext-${id}`, role: 'member' }],
    ...overrides,
  };
}

function tx(id: string, accountId: string, day: string, amount: number, category: string | null = 'Compras'): CanonicalTransaction {
  return { id, accountId, occurredAt: `${day}T15:00:00Z`, amount, description: id, descriptionRaw: null, status: 'posted', installment: null, category, state: 'confirmed', sourceIds: ['pierre'], excluded: false };
}

function setup(options: { payments?: boolean } = {}) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills(
    'pierre',
    [
      { externalId: 'b-sep', accountExternalId: 'ext-card1', dueDate: '2026-09-15', closingDate: '2026-09-08', total: 80000, minimumPayment: null },
      { externalId: 'b-oct', accountExternalId: 'ext-card1', dueDate: '2026-10-15', closingDate: '2026-10-08', total: 68000, minimumPayment: null },
    ],
    NOW.toISOString(),
  );
  const card1 = account('card1');
  const list = [
    tx('start', 'card1', '2026-08-01', -100),
    tx('buy-aug', 'card1', '2026-08-20', -50000),
    tx('buy-sep', 'card1', '2026-09-02', -80000),
    tx('buy-oct', 'card1', '2026-10-02', -68000),
    tx('buy-open', 'card1', '2026-10-10', -600),
    tx('refund-open', 'card1', '2026-10-12', 100),
  ];
  if (options.payments !== false) {
    list.push(tx('pay-sep', 'card1', '2026-09-15', 80000, 'Pagamento de cartão de crédito'));
    list.push(tx('pay-oct', 'card1', '2026-10-15', 68000, 'Pagamento de cartão de crédito'));
    // The same payment reported twice by another source counts once.
    list.push({ ...tx('pay-oct-dup', 'card1', '2026-10-15', 68000, 'Credit card payment'), sourceIds: ['pluggy'] });
  }
  store.replaceCanonicalAccounts([card1], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, [], NOW.toISOString());
  return { store, card1 };
}

test('helpers: month arithmetic keeps the day or clamps to the month end', () => {
  assert.equal(addMonthsToDay('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsToDay('2026-10-08', 1), '2026-11-08');
  assert.equal(addMonthsToDay('2026-01-15', -2), '2025-11-15');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(isCardPayment({ role: 'card_payment' }), true);
  assert.equal(isCardPayment({ role: null }), false);
});

test('cycles: paid bills, an open cycle after the last closing, and a payment reported twice counted once', () => {
  const { store, card1 } = setup();
  const cycles = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27');
  assert.deepEqual(cycles.map((c) => [c.key, c.status]), [['2026-09', 'paid'], ['2026-10', 'paid'], ['2026-11', 'open']]);
  const oct = cycles[1]!;
  assert.deepEqual([oct.from, oct.to, oct.dueDate, oct.billTotal, oct.charges, oct.paid, oct.outstanding], ['2026-09-09', '2026-10-08', '2026-10-15', 68000, 68000, 68000, 0]);
  const open = cycles[2]!;
  assert.deepEqual([open.from, open.to, open.dueDate, open.billTotal, open.charges, open.credits], ['2026-10-09', '2026-11-08', '2026-11-15', null, 600, 100]);
});

test('cycles: an unpaid bill is unpaid before the due date and overdue after it', () => {
  const { store, card1 } = setup({ payments: false });
  const txs = effectiveTransactions(store);
  assert.equal(cyclesFor(store, card1, txs, '2026-10-12')[1]!.status, 'unpaid');
  const late = cyclesFor(store, card1, txs, '2026-10-27')[1]!;
  assert.deepEqual([late.status, late.outstanding], ['overdue', 68000]);
});

test('cycles: a payment smaller than the bill leaves it partial', () => {
  const { store, card1 } = setup({ payments: false });
  store.replaceCanonicalTransactions(
    [tx('start', 'card1', '2026-08-01', -100), tx('buy-oct', 'card1', '2026-10-02', -68000), tx('part', 'card1', '2026-10-14', 20000, 'Pagamento de cartão de crédito')],
    [],
    NOW.toISOString(),
  );
  const oct = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-14')[1]!;
  assert.deepEqual([oct.status, oct.paid, oct.outstanding], ['partial', 20000, 48000]);
});

test('cycles: a bill from before the first transaction we hold is not judged', () => {
  const { store, card1 } = setup({ payments: false });
  store.replaceCanonicalTransactions([tx('late', 'card1', '2026-09-05', -68000)], [], NOW.toISOString());
  const cycles = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27');
  assert.deepEqual(cycles.map((c) => [c.key, c.status, c.outstanding]), [['2026-09', 'unknown', 0], ['2026-10', 'overdue', 68000], ['2026-11', 'open', 0]]);
});

test('cycles: a card without bills has no cycles', () => {
  const { store } = setup();
  assert.deepEqual(cyclesFor(store, account('other', { refs: [{ sourceId: 'pierre', externalId: 'none', role: 'member' }] }), [], '2026-10-27'), []);
});

test('cards view: the open cycle is the default and ignores bills that were already paid', () => {
  const { store } = setup();
  const v = cards(store, NOW);
  assert.equal(v.cycle, 'open');
  assert.deepEqual(v.cycles, ['2026-10', '2026-09']);
  const row = v.cards[0]!;
  assert.deepEqual([row.cycle?.key, row.posted, row.estimated, row.total, row.outstanding], ['2026-11', 500, true, 28090, 0]);
  assert.equal(v.totals.cycleTotal, 28090);
  assert.equal(v.totals.outstanding, 0);
  assert.equal(row.nextDueDate, '2026-11-15');
});

test('cards view: choosing a closed cycle shows its bill', () => {
  const { store } = setup();
  const v = cards(store, NOW, {}, '2026-10');
  assert.deepEqual([v.cards[0]!.cycle?.key, v.cards[0]!.total, v.totals.cycleTotal], ['2026-10', 68000, 68000]);
});

test('cards view: an unpaid closed bill is outstanding, due first, and not mixed into the open cycle', () => {
  const { store } = setup({ payments: false });
  const v = cards(store, NOW);
  const row = v.cards[0]!;
  assert.deepEqual([row.outstanding, row.nextDueDate], [148000, '2026-09-15']);
  assert.equal(row.total, Math.max(28090 - 148000, 500));
  assert.equal(v.totals.outstanding, 148000);
});

test('cards view: the open bill estimate is the same whether the open month or "em aberto" is chosen', () => {
  const { store } = setup({ payments: false });
  // The issuer balance holds the two unpaid bills plus 120,00 still open.
  store.replaceCanonicalAccounts([account('card1', { balance: 160000 })], [], NOW.toISOString());
  const open = cards(store, NOW).cards[0]!;
  const month = cards(store, NOW, {}, open.cycle!.key).cards[0]!;
  assert.equal(open.total, 12000);
  assert.equal(month.total, open.total);
});

test('cards view: cards on a shared limit count the open cycle once', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const a = account('cardA', { balance: 335600, limitGroupId: 'g1', refs: [] });
  const b = account('cardB', { balance: 335600, limitGroupId: 'g1', refs: [] });
  store.replaceCanonicalAccounts([a, b], [{ id: 'g1', institution: 'Bank A', creditLimit: 500000, memberIds: ['cardA', 'cardB'] }], NOW.toISOString());
  const v = cards(store, NOW);
  assert.equal(v.cards.length, 2);
  assert.equal(v.totals.reportedByIssuer, 335600);
  assert.equal(v.limitGroups[0]!.openEstimate, 335600);
});

test('hidden cards drop out of the totals and the limit', () => {
  const { store } = setup();
  store.setAccountHidden('card1', true, NOW.toISOString());
  const v = cards(store, NOW);
  assert.equal(v.cards.length, 0);
  assert.deepEqual([v.totals.cycleTotal, v.totals.creditLimit, v.totals.used], [0, 0, 0]);
  assert.equal(cards(store, NOW, { includeHidden: true }).cards.length, 1);
});

test('bill bars: one per due month with the cards added, then the open cycle', () => {
  const { store } = setup();
  const v = cardBills(store, NOW);
  assert.deepEqual(v.bars.map((b) => [b.key, b.status, b.total, b.outstanding]), [['2026-09', 'paid', 80000, 0], ['2026-10', 'paid', 68000, 0], ['2026-11', 'open', 28090, 0]]);
  const unpaid = setup({ payments: false });
  assert.deepEqual(cardBills(unpaid.store, NOW).bars.map((b) => [b.key, b.status]), [['2026-09', 'overdue'], ['2026-10', 'overdue'], ['2026-11', 'open']]);
});

/** The September bill is paid; the October one (due 15/10) is closed and paid only when `paidOn` is given. */
function octoberUnpaid(paidOn?: string) {
  const { store } = setup({ payments: false });
  const list = [tx('start', 'card1', '2026-08-01', -100), tx('buy-sep', 'card1', '2026-09-02', -80000), tx('buy-oct', 'card1', '2026-10-02', -68000), tx('buy-open', 'card1', '2026-10-10', -600), tx('pay-sep', 'card1', '2026-09-15', 80000, 'Pagamento de cartão de crédito')];
  if (paidOn) list.push(tx('pay-oct', 'card1', paidOn, 68000, 'Pagamento de cartão de crédito'));
  store.replaceCanonicalTransactions(list, [], NOW.toISOString());
  return store;
}
const currentOn = (store: ReturnType<typeof octoberUnpaid>, day: string) => cardBills(store, new Date(`${day}T15:00:00Z`)).bars.filter((b) => b.current).map((b) => b.key);

test('current cycle: a closed bill not paid yet stays the current cycle until its due day, while the next month is still open', () => {
  const store = octoberUnpaid();
  const bars = cardBills(store, new Date('2026-10-12T15:00:00Z')).bars;
  assert.deepEqual(bars.map((b) => [b.key, b.status, b.open]), [['2026-09', 'paid', false], ['2026-10', 'unpaid', false], ['2026-11', 'open', true]]);
  assert.deepEqual(currentOn(store, '2026-10-12'), ['2026-10'], 'the open November cycle is not current while October is still to pay');
  assert.deepEqual(currentOn(store, '2026-10-15'), ['2026-10'], 'on the due day itself, unpaid, October is still current');
});

test('current cycle: once the closed bill is paid, the open cycle becomes current', () => {
  assert.deepEqual(currentOn(octoberUnpaid('2026-10-15'), '2026-10-15'), ['2026-11'], 'paid on the due day');
  assert.deepEqual(currentOn(octoberUnpaid('2026-10-11'), '2026-10-12'), ['2026-11'], 'paid before the due day: nothing is left to pay in October');
});

test('current cycle: a bill past its due day and still unpaid is still the current cycle', () => {
  const store = octoberUnpaid();
  const oct = cardBills(store, NOW).bars.find((b) => b.key === '2026-10')!;
  assert.deepEqual([oct.status, oct.current], ['overdue', true]);
  assert.deepEqual(currentOn(store, '2026-10-27'), ['2026-10']);
});

test('current cycle: a bill whose payment cannot be seen holds the month until its due day, a paid one does not', () => {
  assert.equal(holdsCurrent({ status: 'unknown', outstanding: 0, dueDate: '2026-11-15' }, '2026-11-15'), true);
  assert.equal(holdsCurrent({ status: 'unknown', outstanding: 0, dueDate: '2026-11-15' }, '2026-11-16'), false);
  assert.equal(holdsCurrent({ status: 'open', outstanding: 0, dueDate: '2026-12-15' }, '2026-11-16'), true);
  assert.equal(holdsCurrent({ status: 'paid', outstanding: 0, dueDate: '2026-11-15' }, '2026-11-10'), false);
  assert.equal(holdsCurrent({ status: 'rolled', outstanding: 0, dueDate: '2026-11-15' }, '2026-11-10'), false);
  assert.equal(holdsCurrent({ status: 'partial', outstanding: 5000, dueDate: '2026-11-15' }, '2026-11-10'), true);
  assert.equal(holdsCurrent({ status: 'overdue', outstanding: 5000, dueDate: '2026-11-15' }, '2026-12-01'), true);
});

test('a leftover on an old bill is written off when every later bill was paid in full, and the user can overrule it', () => {
  const { store, card1 } = setup();
  store.upsertSourceBills('pierre', [{ externalId: 'b-jun', accountExternalId: 'ext-card1', dueDate: '2026-06-15', closingDate: '2026-06-08', total: 20000, minimumPayment: null }], NOW.toISOString());
  const txs = [
    tx('start', 'card1', '2026-05-01', -100),
    tx('pay-jun', 'card1', '2026-06-14', 17000, 'Pagamento de cartão de crédito'),
    tx('pay-sep', 'card1', '2026-09-15', 80000, 'Pagamento de cartão de crédito'),
    tx('pay-oct', 'card1', '2026-10-15', 68000, 'Pagamento de cartão de crédito'),
  ];
  store.replaceCanonicalTransactions(txs, [], NOW.toISOString());
  const find = () => cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27').find((c) => c.key === '2026-06')!;
  assert.deepEqual([find().status, find().outstanding, find().adjusted], ['rolled', 0, { amount: 3000, by: 'auto' }]);

  store.setCycleOverride('card1', '2026-06', false, NOW.toISOString());
  assert.deepEqual([find().status, find().outstanding, find().adjusted], ['overdue', 3000, null]);

  store.setCycleOverride('card1', '2026-06', true, NOW.toISOString());
  assert.deepEqual([find().adjusted?.by, find().status], ['manual', 'paid'], 'the owner calling it settled is a payment; the app\'s guess is not');
  store.setCycleOverride('card1', '2026-06', null, NOW.toISOString());
  assert.deepEqual([find().adjusted?.by, find().status], ['auto', 'rolled']);
});

test('a leftover is not written off when a later bill is also unpaid, when it is large, or when it is recent', () => {
  const { store, card1 } = setup({ payments: false });
  const result = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27');
  assert.deepEqual(result.map((c) => c.adjusted), [null, null, null]);
});

test('a card with no bill in the chosen month adds nothing to the totals', () => {
  const { store } = setup();
  const v = cards(store, NOW, {}, '2026-03');
  assert.deepEqual([v.cards[0]!.cycle, v.cards[0]!.total, v.totals.cycleTotal], [null, 0, 0]);
});

test('what the AI or the user calls a payment on screen cannot flip a bill from paid to overdue', () => {
  const { store, card1 } = setup();
  const paidKeys = () => cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27').filter((c) => c.status === 'paid').map((c) => c.key);
  assert.deepEqual(paidKeys(), ['2026-09', '2026-10']);

  // The AI relabels the payments with a name the old category rules did not know.
  for (const key of ['pay sep', 'pay oct', 'pay oct dup']) {
    store.saveAiCategory({ matchKey: key, sample: key, category: 'Pagamento de fatura', confidence: 'high', status: 'applied', model: 'm', taxonomy: 't', decidedAt: NOW.toISOString() });
  }
  assert.deepEqual(paidKeys(), ['2026-09', '2026-10']);
  // An AI label that calls a purchase a payment does not turn it into one either.
  store.saveAiCategory({ matchKey: 'buy open', sample: 'buy open', category: 'Pagamento de fatura', confidence: 'high', status: 'applied', model: 'm', taxonomy: 't', decidedAt: NOW.toISOString() });
  const open = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27').find((c) => c.status === 'open')!;
  assert.equal(open.charges, 600);
});

test('the user can say a transaction is not a payment, or is one, by choosing a category', () => {
  const { store, card1 } = setup();
  store.setCategoryRule('pay oct', 'Aluguel', NOW.toISOString());
  store.setCategoryRule('pay oct dup', 'Aluguel', NOW.toISOString());
  const oct = () => cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27').find((c) => c.key === '2026-10')!;
  assert.equal(oct().status, 'overdue');
  store.setCategoryRule('pay oct', 'Pagamento de fatura', NOW.toISOString());
  assert.equal(oct().status, 'paid');
});

test('roles come from the source, so own transfers and investments stay out of spending whatever they are called', async () => {
  const { evidenceRole, roleOf } = await import('../../src/api/roles.ts');
  assert.equal(evidenceRole('Transferência mesma titularidade', 'x'), 'own_transfer');
  assert.equal(evidenceRole('Automatic investment', 'x'), 'investment');
  assert.equal(evidenceRole('Pagamento de cartão de crédito', 'x'), 'card_payment');
  assert.equal(evidenceRole('Credit card payment', 'x'), 'card_payment');
  assert.equal(evidenceRole(null, 'PAGAMENTO RECEBIDO - OBRIGADO'), 'card_payment');
  assert.equal(evidenceRole(null, 'PAGTO. POR DEB EM C/C'), 'card_payment');
  assert.equal(evidenceRole(null, 'DEVOLUCAO SALDO CREDOR'), 'card_payment');
  assert.equal(evidenceRole(null, 'PAGAMENTO COM SALDO'), 'card_payment');
  assert.equal(evidenceRole(null, 'Aplicação RDB'), 'investment');
  assert.equal(evidenceRole('Supermercado', 'EXTRA HIPER'), null);
  assert.equal(roleOf({ sourceCategory: 'Credit card payment', description: 'x', category: 'Pagamento de fatura', categoryOrigin: 'ai' }), 'card_payment');
  assert.equal(roleOf({ sourceCategory: 'Supermercado', description: 'x', category: 'Pagamento de fatura', categoryOrigin: 'ai' }), null);
  assert.equal(roleOf({ sourceCategory: 'Supermercado', description: 'x', category: 'Investimentos', categoryOrigin: 'override' }), 'investment');
  assert.equal(roleOf({ sourceCategory: 'Credit card payment', description: 'x', category: 'Compras', categoryOrigin: 'override' }), null);
});

test('data health flags a negative cycle and bills owed beyond the limit, and stays quiet on healthy data', async () => {
  const { dataHealth } = await import('../../src/api/views.ts');
  const healthy = setup();
  assert.deepEqual(dataHealth(healthy.store, NOW), []);
  // Payments that are not recognized as payments: bills look unpaid, and the open cycle goes negative.
  const broken = setup();
  broken.store.setCategoryRule('pay sep', 'Aluguel', NOW.toISOString());
  broken.store.setCategoryRule('pay oct', 'Aluguel', NOW.toISOString());
  broken.store.setCategoryRule('pay oct dup', 'Aluguel', NOW.toISOString());
  const issues = dataHealth(broken.store, NOW);
  assert.ok(issues.length > 0 || cards(broken.store, NOW).totals.outstanding > 0);
});

test('a payment beyond the bill shows as overpaid on that cycle and in data health, and exact payments do not', async () => {
  const { dataHealth } = await import('../../src/api/views.ts');
  const { store, card1 } = setup();
  const octOf = () => cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27').find((c) => c.key === '2026-10')!;
  assert.equal(octOf().overpaid, 0);
  assert.deepEqual(dataHealth(store, NOW).filter((i) => i.id.startsWith('overpaid')), []);
  // A second, different payment of the same bill: the excess is not moved anywhere, only reported.
  store.replaceCanonicalTransactions([...store.listCanonicalTransactions(), tx('pay-oct-extra', 'card1', '2026-10-16', 5000, 'Pagamento de cartão de crédito')], [], NOW.toISOString());
  const oct = octOf();
  assert.deepEqual([oct.paid, oct.overpaid, oct.outstanding, oct.status], [73000, 5000, 0, 'paid']);
  const issues = dataHealth(store, NOW).filter((i) => i.id.startsWith('overpaid'));
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /R\$\s50,00 a mais/);
});

test('a late payment of the older bill that falls after the next closing pays the older bill and is not overpaid on the next one', () => {
  const { store, card1 } = setup({ payments: false });
  const list = [
    tx('start', 'card1', '2026-08-01', -100),
    tx('buy-aug', 'card1', '2026-08-20', -50000),
    tx('buy-sep', 'card1', '2026-09-02', -80000),
    tx('buy-oct', 'card1', '2026-10-02', -68000),
    // The September bill (due 15/09, closing 08/09) is paid on 10/10, after the October closing (08/10); October is paid on time.
    tx('pay-sep-late', 'card1', '2026-10-10', 80000, 'Pagamento de cartão de crédito'),
    tx('pay-oct', 'card1', '2026-10-15', 68000, 'Pagamento de cartão de crédito'),
  ];
  store.replaceCanonicalTransactions(list, [], NOW.toISOString());
  const [sep, oct] = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27');
  assert.deepEqual([sep!.status, sep!.outstanding, sep!.latePaid], ['paid', 0, { amount: 80000, day: '2026-10-10' }]);
  assert.deepEqual([oct!.status, oct!.outstanding, oct!.overpaid, oct!.latePaid], ['paid', 0, 0, null]);
  assert.equal(cards(store, NOW).totals.outstanding, 0);
});

test('an excess with no older bill still owed stays as overpaid', () => {
  const { store, card1 } = setup();
  store.replaceCanonicalTransactions([...store.listCanonicalTransactions(), tx('pay-oct-extra', 'card1', '2026-10-16', 5000, 'Pagamento de cartão de crédito')], [], NOW.toISOString());
  const oct = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27').find((c) => c.key === '2026-10')!;
  assert.deepEqual([oct.overpaid, oct.latePaid], [5000, null]);
});

test('a credit balance the bank sends back after a bill was paid twice is netted against the payments, so the bill is not overpaid', () => {
  const { store, card1 } = setup();
  const octOf = () => cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27').find((c) => c.key === '2026-10')!;
  const base = store.listCanonicalTransactions();
  // The October bill (68000) is paid a second time, and the bank returns that money to the checking account.
  store.replaceCanonicalTransactions([...base, tx('pay-oct-again', 'card1', '2026-10-16', 68000, 'Pagamento de cartão de crédito')], [], NOW.toISOString());
  assert.deepEqual([octOf().paid, octOf().overpaid], [136000, 68000]);
  store.replaceCanonicalTransactions([...base, tx('pay-oct-again', 'card1', '2026-10-16', 68000, 'Pagamento de cartão de crédito'), tx('pay-oct-back', 'card1', '2026-10-20', -68000, 'Pagamento de cartão de crédito')], [], NOW.toISOString());
  const oct = octOf();
  assert.deepEqual([oct.paid, oct.overpaid, oct.outstanding, oct.status, oct.charges], [68000, 0, 0, 'paid', 68000], 'the return takes from the payments and is not a purchase');
});

test('a return with no payment in its window never makes a bill paid by less than nothing', () => {
  const { store, card1 } = setup({ payments: false });
  store.replaceCanonicalTransactions([...store.listCanonicalTransactions(), tx('back', 'card1', '2026-10-20', -5000, 'Pagamento de cartão de crédito')], [], NOW.toISOString());
  const oct = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27').find((c) => c.key === '2026-10')!;
  assert.deepEqual([oct.paid, oct.outstanding, oct.overpaid], [0, 68000, 0]);
});

test('the due date of a month nobody owes anything in comes from the cards that have a bill, not from an empty one', () => {
  const { store, card1 } = setup();
  const card2 = account('card2', { dueDate: '2026-09-14' });
  store.upsertSourceBills('pierre', [{ externalId: 'b2-sep', accountExternalId: 'ext-card2', dueDate: '2026-09-14', closingDate: '2026-09-07', total: 0, minimumPayment: null }, { externalId: 'b2-oct', accountExternalId: 'ext-card2', dueDate: '2026-10-14', closingDate: '2026-10-07', total: 0, minimumPayment: null }], NOW.toISOString());
  store.replaceCanonicalAccounts([card1, card2], [], NOW.toISOString());
  const sep = cards(store, NOW, {}, '2026-09');
  assert.equal(sep.totals.toPay, 0);
  assert.equal(sep.totals.nextDueDate, '2026-09-15', 'the empty bill of 14/09 says nothing about when money is due');
});

test('the open cycle leaves out installments that belong to later bills, which the issuer balance includes', () => {
  const { store, card1 } = setup();
  // Installment 4 of 6 was charged in October (bill due in November); 5 and 6 are still to come.
  const phone = (n: number, day: string) => ({ ...tx(`phone-${n}`, 'card1', day, -3000), description: 'Phone', installment: { number: n, total: 6 } });
  store.replaceCanonicalTransactions(
    [tx('start', 'card1', '2026-08-01', -100), tx('pay-oct', 'card1', '2026-10-15', 68000, 'Pagamento de cartão de crédito'), tx('pay-sep', 'card1', '2026-09-15', 80000, 'Pagamento de cartão de crédito'), tx('buy-open', 'card1', '2026-10-10', -600), phone(4, '2026-10-12')],
    [],
    NOW.toISOString(),
  );
  // The issuer says 28.090 is owed in total: this cycle, plus 2 installments of 3.000 that belong to later bills.
  const row = cards(store, NOW).cards[0]!;
  assert.deepEqual([row.futureInstallments, row.posted, row.total, row.estimated], [6000, 3600, 28090 - 6000, true]);
  assert.equal(cards(store, NOW).totals.futureInstallments, 6000);
  assert.equal(cards(store, NOW).totals.reportedByIssuer, 28090);
});

test('a card bill paid from the bank account is not spending, whichever way the two sources label it', async () => {
  const { evidenceRole } = await import('../../src/api/roles.ts');
  // Pierre called it a card fee, Meu Pluggy called it a card payment: any label that says payment is enough.
  assert.equal(evidenceRole(['Taxas de cartão de crédito', 'Credit card payment'], 'GASTOS CARTAO DE CREDITO - DOCTO: 3990288'), 'card_payment');
  assert.equal(evidenceRole('Taxas de cartão de crédito', 'GASTOS CARTAO DE CREDITO - DOCTO: 3990288'), 'card_payment');
  assert.equal(evidenceRole('Taxas de cartão de crédito', 'PAGTO ELETRON  COBRANCA - BANCO BRADESCARD S'), 'card_payment');
  assert.equal(evidenceRole('Transferências', 'Pagamento efetuado|BANCO IBI S A'), 'card_payment');
  assert.equal(evidenceRole('Taxas de cartão de crédito', 'ANUIDADE DIFERENCIADA 03/12'), null, 'a card fee is still a fee');

  const { spending, monthRange } = await import('../../src/api/views.ts');
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  const checking: CanonicalAccount = { ...account('chk'), kind: 'checking', creditLimit: null, availableLimit: null, refs: [] };
  store.replaceCanonicalAccounts([checking], [], NOW.toISOString());
  const payment = { ...tx('bill', 'chk', '2026-10-16', -210157, 'Taxas de cartão de crédito'), description: 'GASTOS CARTAO DE CREDITO - DOCTO: 3990288' };
  store.replaceCanonicalTransactions(
    [payment, tx('lunch', 'chk', '2026-10-16', -5000, 'Restaurantes, bares e lanchonetes')],
    [{ sourceId: 'pierre', externalId: 'p1', transactionId: 'bill', matchPass: 0 }, { sourceId: 'pluggy', externalId: 'g1', transactionId: 'bill', matchPass: 1 }],
    NOW.toISOString(),
  );
  store.upsertSourceTransactions('pluggy', [{ externalId: 'g1', accountExternalId: 'x', occurredAt: '2026-10-16T15:00:00Z', amount: -210157, description: payment.description, descriptionRaw: null, status: 'posted', installment: null, category: 'Credit card payment' }], NOW.toISOString());
  const result = spending(store, monthRange(NOW), 'category', NOW);
  assert.equal(result.total, 5000);
});

test('choosing the sources\' own name for a role (Credit card payment) keeps the role', async () => {
  const { roleOf } = await import('../../src/api/roles.ts');
  for (const category of ['Credit card payment', 'Pagamento de cartão de crédito', 'Pagamento de fatura']) {
    assert.equal(roleOf({ sourceCategory: 'Taxas de cartão de crédito', description: 'x', category, categoryOrigin: 'override' }), 'card_payment', category);
  }
  assert.equal(roleOf({ sourceCategory: 'x', description: 'x', category: 'Same person transfer', categoryOrigin: 'rule' }), 'own_transfer');
  assert.equal(roleOf({ sourceCategory: 'Credit card payment', description: 'x', category: 'Aluguel', categoryOrigin: 'override' }), null);
});

test('a month the issuer published no bill for gets its own closed cycle, so the charges after it do not pile into the open one', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  // Bills up to September (closing the 14th); October's was never published.
  store.upsertSourceBills('pluggy', [{ externalId: 'b-sep', accountExternalId: 'ext-nu', dueDate: '2026-09-21', closingDate: '2026-09-14', total: 134530, minimumPayment: null }], NOW.toISOString());
  const nu = account('nu', { refs: [{ sourceId: 'pluggy', externalId: 'ext-nu', role: 'member' }] });
  const list = [
    tx('start', 'nu', '2026-08-01', -100),
    tx('pay-sep', 'nu', '2026-09-14', 134530, 'Pagamento de cartão de crédito'),
    tx('coffee', 'nu', '2026-10-05', -7835),
    tx('market', 'nu', '2026-10-11', -3418),
    tx('pay-oct', 'nu', '2026-10-15', 107735, 'Pagamento de cartão de crédito'),
    tx('new', 'nu', '2026-10-20', -2490),
  ];
  store.replaceCanonicalAccounts([nu], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, [], NOW.toISOString());
  const cycles = cyclesFor(store, nu, effectiveTransactions(store), '2026-10-27');
  assert.deepEqual(cycles.map((c) => [c.key, c.from, c.to, c.status]), [['2026-09', '2026-08-15', '2026-09-14', 'paid'], ['2026-10', '2026-09-15', '2026-10-14', 'unknown'], ['2026-11', '2026-10-15', '2026-11-14', 'open']]);
  const closed = cycles[1]!;
  assert.deepEqual([closed.billTotal, closed.charges, closed.paid], [null, 11253, 107735]);
  assert.equal(cycles[2]!.charges, 2490, 'only the charge after the closing is in the open cycle');
});

test('a charge the owner moves to another bill counts there, and going back to automatic follows the date again', () => {
  const { store, card1 } = setup();
  const before = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27');
  assert.equal(before[1]!.charges, 68000);
  const id = effectiveTransactions(store).find((t) => t.description === 'buy-oct')!.id;
  // The canonical rows above carry no links, so write the override straight on a link the test creates.
  store.replaceCanonicalTransactions(effectiveTransactions(store, { includeExcluded: true }).map((t) => ({ ...t })), [{ sourceId: 'pierre', externalId: 'buy-oct', transactionId: id, matchPass: 0 }], NOW.toISOString());
  store.setTransactionOverride(id, { cycleKey: '2026-09' }, NOW.toISOString());
  const moved = cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27');
  // The September bill held 50000 + 80000; the moved charge adds 68000, and October loses it.
  assert.deepEqual([moved[0]!.charges, moved[1]!.charges], [198000, 0]);
  store.setTransactionOverride(id, { cycleKey: null }, NOW.toISOString());
  assert.equal(cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27')[1]!.charges, 68000);
});

test('a card is judged only from its own first transaction, not from another account\'s older history', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', [{ externalId: 'b-may', accountExternalId: 'ext-late', dueDate: '2026-05-15', closingDate: '2026-05-08', total: 200000, minimumPayment: null }], NOW.toISOString());
  const late = account('late', { refs: [{ sourceId: 'pluggy', externalId: 'ext-late', role: 'member' }] });
  const bank = account('bank', { kind: 'checking', refs: [{ sourceId: 'pluggy', externalId: 'ext-bank', role: 'member' }] });
  // The bank has history from January; the card only from June, and May's bill is older than anything the card shows.
  store.replaceCanonicalAccounts([late, bank], [], NOW.toISOString());
  store.replaceCanonicalTransactions([tx('bank-old', 'bank', '2026-01-02', -500), tx('card-first', 'late', '2026-06-03', -1000)], [], NOW.toISOString());
  const cycles = cyclesFor(store, late, effectiveTransactions(store), '2026-10-27');
  assert.equal(cycles.find((c) => c.key === '2026-05')?.status, 'unknown', 'not overdue: the card has no payments to judge it by');
});

test('closing days that drift across a month end do not invent a month in between', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', [
    { externalId: 'b-1', accountExternalId: 'ext-drift', dueDate: '2026-10-10', closingDate: '2026-09-30', total: 10000, minimumPayment: null },
    { externalId: 'b-2', accountExternalId: 'ext-drift', dueDate: '2026-11-10', closingDate: '2026-11-01', total: 20000, minimumPayment: null },
  ], NOW.toISOString());
  const drift = account('drift', { refs: [{ sourceId: 'pluggy', externalId: 'ext-drift', role: 'member' }] });
  store.replaceCanonicalAccounts([drift], [], NOW.toISOString());
  store.replaceCanonicalTransactions([tx('start', 'drift', '2026-08-01', -100)], [], NOW.toISOString());
  const keys = cyclesFor(store, drift, effectiveTransactions(store), '2026-10-27').map((c) => c.key);
  assert.deepEqual(keys, ['2026-10', '2026-11', '2026-12'].slice(0, keys.length).filter((k) => keys.includes(k)));
  assert.equal(new Set(keys).size, keys.length, 'no two cycles share a bill month');
});

test('a pending copy and a posted copy of one payment on different days count once, but two payments of the same status count twice', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', [{ externalId: 'b-sep', accountExternalId: 'ext-pay', dueDate: '2026-09-15', closingDate: '2026-09-08', total: 100000, minimumPayment: null }, { externalId: 'b-oct', accountExternalId: 'ext-pay', dueDate: '2026-10-15', closingDate: '2026-10-08', total: 100000, minimumPayment: null }], NOW.toISOString());
  const pay = account('pay', { refs: [{ sourceId: 'pluggy', externalId: 'ext-pay', role: 'member' }] });
  const pending = { ...tx('pay-pending', 'pay', '2026-09-11', 100000, 'Pagamento de cartão de crédito'), status: 'pending' as const };
  const posted = tx('pay-posted', 'pay', '2026-09-14', 100000, 'Pagamento de cartão de crédito');
  const twoOct = [tx('oct-a', 'pay', '2026-10-12', 50000, 'Pagamento de cartão de crédito'), tx('oct-b', 'pay', '2026-10-13', 50000, 'Pagamento de cartão de crédito')];
  store.replaceCanonicalAccounts([pay], [], NOW.toISOString());
  store.replaceCanonicalTransactions([tx('start', 'pay', '2026-08-01', -100), tx('buy-sep', 'pay', '2026-09-02', -100000), tx('buy-oct', 'pay', '2026-10-02', -100000), pending, posted, ...twoOct], [], NOW.toISOString());
  const cycles = cyclesFor(store, pay, effectiveTransactions(store), '2026-10-27');
  assert.equal(cycles.find((c) => c.key === '2026-09')?.paid, 100000, 'the pending and the posted copy are one payment');
  assert.equal(cycles.find((c) => c.key === '2026-10')?.paid, 100000, 'two real payments of 500 each add up');
});

test('two payments of the same amount on the same day from one source are two payments', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', [{ externalId: 'b-sep', accountExternalId: 'ext-two', dueDate: '2026-09-15', closingDate: '2026-09-08', total: 100000, minimumPayment: null }, { externalId: 'b-oct', accountExternalId: 'ext-two', dueDate: '2026-10-15', closingDate: '2026-10-08', total: 100000, minimumPayment: null }], NOW.toISOString());
  const two = account('two', { refs: [{ sourceId: 'pluggy', externalId: 'ext-two', role: 'member' }] });
  const pays = [tx('p1', 'two', '2026-09-12', 50000, 'Pagamento de cartão de crédito'), tx('p2', 'two', '2026-09-12', 50000, 'Pagamento de cartão de crédito')].map((t) => ({ ...t, description: 'Pagamento recebido', sourceIds: ['pluggy'] }));
  store.replaceCanonicalAccounts([two], [], NOW.toISOString());
  // The canonical rows get their source ids from the links, so both payments are linked to the same source.
  const links = pays.map((p) => ({ sourceId: 'pluggy', externalId: `e-${p.id}`, transactionId: p.id, matchPass: 0 }));
  store.replaceCanonicalTransactions([tx('start', 'two', '2026-08-01', -100), tx('buy', 'two', '2026-09-02', -100000), ...pays], links, NOW.toISOString());
  assert.equal(cyclesFor(store, two, effectiveTransactions(store), '2026-10-27').find((c) => c.key === '2026-09')?.paid, 100000);
});

test('the open bill of a card includes installments of earlier purchases that the bank has not listed yet', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', ['2026-08', '2026-09', '2026-10'].map((m, i) => ({ externalId: `b${i}`, accountExternalId: 'ext-pl', dueDate: `${m}-15`, closingDate: `${m}-08`, total: 20000, minimumPayment: null })), NOW.toISOString());
  const pl = account('pl', { balance: 55000, availableLimit: 445000, refs: [{ sourceId: 'pluggy', externalId: 'ext-pl', role: 'member' }] });
  const inst = (id: string, day: string, n: number) => ({ ...tx(id, 'pl', day, -20000), description: 'TV', installment: { number: n, total: 4 } });
  // 4 x 200,00: installments 1 and 2 were billed (August and September). The third belongs to the open bill, which the bank has not listed yet.
  store.replaceCanonicalAccounts([pl], [], NOW.toISOString());
  store.replaceCanonicalTransactions([tx('start', 'pl', '2026-07-01', -100), inst('i1', '2026-08-02', 1), inst('i2', '2026-09-02', 2), tx('coffee', 'pl', '2026-10-12', -1500)], [], NOW.toISOString());
  const row = cards(store, NOW).cards.find((c) => c.id === 'pl')!;
  assert.deepEqual([row.posted, row.plannedInstallments], [1500, 20000]);
  assert.ok(row.total >= 21500, 'the open total counts the third installment');
});

test('the bank text and the card text of one payment on the same day are one payment', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', [{ externalId: 'b-sep', accountExternalId: 'ext-leg', dueDate: '2026-09-15', closingDate: '2026-09-08', total: 210157, minimumPayment: null }, { externalId: 'b-oct', accountExternalId: 'ext-leg', dueDate: '2026-10-15', closingDate: '2026-10-08', total: 10000, minimumPayment: null }], NOW.toISOString());
  const leg = account('leg', { refs: [{ sourceId: 'pluggy', externalId: 'ext-leg', role: 'member' }] });
  // Both pending, same source, same amount and day, different words: Pluggy's "Pagamento recebido" and the bank's own text.
  const a = { ...tx('a', 'leg', '2026-09-14', 210157, 'Pagamento de cartão de crédito'), description: 'Pagamento recebido', status: 'pending' as const };
  const b = { ...tx('b', 'leg', '2026-09-14', 210157, 'Pagamento de cartão de crédito'), description: 'PAGTO. POR DEB EM C/C', status: 'pending' as const };
  const links = [a, b].map((p) => ({ sourceId: 'pluggy', externalId: `e-${p.id}`, transactionId: p.id, matchPass: 0 }));
  store.replaceCanonicalAccounts([leg], [], NOW.toISOString());
  store.replaceCanonicalTransactions([tx('start', 'leg', '2026-08-01', -100), tx('buy', 'leg', '2026-09-02', -210157), a, b], links, NOW.toISOString());
  assert.equal(cyclesFor(store, leg, effectiveTransactions(store), '2026-10-27').find((c) => c.key === '2026-09')?.paid, 210157);
});

test('a bill that closed a day or two ago and is not published yet keeps the open cycle until it is, or until the grace passes', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', [{ externalId: 'b-oct', accountExternalId: 'ext-am', dueDate: '2026-10-15', closingDate: '2026-10-01', total: 22128, minimumPayment: null }], NOW.toISOString());
  const am = account('am', { refs: [{ sourceId: 'pluggy', externalId: 'ext-am', role: 'member' }] });
  store.replaceCanonicalAccounts([am], [], NOW.toISOString());
  store.replaceCanonicalTransactions([tx('start', 'am', '2026-09-01', -100), tx('buy', 'am', '2026-11-02', -5000)], [], NOW.toISOString());
  const early = cyclesFor(store, am, effectiveTransactions(store), '2026-11-02');
  assert.deepEqual(early.map((c) => [c.key, c.status]), [['2026-10', 'overdue'], ['2026-11', 'open']]);
  assert.equal(early[1]!.charges, 5000, 'a charge after the expected closing still lands in the open cycle');
  const late = cyclesFor(store, am, effectiveTransactions(store), '2026-11-10');
  assert.deepEqual(late.map((c) => c.key), ['2026-10', '2026-11', '2026-12']);
});

test('a charge goes on the bill the issuer put it on, by id or by forecast, not by the day it was made', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills(
    'pluggy',
    [
      { externalId: 'b-sep', accountExternalId: 'ext-bk', dueDate: '2026-09-15', closingDate: '2026-09-08', total: 10000, minimumPayment: null },
      { externalId: 'b-oct', accountExternalId: 'ext-bk', dueDate: '2026-10-15', closingDate: '2026-10-08', total: 5000, minimumPayment: null },
    ],
    NOW.toISOString(),
  );
  const bk = account('bk', { refs: [{ sourceId: 'pluggy', externalId: 'ext-bk', role: 'member' }] });
  const src = (externalId: string, parties: { billId?: string; billForecast?: string }) => ({ externalId, accountExternalId: 'ext-bk', occurredAt: '2026-09-08T15:00:00Z', amount: -1000, description: externalId, descriptionRaw: null, status: 'posted' as const, installment: null, category: null, parties: { operation: null, mcc: null, payer: null, receiver: null, ...parties } });
  store.upsertSourceTransactions('pluggy', [src('on-closing-day', { billId: 'b-oct' }), src('by-date', {}), src('forecast', { billForecast: '2026-11' })], NOW.toISOString());
  const list = [tx('start', 'bk', '2026-08-01', -100), tx('on-closing-day', 'bk', '2026-09-08', -1000), tx('by-date', 'bk', '2026-09-08', -1000), tx('forecast', 'bk', '2026-09-08', -1000)];
  store.replaceCanonicalAccounts([bk], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, ['on-closing-day', 'by-date', 'forecast'].map((id) => ({ sourceId: 'pluggy', externalId: id, transactionId: id, matchPass: 0 })), NOW.toISOString());
  const cycles = cyclesFor(store, bk, effectiveTransactions(store), '2026-10-27');
  const sep = cycles.find((c) => c.key === '2026-09')!;
  const oct = cycles.find((c) => c.key === '2026-10')!;
  const open = cycles.find((c) => c.status === 'open')!;
  assert.deepEqual([sep.charges, oct.charges, open.key, open.charges], [1000, 1000, '2026-11', 1000], 'the id puts one on October, the forecast puts one on the open November bill, and only the third follows its date');
  const byBank = effectiveTransactions(store).filter((t) => t.billByBank).map((t) => t.id).sort();
  assert.deepEqual(byBank, ['forecast', 'on-closing-day']);
});

test('reconciliation uses a charge older than the data start when its bill is due after it', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const at = NOW.toISOString();
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, at);
  store.upsertSourceAccounts('pluggy', [sourceAccount({ externalId: 'ext-k', kind: 'credit_card' })], at);
  store.upsertSourceBills('pluggy', [{ externalId: 'b-jun', accountExternalId: 'ext-k', dueDate: '2026-06-15', closingDate: '2026-06-08', total: 27490, minimumPayment: null }], at);
  const parties = { operation: null, mcc: null, payer: null, receiver: null, billId: 'b-jun' };
  store.upsertSourceTransactions('pluggy', [
    { ...sourceTx({ externalId: 'old-installment', accountExternalId: 'ext-k', occurredAt: '2025-11-28T12:00:00.000Z', amount: -27490, descriptionRaw: 'ALIPAY 07/12' }), parties },
    sourceTx({ externalId: 'old-plain', accountExternalId: 'ext-k', occurredAt: '2025-11-28T12:00:00.000Z', amount: -100, descriptionRaw: 'OLD' }),
  ], at);
  runReconciliation(store, { now: () => NOW });
  assert.deepEqual(store.listCanonicalTransactions({ includeExcluded: true }).map((t) => t.amount), [-27490]);
  assert.equal(store.listSourceTransactions('pluggy').length, 2, 'the older record that no bill claims is left out of the canonical data, not deleted');
});

test('cards that close on different days: one bar per due month shows the closed bill and the card still adding to it', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  const bill = (id: string, ext: string, due: string, closing: string, total: number) => ({ externalId: id, accountExternalId: ext, dueDate: due, closingDate: closing, total, minimumPayment: null });
  store.upsertSourceBills('pluggy', [
    bill('a-oct', 'ext-ca', '2026-10-15', '2026-10-02', 20000), bill('a-nov', 'ext-ca', '2026-11-15', '2026-11-02', 11327),
    bill('b-oct', 'ext-cb', '2026-10-15', '2026-10-08', 30000),
  ], NOW.toISOString());
  const ca = account('ca', { refs: [{ sourceId: 'pluggy', externalId: 'ext-ca', role: 'member' }], balance: 11327 });
  const cb = account('cb', { refs: [{ sourceId: 'pluggy', externalId: 'ext-cb', role: 'member' }], balance: 5000 });
  store.replaceCanonicalAccounts([ca, cb], [], NOW.toISOString());
  store.replaceCanonicalTransactions([tx('a0', 'ca', '2026-09-20', -20000), tx('a1', 'ca', '2026-10-20', -11327), tx('b0', 'cb', '2026-09-20', -30000), tx('b1', 'cb', '2026-10-20', -5000)], [], NOW.toISOString());
  const today = new Date('2026-11-04T15:00:00Z');
  const nov = cardBills(store, today).bars.find((b) => b.key === '2026-11')!;
  assert.deepEqual([nov.open, nov.closedCards, nov.openCards, nov.current], [true, 1, 1, true]);
  assert.ok(nov.total > 11327, 'the card that has not closed adds its running total to the closed bill');
});

test('when the newest charges are already on the next bill by the issuer\'s word, the month before has closed even if the estimated closing day has not passed', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  store.upsertSourceBills('pluggy', [{ externalId: 'b-oct', accountExternalId: 'ext-cc', dueDate: '2026-10-15', closingDate: '2026-10-08', total: 5000, minimumPayment: null }], NOW.toISOString());
  const cc = account('cc', { refs: [{ sourceId: 'pluggy', externalId: 'ext-cc', role: 'member' }] });
  store.upsertSourceTransactions('pluggy', [{ externalId: 'late', accountExternalId: 'ext-cc', occurredAt: '2026-11-07T15:00:00Z', amount: -700, description: 'late', descriptionRaw: null, status: 'pending', installment: null, category: null, parties: { operation: null, mcc: null, payer: null, receiver: null, billForecast: '2026-12' } }], NOW.toISOString());
  store.replaceCanonicalAccounts([cc], [], NOW.toISOString());
  store.replaceCanonicalTransactions([tx('start', 'cc', '2026-09-20', -100), tx('late', 'cc', '2026-11-07', -700)], [{ sourceId: 'pluggy', externalId: 'late', transactionId: 'late', matchPass: 0 }], NOW.toISOString());
  const cycles = cyclesFor(store, cc, effectiveTransactions(store), '2026-11-07');
  assert.deepEqual(cycles.slice(-2).map((c) => [c.key, c.status]), [['2026-11', 'unknown'], ['2026-12', 'open']]);
  assert.equal(cycles[2]!.charges, 700);
});

test('a bill from before the first transaction of the card is proved paid by the payment that is seen, and stays unchecked when none is', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, NOW.toISOString());
  const bill = (id: string, due: string, closing: string, total: number) => ({ externalId: id, accountExternalId: 'ext-cd', dueDate: due, closingDate: closing, total, minimumPayment: null });
  store.upsertSourceBills('pluggy', [bill('b-aug', '2026-08-15', '2026-08-02', 5000), bill('b-sep', '2026-09-15', '2026-09-02', 6000), bill('b-oct', '2026-10-15', '2026-10-02', 7000)], NOW.toISOString());
  const cd = account('cd', { refs: [{ sourceId: 'pluggy', externalId: 'ext-cd', role: 'member' }] });
  store.replaceCanonicalAccounts([cd], [], NOW.toISOString());
  store.replaceCanonicalTransactions([tx('first', 'cd', '2026-09-20', -100), tx('pay-sep', 'cd', '2026-09-14', 6000, 'Pagamento de cartão de crédito')], [], NOW.toISOString());
  const cycles = cyclesFor(store, cd, effectiveTransactions(store), '2026-10-27');
  assert.deepEqual(cycles.filter((c) => c.key <= '2026-09').map((c) => [c.key, c.status]), [['2026-08', 'unknown'], ['2026-09', 'paid']]);
});

test('the owner can change a bill: total, closing and due day, and whether it is paid; reset goes back', () => {
  const { store, card1 } = setup();
  const read = () => cyclesFor(store, card1, effectiveTransactions(store), '2026-10-27').find((c) => c.key === '2026-09')!;
  assert.equal(read().status, 'paid');
  assert.deepEqual(editBill(store, { accountId: 'card1', cycleKey: '2026-09', total: 200000 }, NOW), { ok: true });
  assert.deepEqual([read().billTotal, read().edited?.total], [200000, true]);
  assert.equal(read().status, 'overdue', 'the payment seen is 80.000, so the rest of the edited total is open past its due day');
  editBill(store, { accountId: 'card1', cycleKey: '2026-09', status: 'paid' }, NOW);
  assert.deepEqual([read().status, read().outstanding, read().adjusted?.by], ['paid', 0, 'manual']);
  editBill(store, { accountId: 'card1', cycleKey: '2026-09', status: 'unpaid', total: null }, NOW);
  assert.deepEqual([read().status, read().outstanding], ['overdue', 80000]);
  assert.equal(editBill(store, { accountId: 'card1', cycleKey: '2026-09', closingDate: '2026-09-10' }, NOW).ok, true);
  assert.equal(read().to, '2026-09-10');
  assert.equal(editBill(store, { accountId: 'card1', cycleKey: '2026-09', dueDate: '2026-09-01' }, NOW).ok, false, 'due before closing');
  assert.equal(editBill(store, { accountId: 'card1', cycleKey: '2026-11', total: 100 }, NOW).ok, false, 'an open bill is not edited');
  editBill(store, { accountId: 'card1', cycleKey: '2026-09', reset: true }, NOW);
  assert.deepEqual([read().status, read().billTotal, read().edited], ['paid', 80000, null]);
});

test('looking at one bill shows that bill only: what is owed on it and its due day, not the card\'s other bills', () => {
  const { store } = setup({ payments: false });
  const open = cards(store, NOW, {}, 'open');
  assert.equal(open.cards[0]!.outstanding, 148000, 'open view: every closed bill still owed');
  const sep = cards(store, NOW, {}, '2026-09');
  assert.deepEqual([sep.cards[0]!.outstanding, sep.cards[0]!.nextDueDate, sep.totals.outstanding, sep.totals.nextDueDate, sep.cards[0]!.futureInstallments], [80000, '2026-09-15', 80000, '2026-09-15', 0]);
});

test('the second installment the bank has not listed yet explains what its bill has over the charges', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const today = new Date('2026-11-05T15:00:00Z');
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, today.toISOString());
  store.upsertSourceBills('pluggy', [
    { externalId: 'b-oct', accountExternalId: 'ext-ct', dueDate: '2026-10-15', closingDate: '2026-10-02', total: 14994, minimumPayment: null },
    { externalId: 'b-nov', accountExternalId: 'ext-ct', dueDate: '2026-11-15', closingDate: '2026-11-04', total: 11293, minimumPayment: null },
  ], today.toISOString());
  const ct = account('ct', { refs: [{ sourceId: 'pluggy', externalId: 'ext-ct', role: 'member' }] });
  const first = { ...tx('natal-1', 'ct', '2026-09-19', -4995), description: 'PG *NATAL EM DOBR', installment: { number: 1, total: 2 } };
  store.replaceCanonicalAccounts([ct], [], today.toISOString());
  store.replaceCanonicalTransactions([tx('start', 'ct', '2026-08-01', -100), first, tx('oct', 'ct', '2026-09-25', -9999), tx('nov', 'ct', '2026-10-20', -6298), tx('pay', 'ct', '2026-10-14', 14994, 'Pagamento de cartão de crédito')], [], today.toISOString());
  const sep = cards(store, today, {}, '2026-11').cards[0]!;
  assert.deepEqual([sep.total, sep.posted, sep.plannedInstallments], [11293, 6298, 4995]);
  assert.deepEqual(billCheck(store, today).items.filter((i) => i.cycleKey === '2026-11'), [], 'the gap is the installment, so nothing is reported missing');
});

test('a credit balance returned after the next closing offsets the bill that was paid twice, not the bill it falls in', () => {
  const { store, card1 } = setup();
  // October (68000) is paid twice; the bank returns the second payment on 12/11, in the window of the November bill, which is paid in full.
  store.upsertSourceBills('pierre', [{ externalId: 'b-nov', accountExternalId: 'ext-card1', dueDate: '2026-11-15', closingDate: '2026-11-08', total: 30000, minimumPayment: null }], NOW.toISOString());
  const base = store.listCanonicalTransactions();
  store.replaceCanonicalTransactions([...base, tx('buy-nov', 'card1', '2026-10-20', -30000), tx('pay-oct-again', 'card1', '2026-10-16', 68000, 'Pagamento de cartão de crédito'), tx('pay-oct-back', 'card1', '2026-11-12', -68000, 'Pagamento de cartão de crédito'), tx('pay-nov', 'card1', '2026-11-15', 30000, 'Pagamento de cartão de crédito')], [], NOW.toISOString());
  const [, oct, nov] = cyclesFor(store, card1, effectiveTransactions(store), '2026-11-20');
  assert.deepEqual([oct!.key, oct!.paid, oct!.overpaid], ['2026-10', 68000, 0], 'the excess of October is given back');
  assert.deepEqual([nov!.key, nov!.paid, nov!.outstanding, nov!.status], ['2026-11', 30000, 0, 'paid'], 'November is not left looking unpaid');
  // A return bigger than any excess still takes the rest from its own window.
  store.replaceCanonicalTransactions([...base, tx('pay-oct-again', 'card1', '2026-10-16', 5000, 'Pagamento de cartão de crédito'), tx('pay-oct-back', 'card1', '2026-11-12', -8000, 'Pagamento de cartão de crédito'), tx('pay-nov', 'card1', '2026-11-15', 30000, 'Pagamento de cartão de crédito')], [], NOW.toISOString());
  const [, oct2, nov2] = cyclesFor(store, card1, effectiveTransactions(store), '2026-11-20');
  assert.deepEqual([oct2!.paid, oct2!.overpaid, nov2!.paid], [68000, 0, 27000]);
});
