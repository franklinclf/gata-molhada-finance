import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { CanonicalAccount, CanonicalTransaction } from '../../src/core/canonical.ts';
import { toolByName } from '../../src/ai/analyst-tools.ts';
import { forecast } from '../../src/api/forecast.ts';
import { cards } from '../../src/api/views.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-28T15:00:00Z');

const card: CanonicalAccount = {
  id: 'c1', institution: 'Bank', kind: 'credit_card', name: 'Card', last4: '1234', balance: 160000, balanceSourceId: 'pierre', balanceAsOf: NOW.toISOString(),
  creditLimit: 500000, availableLimit: 340000, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pierre', externalId: 'ext-c1', role: 'member' }],
};
const tx = (id: string, day: string, amount: number, description: string, installment: { number: number; total: number } | null = null, category: string | null = null): CanonicalTransaction => ({
  id, accountId: 'c1', occurredAt: `${day}T15:00:00Z`, amount, description, descriptionRaw: null, status: 'posted', installment, category, state: 'confirmed', sourceIds: ['pierre'], excluded: false,
});

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'test', capabilities: {} }, NOW.toISOString());
  // The September bill (due 15/09) was not paid; the October bill (due 15/10) was.
  store.upsertSourceBills('pierre', ['2026-07', '2026-08', '2026-09', '2026-10'].map((m, i) => ({ externalId: `b${i}`, accountExternalId: 'ext-c1', dueDate: `${m}-15`, closingDate: `${m}-08`, total: 50000, minimumPayment: null })), NOW.toISOString());
  const list: CanonicalTransaction[] = [tx('start', '2026-05-20', -100, 'Coffee')];
  ['06-20', '07-20', '08-20', '09-20', '10-20'].forEach((d, i) => list.push(tx(`netflix-${i}`, `2026-${d}`, -3990, 'NETFLIX.COM')));
  for (const m of ['07', '08', '10']) list.push(tx(`pay-${m}`, `2026-${m}-14`, 50000, 'Pagamento recebido', null, 'Credit card payment'));
  store.replaceCanonicalAccounts([card], [], NOW.toISOString());
  store.replaceCanonicalTransactions(list, [], NOW.toISOString());
  return store;
}

const run = (name: string, store: ReturnType<typeof seeded>) => toolByName.get(name)!.run(store, NOW, {}) as Record<string, any>;

test('the cards tool gives what is left to pay, by due month and by card, with the same figures as the screen', () => {
  const store = seeded();
  const screen = cards(store, NOW);
  const out = run('cards', store);
  assert.equal(out.aPagarNasFaturas, screen.totals.toPay / 100);
  assert.equal(out.saldoDevedorNosEmissores, screen.totals.reportedByIssuer / 100);
  assert.deepEqual(out.faturasPorMesDeVencimento.map((m: { mes: string }) => m.mes), Object.keys(screen.totals.byMonth).sort());
  const one = out.cartoes[0];
  assert.equal(one.aPagar, screen.cards[0]!.toPay / 100);
  assert.equal(one.venceEm, screen.cards[0]!.nextDueDate);
  assert.equal(typeof one.situacaoDaFaturaAberta, 'string');
  // The unpaid September bill is part of what is left to pay.
  assert.ok(out.faturasFechadasNaoPagas >= 500);
  assert.equal(run('summary', store).aPagarNasFaturas, out.aPagarNasFaturas);
});

test('the forecast tool gives both totals, with the sure one first and the average one labelled', () => {
  const store = seeded();
  const out = run('card_forecast', store);
  const first = forecast(store, NOW).months[0]!;
  assert.deepEqual([out.meses[0].previstoCerto, out.meses[0].comMedia], [first.certain / 100, first.estimated / 100]);
  assert.ok(out.meses.every((m: { previstoCerto: number; comMedia: number }) => m.comMedia >= m.previstoCerto));
  assert.equal('total' in out.meses[0], false, 'no unlabelled total');
});
