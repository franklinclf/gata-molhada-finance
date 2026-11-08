import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionsError } from '../../src/api/rules-engine.ts';
import { partyRuleApplies, partyRuleConditions, partyRuleName } from '../../web/src/party-rule.ts';

const pix = { amount: -5000, role: null, operation: 'PIX', counterparty: { name: 'Maria Souza', isOwner: false } };

test('the drawer offers a rule on the name only for a Pix or TED to or from someone else', () => {
  assert.equal(partyRuleApplies(pix), true);
  assert.equal(partyRuleApplies({ ...pix, operation: 'ted' }), true);
  assert.equal(partyRuleApplies({ ...pix, counterparty: { name: 'Maria Souza', isOwner: true } }), false, 'the owner');
  assert.equal(partyRuleApplies({ ...pix, counterparty: { name: null, isOwner: false } }), false, 'no name');
  assert.equal(partyRuleApplies({ ...pix, counterparty: { name: ' ', isOwner: false } }), false);
  assert.equal(partyRuleApplies({ ...pix, counterparty: null }), false);
  assert.equal(partyRuleApplies({ ...pix, operation: null }), false, 'a card purchase');
  assert.equal(partyRuleApplies({ ...pix, role: 'own_transfer' }), false);
  assert.equal(partyRuleApplies({ ...pix, counterparty: { name: 'x'.repeat(201), isOwner: false } }), false, 'too long for a condition');
});

test('the rule conditions are valid for the API and name the direction', () => {
  const out = partyRuleConditions(' Maria Souza ', 'out');
  assert.equal(conditionsError(out), null);
  assert.deepEqual(out.items, [{ field: 'counterparty', operator: 'equals', value: 'Maria Souza' }, { field: 'direction', operator: 'equals', value: 'out' }]);
});

test('the rule name says to or from, and stays within the 80 characters the API allows', () => {
  assert.equal(partyRuleName('Maria  Souza', 'out'), 'Transferências para Maria Souza');
  assert.equal(partyRuleName('Maria Souza', 'in'), 'Transferências de Maria Souza');
  assert.ok(partyRuleName('x'.repeat(200), 'out').length <= 80);
});
