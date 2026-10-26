import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccount, normalizeBill, normalizeTransaction } from '../../../src/adapters/pluggy/normalize.ts';
import { SourceFormatError } from '../../../src/core/http.ts';
import {
  pluggyBankAccount,
  pluggyBankCredit,
  pluggyBill,
  pluggyCardAccount,
  pluggyCardPayment,
  pluggyCardPurchase,
} from '../../fixtures/pluggy.ts';

test('normalizes a bank account', () => {
  assert.deepEqual(normalizeAccount(pluggyBankAccount, 'Bank A'), {
    externalId: 'acc-bank-1',
    externalItemId: 'item-1',
    institution: 'Bank A',
    kind: 'checking',
    name: 'Conta Corrente',
    last4: null,
    balance: 152345,
    creditLimit: null,
    availableLimit: null,
    minimumPayment: null,
    dueDate: null,
  });
});

test('normalizes a credit card account with limit data', () => {
  const account = normalizeAccount(pluggyCardAccount, 'Bank A');
  assert.equal(account.kind, 'credit_card');
  assert.equal(account.last4, '1234');
  assert.equal(account.balance, 32050);
  assert.equal(account.creditLimit, 500000);
  assert.equal(account.availableLimit, 467950);
  assert.equal(account.minimumPayment, 4808);
  assert.equal(account.dueDate, '2026-11-10');
});

test('rejects an unsupported account type', () => {
  const odd = { ...pluggyBankAccount, type: 'INVESTMENT', subtype: 'FUND' };
  assert.throws(() => normalizeAccount(odd, 'Bank A'), SourceFormatError);
});

test('keeps the sign of bank transactions', () => {
  const tx = normalizeTransaction(pluggyBankCredit, 'checking');
  assert.equal(tx.amount, 15000);
  assert.equal(tx.status, 'posted');
  assert.equal(tx.occurredAt, '2026-10-20T12:00:00.000Z');
  assert.equal(tx.descriptionRaw, 'Transferencia recebida');
  assert.equal(tx.installment, null);
});

test('flips credit card purchases and payments to cash-flow sign', () => {
  assert.equal(normalizeTransaction(pluggyCardPurchase, 'credit_card').amount, -9990);
  assert.equal(normalizeTransaction(pluggyCardPayment, 'credit_card').amount, 32000);
});

test('reads installment data and pending status from a card purchase', () => {
  const tx = normalizeTransaction(pluggyCardPurchase, 'credit_card');
  assert.equal(tx.status, 'pending');
  assert.deepEqual(tx.installment, { number: 2, total: 5 });
  assert.equal(tx.category, 'Shopping');
});

test('a missing category becomes null', () => {
  assert.equal(normalizeTransaction(pluggyCardPayment, 'credit_card').category, null);
});

test('rejects an unknown transaction status', () => {
  assert.throws(() => normalizeTransaction({ ...pluggyBankCredit, status: 'CANCELLED' }, 'checking'), /unsupported value CANCELLED/);
});

test('rejects a transaction without an id', () => {
  const { id: _id, ...rest } = pluggyBankCredit;
  assert.throws(() => normalizeTransaction(rest, 'checking'), /pluggy\.transaction\.id/);
});

test('normalizes a bill', () => {
  assert.deepEqual(normalizeBill(pluggyBill, 'acc-card-1'), {
    externalId: 'bill-1',
    accountExternalId: 'acc-card-1',
    dueDate: '2026-11-10',
    closingDate: '2026-11-03',
    total: 32050,
    minimumPayment: 4808,
  });
});
