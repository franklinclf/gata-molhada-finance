import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLabel, accountName, cardName, netWorthLabel, productName } from '../../web/src/names.ts';

test('the institution is not repeated when the bank name already starts with it, ignoring case and accents', () => {
  assert.equal(cardName('Norte', 'Norte Click Plus'), 'Norte Click Plus');
  assert.equal(cardName('Itaú', 'ITAU MASTERCARD PLATINUM'), 'Itaú Mastercard Platinum');
  assert.equal(cardName('Sol', 'Sol Sol Gold'), 'Sol Sol Gold');
});

test('a name in capitals is written as a name, keeping short initials', () => {
  assert.equal(productName('Sul', 'VISA SIGNATURE'), 'Visa Signature');
  assert.equal(productName('Sul', 'CARTAO DE VIAGEM MC'), 'Cartao de Viagem MC');
  assert.equal(productName('Sul', 'Cartão Base 2'), 'Cartão Base 2');
});

test('legal suffixes are dropped, and a generic bank name leaves nothing', () => {
  assert.equal(productName('Alfa', 'ALFA INSTITUICAO DE PAGAMENTO S.A.'), '');
  assert.equal(productName('Beta', 'Banco Beta'), '');
  assert.equal(productName('Gama', 'gama'), '');
  assert.equal(productName('Lume', 'Lu Pagamentos S.A. - Instituição de Pagamento'), '');
  assert.equal(productName('Lume', 'Lume Pagamentos S.A. - Instituição de Pagamento'), '');
  assert.equal(productName('Beta', 'Banco Beta Cartões S.A.'), 'Cartões');
});

test('an account with nothing left shows its kind', () => {
  assert.equal(accountName('Beta', 'Banco Beta', 'savings'), 'Poupança');
  assert.equal(accountName('Beta', 'Banco Beta', 'checking'), 'Conta corrente');
  assert.equal(accountName('Beta', 'Banco Beta'), 'Conta');
  assert.equal(accountName('Beta', 'Conta Salário', 'checking'), 'Conta Salário');
});

test('a card whose name is only the institution shows the institution once', () => {
  assert.equal(cardName('Beta', 'BETA'), 'Beta');
});

test('a net worth line for a bank account drops the repeated or generic part of the bank name', () => {
  assert.equal(netWorthLabel('Alfa · ALFA INSTITUICAO DE PAGAMENTO S.A.', 'bank'), 'Alfa');
  assert.equal(netWorthLabel('Beta · Conta Salário (saldo negativo)', 'bank'), 'Beta · Conta Salário (saldo negativo)');
  assert.equal(netWorthLabel('Dívida no cartão (saldo informado pelo banco)', 'card'), 'Dívida no cartão (saldo informado pelo banco)');
  assert.equal(netWorthLabel('Imóvel · apartamento', 'manual'), 'Imóvel · apartamento');
});

test('accountLabel names an account or a card with its institution once', () => {
  assert.equal(accountLabel({ institution: '99Pay', name: '99PAY INSTITUICAO DE PAGAMENTO S.A.', kind: 'checking' }), '99Pay Conta corrente');
  assert.equal(accountLabel({ institution: 'Banco Exemplo', name: 'Banco Exemplo Visa Gold', kind: 'credit_card', last4: '1234' }), 'Banco Exemplo Visa Gold •••• 1234');
});
