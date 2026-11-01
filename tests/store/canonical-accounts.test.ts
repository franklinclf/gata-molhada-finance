import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { CanonicalAccount, LimitGroup } from '../../src/core/canonical.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T1 = '2026-10-26T10:00:00.000Z';
const T2 = '2026-10-26T12:00:00.000Z';

function newStore() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, T1);
  store.registerSource({ id: 'pluggy', kind: 'aggregator', capabilities: {} }, T1);
  return store;
}

const account = (overrides: Partial<CanonicalAccount> = {}): CanonicalAccount => ({
  id: 'acc_1',
  institution: 'Bank A',
  kind: 'credit_card',
  name: 'Cartao Exemplo',
  last4: '1234',
  balance: 30000,
  balanceSourceId: 'pierre',
  balanceAsOf: T1,
  creditLimit: 500000,
  availableLimit: 470000,
  minimumPayment: 4800,
  dueDate: '2026-11-10',
  limitGroupId: 'lg_1',
  refs: [
    { sourceId: 'pierre', externalId: 'p1', role: 'member' },
    { sourceId: 'pluggy', externalId: 'g1', role: 'member' },
    { sourceId: 'pluggy', externalId: 'g2', role: 'duplicate' },
  ],
  ...overrides,
});

const group: LimitGroup = { id: 'lg_1', institution: 'Bank A', creditLimit: 500000, memberIds: ['acc_1', 'acc_2'] };

test('stores canonical accounts with their references and limit groups', () => {
  const store = newStore();
  const second = account({ id: 'acc_2', name: 'Outro', last4: '5678', refs: [{ sourceId: 'pierre', externalId: 'p2', role: 'member' }] });
  store.replaceCanonicalAccounts([account(), second], [group], T1);
  const accounts = store.listCanonicalAccounts();
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.find((a) => a.id === 'acc_1'), account());
  assert.deepEqual(store.listLimitGroups(), [group]);
});

test('replacing removes accounts, groups and references that are no longer present', () => {
  const store = newStore();
  store.replaceCanonicalAccounts([account()], [group], T1);
  store.replaceCanonicalAccounts([account({ id: 'acc_9', limitGroupId: null, refs: [{ sourceId: 'pierre', externalId: 'p9', role: 'member' }] })], [], T2);
  const accounts = store.listCanonicalAccounts();
  assert.deepEqual(accounts.map((a) => a.id), ['acc_9']);
  assert.deepEqual(store.listLimitGroups(), []);
});

test('a failing replace keeps the previous canonical data', () => {
  const store = newStore();
  store.replaceCanonicalAccounts([account()], [group], T1);
  const broken = account({ id: 'acc_dup' });
  assert.throws(() => store.replaceCanonicalAccounts([broken, broken], [], T2), /UNIQUE|constraint/i);
  assert.deepEqual(store.listCanonicalAccounts().map((a) => a.id), ['acc_1']);
});

test('a source reference can point at only one canonical account', () => {
  const store = newStore();
  const a = account({ id: 'acc_1', limitGroupId: null });
  const b = account({ id: 'acc_2', limitGroupId: null });
  assert.throws(() => store.replaceCanonicalAccounts([a, b], [], T1), /UNIQUE|constraint/i);
});

test('what the owner attached to an account follows its records when the account gets a new id', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T1);
  const account = (id: string, name: string) => ({
    id, institution: 'Bank', kind: 'credit_card' as const, name, last4: '1111', balance: 0, balanceSourceId: 'pluggy', balanceAsOf: T1, creditLimit: null, availableLimit: null,
    minimumPayment: null, dueDate: null, limitGroupId: null, refs: [{ sourceId: 'pluggy', externalId: 'ext-1', role: 'member' as const }],
  });
  store.replaceCanonicalAccounts([account('acc_old', 'Card')], [], T1);
  store.setAccountHidden('acc_old', true, T1);
  store.setCycleOverride('acc_old', '2026-09', true, T1);
  store.saveManualTransaction({ accountId: 'acc_old', day: '2026-10-01', amount: -213, description: 'IOF', category: null, notes: null }, T1);
  store.saveGoal({ name: 'Pay the card', target: 100000, targetDay: null, track: 'account', trackRef: 'acc_old', saved: 0, initial: 0, createdDay: '2026-10-01', archived: false });

  // The connection was renamed: same source record, new name, so a new id.
  store.replaceCanonicalAccounts([account('acc_new', 'Card renamed')], [], T1);
  assert.deepEqual([...store.listHiddenAccountIds()], ['acc_new']);
  assert.equal(store.listCycleOverrides().get('acc_new|2026-09'), true);
  assert.equal(store.listManualTransactions()[0]?.accountId, 'acc_new');
  assert.equal(store.listGoals()[0]?.trackRef, 'acc_new');

  // A rebuild that keeps the id changes nothing, and an account with other records does not take over the choices.
  store.replaceCanonicalAccounts([account('acc_new', 'Card renamed')], [], T1);
  assert.deepEqual([...store.listHiddenAccountIds()], ['acc_new']);
});
