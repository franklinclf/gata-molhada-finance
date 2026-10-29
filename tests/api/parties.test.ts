import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeTransaction as pluggyNormalize } from '../../src/adapters/pluggy/normalize.ts';
import { effectiveTransactions } from '../../src/api/scope.ts';
import { partyFrom } from '../../src/core/parties.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { backfillParties } from '../../src/sync/backfill-parties.ts';
import type { SourceTransaction } from '../../src/core/types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');
const OWNER = '111.222.333-44';
const FRIEND = '555.666.777-88';

const pluggyRaw = (id: string, amount: number, payer: string, receiver: string, extra: Record<string, unknown> = {}) => ({
  id, accountId: 'acc', description: 'Pix', descriptionRaw: 'Pix', category: 'Transfers',
  amount, date: '2026-10-20T12:00:00Z', status: 'POSTED', operationType: 'PIX',
  paymentData: { payer: { documentNumber: { type: 'CPF', value: payer } }, receiver: { documentNumber: { type: 'CPF', value: receiver } } },
  ...extra,
});
const pierre = (raw: Record<string, unknown>, kind: 'checking' | 'credit_card' = 'checking') => pluggyNormalize(raw, kind);

test('the documents are hashed and only the last four digits stay readable', () => {
  const party = partyFrom('Maria', OWNER)!;
  assert.equal(party.last4, '3344');
  assert.ok(party.hash && !party.hash.includes('3344') && party.hash.length === 24);
  assert.equal(partyFrom(null, '123'), null);
  assert.equal(partyFrom('Only a name', null)?.hash, null);
});

test('both adapters read who paid, who received, the operation and the merchant code', () => {
  const a = pierre(pluggyRaw('p1', -10, OWNER, FRIEND));
  assert.equal(a.parties?.operation, 'PIX');
  assert.equal(a.parties?.receiver?.last4, '7788');
  assert.equal(a.parties?.payer?.hash, partyFrom(null, OWNER)?.hash);
  const card = pierre({ id: 'x', accountId: 'acc', description: 'Shop', amount: 10, date: '2026-10-20T12:00:00Z', status: 'POSTED', creditCardMetadata: { payeeMCC: 5912 } }, 'credit_card');
  assert.equal(card.parties?.mcc, '5912');
  assert.equal(pierre({ ...pluggyRaw('p2', -1, OWNER, FRIEND), paymentData: undefined, operationType: undefined }).parties, undefined);
});

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  const acct = { id: 'chk', institution: 'Bank', kind: 'checking' as const, name: 'Conta', last4: null, balance: 0, balanceSourceId: 'pluggy', balanceAsOf: NOW.toISOString(), creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [] };
  store.replaceCanonicalAccounts([acct], [], NOW.toISOString());
  const raws = [
    // Three outflows make the owner's document known; one goes to the owner's other account, with no name in the text.
    pluggyRaw('o1', -50, OWNER, FRIEND, { description: 'Transferência enviada|Maria Souza' }),
    pluggyRaw('o2', -60, OWNER, FRIEND, { description: 'Transferência enviada pelo Pix|MARIA SOUZA' }),
    pluggyRaw('o3', -70, OWNER, FRIEND, { description: 'PIX ENVIADO' }),
    pluggyRaw('own', -80, OWNER, OWNER, { description: 'PIX ENVIADO' }),
    pluggyRaw('in1', 90, FRIEND, OWNER), pluggyRaw('in2', 91, FRIEND, OWNER), pluggyRaw('in3', 92, FRIEND, OWNER),
  ];
  const txns = raws.map((r) => pierre(r));
  store.upsertSourceTransactions('pluggy', txns as SourceTransaction[], NOW.toISOString());
  store.replaceCanonicalTransactions(
    txns.map((t) => ({ id: t.externalId, accountId: 'chk', occurredAt: t.occurredAt, amount: t.amount, description: t.description, descriptionRaw: null, status: 'posted' as const, installment: null, category: t.category, state: 'confirmed' as const, sourceIds: ['pluggy'], excluded: false })),
    txns.map((t) => ({ sourceId: 'pluggy', externalId: t.externalId, transactionId: t.externalId, matchPass: 0 })),
    NOW.toISOString(),
  );
  return store;
}

test('a Pix to the owner\'s own document is a move between own accounts, whatever the text says', () => {
  const byId = new Map(effectiveTransactions(seeded()).map((t) => [t.id, t]));
  assert.equal(byId.get('own')?.role, 'own_transfer');
  assert.equal(byId.get('own')?.counterparty?.isOwner, true);
  assert.equal(byId.get('o3')?.role, null);
});

test('a person is named by the document: a Pix with no name in its text gets the name used elsewhere', () => {
  const byId = new Map(effectiveTransactions(seeded()).map((t) => [t.id, t]));
  assert.equal(byId.get('o3')?.counterparty?.name?.toLowerCase(), 'maria souza');
  assert.equal(byId.get('o3')?.counterparty?.last4, '7788');
  assert.equal(byId.get('in1')?.counterparty?.isOwner, false);
});

test('the merchant code names the category when the source label does not', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  const acct = { id: 'c', institution: 'Bank', kind: 'credit_card' as const, name: 'Card', last4: '1111', balance: 0, balanceSourceId: 'pluggy', balanceAsOf: NOW.toISOString(), creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [] };
  store.replaceCanonicalAccounts([acct], [], NOW.toISOString());
  const t = pierre({ id: 'k', accountId: 'c', description: 'PAGUE MENOS 12', category: 'Shopping', amount: 30, date: '2026-10-20T12:00:00Z', status: 'POSTED', creditCardMetadata: { payeeMCC: '5912' } }, 'credit_card');
  store.upsertSourceTransactions('pluggy', [t], NOW.toISOString());
  store.replaceCanonicalTransactions([{ id: 'k', accountId: 'c', occurredAt: t.occurredAt, amount: t.amount, description: t.description, descriptionRaw: null, status: 'posted', installment: null, category: 'Shopping', state: 'confirmed', sourceIds: ['pluggy'], excluded: false }], [{ sourceId: 'pluggy', externalId: 'k', transactionId: 'k', matchPass: 0 }], NOW.toISOString());
  assert.equal(effectiveTransactions(store)[0]?.category, 'Farmácia');
});

test('saved records get their parties from the raw answers once', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  const t = pierre(pluggyRaw('b1', -10, OWNER, FRIEND));
  store.upsertSourceTransactions('pluggy', [{ ...t, parties: undefined }], NOW.toISOString());
  assert.equal(store.listSourceTransactions('pluggy')[0]?.parties, undefined);
  store.saveSnapshot({ sourceId: 'pluggy', endpoint: '/v2/transactions?accountId=acc', fetchedAt: NOW.toISOString(), httpStatus: 200, body: { results: [pluggyRaw('b1', -10, OWNER, FRIEND)] } });
  assert.equal(backfillParties(store, NOW), 1);
  assert.equal(store.listSourceTransactions('pluggy')[0]?.parties?.receiver?.last4, '7788');
  assert.equal(backfillParties(store, NOW), 0);
});
