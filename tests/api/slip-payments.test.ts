import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { slipBillPayments } from '../../src/api/roles.ts';
import * as views from '../../src/api/views.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const bill = { dueDate: '2026-09-15', total: 157459 };
const slip = { id: 'a', day: '2026-09-14', amount: -157459, labels: ['Transferência - Boleto bancário'], description: 'PIX QR CODE DINAMICO - DES RECEBTO PAGTO ANTEC G 14/09 - DOCTO: 849437' };

test('a slip payment equal to a bill total near its due date pays that bill', () => {
  assert.deepEqual([...slipBillPayments([slip], [bill])], ['a']);
});

test('a slip payment is left alone when the amount, the date or the text does not fit', () => {
  assert.equal(slipBillPayments([{ ...slip, amount: -157460 }], [bill]).size, 0);
  assert.equal(slipBillPayments([{ ...slip, day: '2026-07-01' }], [bill]).size, 0);
  assert.equal(slipBillPayments([{ ...slip, labels: ['Compras'], description: 'Mercado Central' }], [bill]).size, 0);
  assert.equal(slipBillPayments([{ ...slip, amount: 157459 }], [bill]).size, 0);
});

test('each bill is paid by one slip only', () => {
  const twin = { ...slip, id: 'b' };
  assert.deepEqual([...slipBillPayments([slip, twin], [bill])], ['a']);
});

test('the spending total equals the sum of the days even when a group only holds refunds', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const acc = { id: 'c1', institution: 'Bank', kind: 'credit_card' as const, name: 'Card', last4: '1111', balance: 0, balanceSourceId: 'pierre', balanceAsOf: '2026-10-27T10:00:00Z', creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [] };
  store.replaceCanonicalAccounts([acc], [], '2026-10-27T10:00:00Z');
  const t = (id: string, amount: number, category: string) => ({ id, accountId: 'c1', occurredAt: '2026-10-20T15:00:00Z', amount, description: id, descriptionRaw: null, status: 'posted' as const, installment: null, category, state: 'confirmed' as const, sourceIds: ['pierre'], excluded: false });
  store.replaceCanonicalTransactions([t('shop', -10000, 'Compras'), t('refund', 2500, 'Estorno')], [], '2026-10-27T10:00:00Z');
  const v = views.spending(store, { from: '2026-10-01', to: '2026-10-31' }, 'category', new Date('2026-10-27T15:00:00Z'));
  assert.equal(v.total, 7500);
  assert.equal(v.total, v.daily.reduce((sum, d) => sum + d.amount, 0));
  assert.equal(v.creditsNotListed, 2500);
});
