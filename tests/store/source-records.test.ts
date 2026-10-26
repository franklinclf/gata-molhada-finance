import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { SourceAccount, SourceBill, SourceTransaction } from '../../src/core/types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T1 = '2026-10-26T10:00:00.000Z';
const T2 = '2026-10-26T12:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, T1);
  return store;
}

const account: SourceAccount = {
  externalId: 'acc-1',
  externalItemId: null,
  institution: 'Bank A',
  kind: 'credit_card',
  name: 'Cartao Exemplo',
  last4: '1234',
  balance: 32050,
  creditLimit: 500000,
  availableLimit: 467950,
  minimumPayment: 4808,
  dueDate: '2026-11-10',
};

const tx: SourceTransaction = {
  externalId: 'tx-1',
  accountExternalId: 'acc-1',
  occurredAt: '2026-10-21T03:00:00.000Z',
  amount: -9990,
  description: 'Loja Exemplo 2/5',
  descriptionRaw: 'LOJA EXEMPLO 02/05',
  status: 'pending',
  installment: { number: 2, total: 5 },
  category: 'Shopping',
};

const bill: SourceBill = {
  externalId: 'bill-1',
  accountExternalId: 'acc-1',
  dueDate: '2026-11-10',
  closingDate: '2026-11-03',
  total: 32050,
  minimumPayment: 4808,
};

test('stores and lists accounts with their seen timestamps', () => {
  const store = newStore();
  store.upsertSourceAccounts('pierre', [account], T1);
  assert.deepEqual(store.listSourceAccounts('pierre'), [{ ...account, sourceId: 'pierre', firstSeenAt: T1, lastSeenAt: T1 }]);
});

test('an upsert updates the values and last_seen_at but keeps first_seen_at', () => {
  const store = newStore();
  store.upsertSourceAccounts('pierre', [account], T1);
  store.upsertSourceAccounts('pierre', [{ ...account, balance: 50000, availableLimit: 450000 }], T2);
  const [stored] = store.listSourceAccounts('pierre');
  assert.equal(stored?.balance, 50000);
  assert.equal(stored?.availableLimit, 450000);
  assert.equal(stored?.firstSeenAt, T1);
  assert.equal(stored?.lastSeenAt, T2);
  assert.equal(store.listSourceAccounts('pierre').length, 1);
});

test('stores transactions with installments and nulls', () => {
  const store = newStore();
  const plain: SourceTransaction = { ...tx, externalId: 'tx-2', installment: null, descriptionRaw: null, category: null };
  store.upsertSourceTransactions('pierre', [tx, plain], T1);
  const stored = store.listSourceTransactions('pierre');
  assert.equal(stored.length, 2);
  const byId = Object.fromEntries(stored.map((s) => [s.externalId, s]));
  assert.deepEqual(byId['tx-1']?.installment, { number: 2, total: 5 });
  assert.equal(byId['tx-2']?.installment, null);
  assert.equal(byId['tx-2']?.descriptionRaw, null);
});

test('a pending transaction can later be confirmed by an upsert', () => {
  const store = newStore();
  store.upsertSourceTransactions('pierre', [tx], T1);
  store.upsertSourceTransactions('pierre', [{ ...tx, status: 'posted' }], T2);
  const [stored] = store.listSourceTransactions('pierre');
  assert.equal(stored?.status, 'posted');
  assert.equal(stored?.firstSeenAt, T1);
});

test('stores bills', () => {
  const store = newStore();
  store.upsertSourceBills('pierre', [bill], T1);
  assert.deepEqual(store.listSourceBills('pierre'), [{ ...bill, sourceId: 'pierre', firstSeenAt: T1, lastSeenAt: T1 }]);
});

test('records of different sources do not mix', () => {
  const store = newStore();
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, T1);
  store.upsertSourceTransactions('pierre', [tx], T1);
  store.upsertSourceTransactions('pluggy', [{ ...tx, amount: -1 }], T1);
  assert.equal(store.listSourceTransactions('pierre')[0]?.amount, -9990);
  assert.equal(store.listSourceTransactions('pluggy')[0]?.amount, -1);
});

test('rejects records of an unregistered source', () => {
  const store = newStore();
  assert.throws(() => store.upsertSourceTransactions('ghost', [tx], T1), /FOREIGN KEY/);
});

test('a failing batch is rolled back as a whole', () => {
  const store = newStore();
  const broken = { ...tx, externalId: 'tx-bad', description: null } as unknown as SourceTransaction;
  assert.throws(() => store.upsertSourceTransactions('pierre', [tx, broken], T1), /NOT NULL/);
  assert.deepEqual(store.listSourceTransactions('pierre'), []);
});
