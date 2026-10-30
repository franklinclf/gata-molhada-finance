import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { addDays, addMonthsToDay, cyclesFor, isCardPayment } from '../../src/api/cycles.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { cardBills, cards } from '../../src/api/views.ts';
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
    list.push(tx('pay-oct-dup', 'card1', '2026-10-15', 68000, 'Credit card payment'));
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
  assert.deepEqual(v.bars.map((b) => [b.key, b.status, b.total, b.outstanding]), [['2026-09', 'paid', 80000, 0], ['2026-10', 'paid', 68000, 0], ['open', 'open', 28090, 0]]);
  const unpaid = setup({ payments: false });
  assert.deepEqual(cardBills(unpaid.store, NOW).bars.map((b) => [b.key, b.status]), [['2026-09', 'overdue'], ['2026-10', 'overdue'], ['open', 'open']]);
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
  assert.deepEqual([find().status, find().outstanding, find().adjusted], ['paid', 0, { amount: 3000, by: 'auto' }]);

  store.setCycleOverride('card1', '2026-06', false, NOW.toISOString());
  assert.deepEqual([find().status, find().outstanding, find().adjusted], ['overdue', 3000, null]);

  store.setCycleOverride('card1', '2026-06', true, NOW.toISOString());
  assert.equal(find().adjusted?.by, 'manual');
  store.setCycleOverride('card1', '2026-06', null, NOW.toISOString());
  assert.equal(find().adjusted?.by, 'auto');
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
