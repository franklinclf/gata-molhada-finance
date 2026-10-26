import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAccounts, summarizeAccounts } from '../../src/reconcile/accounts.ts';
import { account, card, fresh, history, tx, view } from '../support/builders.ts';

const T_OLD = '2026-10-25T20:00:00.000Z';
const T_NEW = '2026-10-26T15:00:00.000Z';

test('pairs the same account across sources by shared transactions', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1' })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1' })], transactions: history('g1', 'gt') }),
  ]);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(result.accounts[0]?.refs.map((r) => `${r.sourceId}:${r.externalId}:${r.role}`), ['pierre:p1:member', 'pluggy:g1:member']);
});

test('does not pair accounts of different institutions even with equal transactions', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', institution: 'Bank A' })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', institution: 'Bank B' })], transactions: history('g1', 'gt') }),
  ]);
  assert.equal(result.accounts.length, 2);
});

test('matches institution names written with different accents and case', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', institution: 'Crédito Útil' })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', institution: 'CREDITO UTIL' })], transactions: history('g1', 'gt') }),
  ]);
  assert.equal(result.accounts.length, 1);
});

test('chooses the right account among several of one institution', () => {
  const pierreTx = [...history('p-check', 'pa', 4), ...history('p-card', 'pb', 0)];
  const pluggyChecking = history('g-check', 'ga', 4);
  const pluggyOther = [tx({ externalId: 'x1', accountExternalId: 'g-other', amount: -99999, descriptionRaw: 'UNRELATED' })];
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p-check' })], transactions: pierreTx }),
    view('pluggy', 1, {
      accounts: [account({ externalId: 'g-other', name: 'Outra' }), account({ externalId: 'g-check' })],
      transactions: [...pluggyChecking, ...pluggyOther],
    }),
  ]);
  const paired = result.accounts.find((a) => a.refs.some((r) => r.sourceId === 'pierre'));
  assert.deepEqual(paired?.refs.map((r) => r.externalId), ['p-check', 'g-check']);
  assert.equal(result.accounts.length, 2);
});

test('pairs accounts without transactions by institution, kind and name', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', kind: 'savings', name: 'Poupança' })] }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', kind: 'savings', name: 'poupanca' })] }),
  ]);
  assert.equal(result.accounts.length, 1);
});

test('keeps accounts that exist in only one source and says so', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1' })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, {
      accounts: [account({ externalId: 'g1' }), card({ externalId: 'g2', institution: 'Bank A', name: 'Cartao Solto', last4: '9999' })],
      transactions: history('g1', 'gt'),
    }),
  ]);
  assert.equal(result.accounts.length, 2);
  assert.ok(result.notes.some((n) => /Cartao Solto: not found in pierre/.test(n)));
});

test('does not complain about the manual wallet missing from other sources', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'w', institution: 'Manual', kind: 'savings', name: 'Carteira' })] }),
    view('pluggy', 1, { accounts: [] }),
  ]);
  assert.equal(result.notes.length, 0);
});

test('treats a card listed twice by one source as a single card', () => {
  const copyUnderA = card({ externalId: 'g-a', institution: 'Bank A' });
  const copyUnderB = card({ externalId: 'g-b', institution: 'Bank B' });
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [card({ externalId: 'p1', last4: null })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, {
      accounts: [copyUnderB, copyUnderA],
      transactions: [...history('g-a', 'ga'), ...history('g-b', 'gb')],
    }),
  ]);
  assert.equal(result.accounts.length, 1);
  const refs = result.accounts[0]?.refs.map((r) => `${r.sourceId}:${r.externalId}:${r.role}`);
  assert.deepEqual(refs, ['pierre:p1:member', 'pluggy:g-a:member', 'pluggy:g-b:duplicate']);
  assert.equal(result.accounts[0]?.last4, '1234');
  assert.ok(result.notes.some((n) => /ignored a duplicate copy in pluggy \(listed under Bank B\)/.test(n)));
});

test('a duplicated card seen only by one source keeps the copy with the freshest institution', () => {
  const result = reconcileAccounts([
    view('pluggy', 0, {
      accounts: [card({ externalId: 'g-a', institution: 'Bank A' }), card({ externalId: 'g-b', institution: 'Bank B' })],
      freshness: [fresh('pluggy', 'Bank A', T_OLD), fresh('pluggy', 'Bank B', T_NEW)],
    }),
  ]);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0]?.institution, 'Bank B');
});

test('uses the balance of the source that synced the institution most recently', () => {
  const result = reconcileAccounts([
    view('pierre', 0, {
      accounts: [account({ externalId: 'p1', balance: 500000 })],
      transactions: history('p1', 'pt'),
      freshness: [fresh('pierre', 'Bank A', T_NEW)],
    }),
    view('pluggy', 1, {
      accounts: [account({ externalId: 'g1', balance: 514051 })],
      transactions: history('g1', 'gt'),
      freshness: [fresh('pluggy', 'Bank A', T_OLD)],
    }),
  ]);
  const a = result.accounts[0];
  assert.equal(a?.balance, 500000);
  assert.equal(a?.balanceSourceId, 'pierre');
  assert.equal(a?.balanceAsOf, T_NEW);
  assert.ok(result.notes.some((n) => /balances differ/.test(n) && /using pierre/.test(n)));
});

