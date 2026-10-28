import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merchantName } from '../../src/core/merchant.ts';

const same = (names: string[], expected: string) => {
  for (const name of names) assert.equal(merchantName(name), expected, name);
};

test('known names collapse however the bank writes them', () => {
  same(['DL*UberRides', 'DL*UberRidesSao PauloBRA', 'DL          *UberRidesSao PauloBRA', 'Uber UBER *TRIP HELP.U SA', 'UBER * PENDING', 'Uber UBER *TRIP HELP.USAO PAULOBRA'], 'Uber');
  same(['iFood', 'Ifd*Mxd Lanchonetes', 'IFD*PIZZARIA DO ZE'], 'iFood');
  same(['Rappi*Rappi Brasil Int', 'RAPPI*Rappi Brasil Int Sa'], 'Rappi');
  same(['AMAZON BR              SA', 'AMAZON BR SA'], 'Amazon');
});

test('a person is the same under every way a transfer is written', () => {
  same(['Transferência enviada|Dennis Gabriel Cruz da Silva', 'Transferência enviada pelo Pix|DENNIS GABRIEL CRUZ DA SILVA'], 'Dennis Gabriel Cruz da Silva');
  assert.equal(merchantName('Pix enviado Maria Souza'), 'Maria Souza');
});

test('store numbers, company suffixes and spacing are dropped', () => {
  same(['EXTRA HIPER-1365', 'EXTRA HIPER-1380'], 'Extra Hiper');
  same(['LOJAS AMERICANAS 226', 'LOJAS AMERICANAS 301'], 'Lojas Americanas');
  same(['Jjang Korean Market', 'JJANG KOREAN MARKET'], 'Jjang Korean Market');
  same(['Supermercado           NA', 'Supermercado'], 'Supermercado');
});

test('a processor code before the star is not the shop', () => {
  same(['Mp *Barbeariawitt'], 'Barbeariawitt');
  assert.equal(merchantName('ASA*GestaoBestBarbers'), 'Gestaobestbarbers');
});

test('text with nothing to clean is kept', () => {
  assert.equal(merchantName('Pague Menos'), 'Pague Menos');
  assert.equal(merchantName('***'), '***');
});
