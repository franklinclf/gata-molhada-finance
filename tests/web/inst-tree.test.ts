import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountOn, buildTree, nodeState, startsOpen, toggleAccount, toggleInstitution } from '../../web/src/inst-tree.ts';

const tree = buildTree(
  [{ name: 'Banco Alfa', count: 9 }, { name: 'Banco Beta', count: 3 }],
  [
    { id: 'a1', institution: 'Banco Alfa', count: 6 },
    { id: 'a2', institution: 'Banco Alfa', count: 3 },
    { id: 'b1', institution: 'Banco Beta', count: 3 },
  ],
);
const alfa = tree[0]!;

test('accounts sit under their institution, biggest first', () => {
  assert.deepEqual(tree.map((n) => [n.institution, n.accounts.length]), [['Banco Alfa', 2], ['Banco Beta', 1]]);
});

test('an institution is on, partly on or off', () => {
  assert.equal(nodeState(alfa, [], []), 'off');
  assert.equal(nodeState(alfa, ['Banco Alfa'], []), 'on');
  assert.equal(nodeState(alfa, [], ['a2']), 'some');
  assert.equal(accountOn(alfa, 'a1', ['Banco Alfa'], []), true);
  assert.equal(accountOn(alfa, 'a1', [], ['a2']), false);
});

test('ticking an institution drops its single accounts, a partly ticked one is cleared', () => {
  assert.deepEqual(toggleInstitution(alfa, [], []), { institution: ['Banco Alfa'], accountId: [] });
  assert.deepEqual(toggleInstitution(alfa, ['Banco Alfa'], []), { institution: [], accountId: [] });
  assert.deepEqual(toggleInstitution(alfa, [], ['a2', 'b1']), { institution: [], accountId: ['b1'] });
});

test('unticking one account of a chosen institution keeps the others', () => {
  assert.deepEqual(toggleAccount(alfa, 'a1', ['Banco Alfa'], []), { institution: [], accountId: ['a2'] });
});

test('ticking every account collapses to the institution', () => {
  assert.deepEqual(toggleAccount(alfa, 'a2', [], ['a1']), { institution: ['Banco Alfa'], accountId: [] });
  assert.deepEqual(toggleAccount(alfa, 'a1', [], []), { institution: [], accountId: ['a1'] });
});

test('institutions with few accounts start open', () => {
  assert.equal(startsOpen(alfa, 'off'), true);
  const many = { institution: 'X', count: 1, accounts: [1, 2, 3, 4].map((n) => ({ id: String(n), institution: 'X', count: 1 })) };
  assert.equal(startsOpen(many, 'off'), false);
  assert.equal(startsOpen(many, 'some'), true);
});