test('prefers the other source when it is the fresher one', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', balance: 100 })], transactions: history('p1', 'pt'), freshness: [fresh('pierre', 'Bank A', T_OLD)] }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', balance: 200 })], transactions: history('g1', 'gt'), freshness: [fresh('pluggy', 'Bank A', T_NEW)] }),
  ]);
  assert.equal(result.accounts[0]?.balance, 200);
  assert.equal(result.accounts[0]?.balanceSourceId, 'pluggy');
});

test('falls back to source priority when no freshness is known', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'p1', balance: 100 })], transactions: history('p1', 'pt') }),
    view('pluggy', 1, { accounts: [account({ externalId: 'g1', balance: 200 })], transactions: history('g1', 'gt') }),
  ]);
  assert.equal(result.accounts[0]?.balance, 100);
  assert.equal(result.accounts[0]?.balanceAsOf, null);
});

test('fills card limits from another source when the chosen one has none', () => {
  const result = reconcileAccounts([
    view('pierre', 0, {
      accounts: [card({ externalId: 'p1', last4: null, creditLimit: null, availableLimit: null })],
      transactions: history('p1', 'pt'),
      freshness: [fresh('pierre', 'Bank A', T_NEW)],
    }),
    view('pluggy', 1, { accounts: [card({ externalId: 'g1' })], transactions: history('g1', 'gt'), freshness: [fresh('pluggy', 'Bank A', T_OLD)] }),
  ]);
  assert.equal(result.accounts[0]?.creditLimit, 500000);
  assert.equal(result.accounts[0]?.availableLimit, 470000);
});

test('cards of one institution that report the same used limit form a shared group', () => {
  const result = reconcileAccounts([
    view('pierre', 0, {
      accounts: [
        card({ externalId: 'c1', name: 'Card One', last4: '1111', balance: 329272, creditLimit: 1840000, availableLimit: 1510728 }),
        card({ externalId: 'c2', name: 'Card Two', last4: '2222', balance: 329272, creditLimit: 1840000, availableLimit: 1510728 }),
        card({ externalId: 'c3', name: 'Card Three', last4: '3333', balance: 30943, creditLimit: 150000, availableLimit: 119057 }),
      ],
    }),
  ]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]?.memberIds.length, 2);
  const grouped = result.accounts.filter((a) => a.limitGroupId !== null);
  assert.deepEqual(grouped.map((a) => a.name).sort(), ['Card One', 'Card Two']);
});

test('unused cards with equal limits are not treated as one pool', () => {
  const unused = { balance: 0, creditLimit: 500000, availableLimit: 500000 };
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [card({ externalId: 'c1', name: 'One', last4: '1', ...unused }), card({ externalId: 'c2', name: 'Two', last4: '2', ...unused })] }),
  ]);
  assert.equal(result.groups.length, 0);
});

test('summary counts a shared limit once and separates bank money from card debt', () => {
  const result = reconcileAccounts([
    view('pierre', 0, {
      accounts: [
        account({ externalId: 'b1', balance: 500000 }),
        account({ externalId: 'b2', name: 'Poupanca', kind: 'savings', balance: 100000 }),
        card({ externalId: 'c1', name: 'Card One', last4: '1111', balance: 329272, creditLimit: 1840000, availableLimit: 1510728 }),
        card({ externalId: 'c2', name: 'Card Two', last4: '2222', balance: 329272, creditLimit: 1840000, availableLimit: 1510728 }),
        card({ externalId: 'c3', name: 'Card Three', last4: '3333', balance: 30943, creditLimit: 150000, availableLimit: 119057 }),
      ],
    }),
  ]);
  assert.deepEqual(summarizeAccounts(result.accounts), {
    bankBalance: 600000,
    cardOwed: 360215,
    creditLimit: 1990000,
    creditUsed: 360215,
    creditAvailable: 1629785,
  });
});

test('a card with a balance but no limit counts only as debt', () => {
  const result = reconcileAccounts([view('pierre', 0, { accounts: [card({ externalId: 'c1', creditLimit: null, availableLimit: null, balance: 5000 })] })]);
  assert.deepEqual(summarizeAccounts(result.accounts), { bankBalance: 0, cardOwed: 5000, creditLimit: 0, creditUsed: 0, creditAvailable: 0 });
});

test('canonical ids are stable and do not depend on input order', () => {
  const pierre = view('pierre', 0, { accounts: [account({ externalId: 'p1' }), account({ externalId: 'p2', name: 'Poupanca', kind: 'savings' })] });
  const pluggy = view('pluggy', 1, { accounts: [account({ externalId: 'g2', name: 'Poupanca', kind: 'savings' }), account({ externalId: 'g1' })] });
  const a = reconcileAccounts([pierre, pluggy]).accounts.map((x) => x.id).sort();
  const b = reconcileAccounts([pluggy, pierre]).accounts.map((x) => x.id).sort();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 2);
  assert.ok(a.every((id) => /^acc_[0-9a-f]{16}$/.test(id)));
});

test('two accounts with the same kind and name in one institution still get distinct ids', () => {
  const result = reconcileAccounts([
    view('pierre', 0, { accounts: [account({ externalId: 'a' }), account({ externalId: 'b' })] }),
  ]);
  assert.equal(result.accounts.length, 2);
  assert.notEqual(result.accounts[0]?.id, result.accounts[1]?.id);
});
