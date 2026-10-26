import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCardCredit,
  kindOf,
  normalizeAccount,
  normalizeBill,
  normalizeTransaction,
} from '../../../src/adapters/pierre/normalize.ts';
import { SourceFormatError } from '../../../src/core/http.ts';
import { UnsupportedAccountError } from '../../../src/adapters/shape.ts';
import {
  pierreBankAccount,
  pierreBankCredit,
  pierreBill,
  pierreCardAccount,
  pierreCardPayment,
  pierreCardPurchase,
  pierreWalletAccount,
} from '../../fixtures/pierre.ts';

test('maps account types, including the manual savings wallet', () => {
  assert.equal(kindOf('BANK', 'CHECKING_ACCOUNT', 'x'), 'checking');
  assert.equal(kindOf('BANK', 'SAVINGS', 'x'), 'savings');
  assert.equal(kindOf('BANK', 'SAVINGS_ACCOUNT', 'x'), 'savings');
  assert.equal(kindOf('CREDIT', 'CREDIT_CARD', 'x'), 'credit_card');
  assert.throws(() => kindOf('INVESTMENT', 'FUND', 'x'), UnsupportedAccountError);
});

test('normalizes a bank account with a balance sent as a string', () => {
  const account = normalizeAccount(pierreBankAccount, undefined);
  assert.equal(account.balance, 152345);
  assert.equal(account.institution, 'Bank A');
  assert.equal(account.kind, 'checking');
  assert.equal(account.externalItemId, null);
  assert.equal(account.creditLimit, null);
});

test('an account without a connector belongs to the Manual institution', () => {
  assert.equal(normalizeAccount(pierreWalletAccount, undefined).institution, 'Manual');
});

test('adds the card limit data that came from transactions', () => {
  const account = normalizeAccount(pierreCardAccount, {
    creditLimit: 5000,
    availableLimit: 4679.5,
    minimumPayment: 48.08,
    dueDate: '2026-11-10',
  });
  assert.equal(account.creditLimit, 500000);
  assert.equal(account.availableLimit, 467950);
  assert.equal(account.minimumPayment, 4808);
  assert.equal(account.dueDate, '2026-11-10');
  assert.equal(account.balance, 32050);
});

test('a card without limit data keeps the limits null', () => {
  const account = normalizeAccount(pierreCardAccount, undefined);
  assert.equal(account.creditLimit, null);
  assert.equal(account.availableLimit, null);
});

test('extractCardCredit takes the newest transaction of each account', () => {
  const credit = extractCardCredit([pierreCardPayment, pierreCardPurchase, pierreBankCredit]);
  assert.equal(credit.size, 1);
  assert.deepEqual(credit.get('p-acc-card'), {
    creditLimit: 5000,
    availableLimit: 4679.5,
    minimumPayment: 48.08,
    dueDate: '2026-11-10',
  });
});

test('flips card transactions and keeps bank transactions', () => {
  assert.equal(normalizeTransaction(pierreCardPurchase).amount, -9990);
  assert.equal(normalizeTransaction(pierreCardPayment).amount, 32000);
  assert.equal(normalizeTransaction(pierreBankCredit).amount, 15000);
});

test('reads installments, status and the original description', () => {
  const tx = normalizeTransaction(pierreCardPurchase);
  assert.deepEqual(tx.installment, { number: 2, total: 5 });
  assert.equal(tx.status, 'pending');
  assert.equal(tx.descriptionRaw, 'LOJA EXEMPLO 02/05');
  assert.equal(tx.accountExternalId, 'p-acc-card');
  assert.equal(normalizeTransaction(pierreCardPayment).installment, null);
});

test('rejects an unknown transaction status', () => {
  assert.throws(() => normalizeTransaction({ ...pierreBankCredit, status: 'VOID' }), SourceFormatError);
});

test('normalizes a bill whose amounts are strings', () => {
  assert.deepEqual(normalizeBill(pierreBill), {
    externalId: 'p-bill-1',
    accountExternalId: 'p-acc-card',
    dueDate: '2026-11-10',
    closingDate: '2026-11-03',
    total: 32050,
    minimumPayment: 4808,
  });
});
