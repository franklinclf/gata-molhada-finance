import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleOf, type TitleInput } from '../../src/core/title.ts';

const t = (over: Partial<TitleInput>): TitleInput => ({ description: 'X', amount: -1000, role: null, operation: null, counterparty: null, ...over });

test('card bill payments have one name whatever the bank wrote', () => {
  for (const description of ['PAGTO. POR DEB EM C/C', 'Pagamento recebido', 'PAGAMENTO COM SALDO', 'GASTOS CARTAO DE CREDITO - DOCTO: 3990288', 'PAGAMENTO RECEBIDO - OBRI']) {
    assert.equal(titleOf(t({ description, role: 'card_payment', amount: description.startsWith('GASTOS') ? -50000 : 50000 })), 'Pagamento de fatura');
  }
});

test('a Pix, a TED and a boleto say direction and who, with the name cleaned', () => {
  assert.equal(titleOf(t({ description: 'Transferência enviada pelo Pix|RICARLA MARIA AMARO DE OLIVEIRA', operation: 'PIX', counterparty: { name: 'RICARLA MARIA AMARO DE OLIVEIRA' } })), 'Pix enviado · Ricarla Maria Amaro de Oliveira');
  assert.equal(titleOf(t({ description: 'Pix recebido', amount: 5000, operation: 'PIX', counterparty: { name: 'JOAO SILVA' } })), 'Pix recebido · Joao Silva');
  assert.equal(titleOf(t({ description: 'Pix Key Transfer', operation: 'PIX' })), 'Pix enviado');
  assert.equal(titleOf(t({ description: 'TED enviada', operation: 'TED', counterparty: { name: 'ACME LTDA' } })), 'TED enviada · Acme');
  assert.equal(titleOf(t({ description: 'Pagamento de boleto Receita Federal', operation: 'BOLETO' })), 'Pagamento de boleto · Receita Federal');
});

test('the operation is read from the text when the source does not say it', () => {
  assert.equal(titleOf(t({ description: 'Transferência enviada pelo Pix|Maria Souza' })), 'Pix enviado · Maria Souza');
  assert.equal(titleOf(t({ description: 'TED recebida|Empresa X', amount: 90000 })), 'TED recebida · Empresa X');
});

test('transfers between your accounts and investments have fixed names, by direction', () => {
  assert.equal(titleOf(t({ role: 'own_transfer' })), 'Transferência para suas contas');
  assert.equal(titleOf(t({ role: 'own_transfer', amount: 100 })), 'Transferência de suas contas');
  assert.equal(titleOf(t({ role: 'investment', description: 'Aplicação APL APLIC AUT MAIS' })), 'Aplicação');
  assert.equal(titleOf(t({ role: 'investment', description: 'Resgate RDB', amount: 2000 })), 'Resgate');
  assert.equal(titleOf(t({ role: 'investment', description: 'Lucro', amount: 236 })), 'Rendimento');
});

test('bank charges are named the same way, and a shop keeps its cleaned name', () => {
  assert.equal(titleOf(t({ description: 'CUSTO TRANS. EXTERIOR-IOF' })), 'IOF');
  assert.equal(titleOf(t({ description: 'MULTA CONTRATUAL DE ATRAS' })), 'Multa por atraso');
  assert.equal(titleOf(t({ description: 'ESTORNO AUTOMATICO MULTA', amount: 443 })), 'Estorno de multa');
  assert.equal(titleOf(t({ description: 'DL*UberRidesSao PauloBRA' })), 'Uber');
  assert.equal(titleOf(t({ description: 'Lucro', amount: 236 })), 'Rendimento');
  assert.equal(titleOf(t({ description: 'IFD*PIZZARIA DO ZE' })), 'iFood');
});
