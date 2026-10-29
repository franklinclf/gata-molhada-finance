import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryFromRules, type Leaf, compileRegex, conditionsError, matches, sortRules, type Rule, type RuleConditions, type RuleSubject } from '../../src/api/rules-engine.ts';

const subject = (extra: Partial<RuleSubject> = {}): RuleSubject => ({
  description: 'UBER *TRIP HELP.U SA', merchant: 'Uber', counterparty: '', sourceLabel: 'Taxi and ride-hailing', institution: 'Itaú', account: 'acc_1', operation: '', mcc: '4121',
  status: 'posted', direction: 'out', amount: -2490, date: '2026-10-20', role: '', ...extra,
});
const all = (...items: RuleConditions['items']): RuleConditions => ({ match: 'all', items });
const leaf = (field: string, operator: string, value: string | number) => ({ field, operator, value }) as Leaf;
const rule = (id: number, priority: number, conditions: RuleConditions, category: string, active = true): Rule => ({ id, name: `r${id}`, priority, active, conditions, actions: { category } });

test('text conditions ignore case and accents on both sides', () => {
  assert.equal(matches(subject(), all(leaf('institution', 'contains', 'ITAU'))), true);
  assert.equal(matches(subject({ institution: 'ITAÚ' }), all(leaf('institution', 'equals', 'itaú'))), true);
  assert.equal(matches(subject(), all(leaf('description', 'starts_with', 'uber'), leaf('description', 'ends_with', 'sa'))), true);
  assert.equal(matches(subject(), all(leaf('description', 'not_contains', 'ifood'))), true);
});

test('amount is signed: money out is negative', () => {
  assert.equal(matches(subject(), all(leaf('amount', 'lt', 0))), true);
  assert.equal(matches(subject(), all(leaf('amount', 'lte', -2490))), true);
  assert.equal(matches(subject(), all(leaf('amount', 'gt', -1000))), false);
  assert.equal(matches(subject({ amount: 5000, direction: 'in' }), all(leaf('amount', 'gt', 0))), true);
});

test('groups give "A and (B or C)", and a group cannot hold a group', () => {
  const c: RuleConditions = { match: 'all', items: [leaf('direction', 'equals', 'out'), { match: 'any', leaves: [leaf('merchant', 'equals', 'Uber'), leaf('merchant', 'equals', '99')] }] };
  assert.equal(conditionsError(c), null);
  assert.equal(matches(subject(), c), true);
  assert.equal(matches(subject({ merchant: 'Rappi' }), c), false);
  const nested = { match: 'all', items: [{ match: 'any', leaves: [{ match: 'any', leaves: [leaf('mcc', 'equals', '1')] }] }] };
  assert.match(conditionsError(nested) ?? '', /cannot hold another group/);
});

test('a blank value never matches and cannot be saved', () => {
  assert.match(conditionsError(all(leaf('description', 'contains', ''))) ?? '', /cannot be empty/);
  assert.match(conditionsError(all(leaf('description', 'contains', '   '))) ?? '', /cannot be empty/);
  assert.equal(matches(subject(), all(leaf('description', 'contains', ''))), false, 'an old saved rule with a blank value is also guarded at match time');
  assert.equal(matches(subject({ amount: 0 }), all(leaf('amount', 'equals', 0))), true, 'zero is a real amount');
});

test('regex must compile, must not match empty text, and runs without accents or case', () => {
  assert.equal(typeof compileRegex('a*'), 'string');
  assert.equal(typeof compileRegex('('), 'string');
  assert.equal(typeof compileRegex('(a+)+$'), 'string', 'a repeated repeated group is refused');
  assert.equal(typeof compileRegex('x'.repeat(200)), 'string');
  assert.ok(compileRegex('ita[uú]') instanceof RegExp);
  assert.equal(matches(subject(), all(leaf('institution', 'regex', '^ita\\w$'))), true);
  assert.equal(matches(subject(), all(leaf('description', 'regex', '\\bTRIP\\b'))), true);
});

test('enum, operator and field checks', () => {
  assert.match(conditionsError(all(leaf('status', 'equals', 'done'))) ?? '', /not a valid status/);
  assert.match(conditionsError(all(leaf('status', 'contains', 'pending'))) ?? '', /does not work with status/);
  assert.match(conditionsError(all(leaf('color', 'equals', 'red'))) ?? '', /unknown field/);
  assert.match(conditionsError(all(leaf('amount', 'gt', 12.5))) ?? '', /whole number of cents/);
  assert.match(conditionsError(all(leaf('date', 'gte', '28/10/2026'))) ?? '', /date must look like/);
  assert.equal(matches(subject({ role: '' }), all(leaf('role', 'equals', 'none'))), true);
  assert.equal(matches(subject({ date: '2026-10-20' }), all(leaf('date', 'gte', '2026-10-01'), leaf('date', 'lt', '2026-11-01'))), true);
  assert.equal(conditionsError({ match: 'all', items: [] }) !== null, true);
});

test('the first active rule by priority wins, and a specific rule at a lower number beats a general one', () => {
  const general = rule(1, 10, all(leaf('merchant', 'equals', 'Uber')), 'Transporte por aplicativo');
  const specific = rule(2, 5, all(leaf('merchant', 'equals', 'Uber'), leaf('amount', 'gt', -3000)), 'Corridas curtas');
  const off = rule(3, 1, all(leaf('merchant', 'equals', 'Uber')), 'Nunca', false);
  const ordered = sortRules([general, specific, off]);
  assert.deepEqual(ordered.map((r) => r.id), [3, 2, 1]);
  assert.equal(categoryFromRules(subject(), ordered)?.category, 'Corridas curtas');
  assert.equal(categoryFromRules(subject({ amount: -9000 }), ordered)?.category, 'Transporte por aplicativo');
  assert.equal(categoryFromRules(subject({ merchant: 'Rappi' }), ordered), null);
  assert.equal(sortRules([rule(9, 5, all(), 'x'), rule(4, 5, all(), 'y')])[0]?.id, 4, 'equal priorities go by id');
});
