import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ariaChecked, boxState, nextCheck } from '../../web/src/checkbox.ts';

test('a select-all box is on for all rows, mixed for some and off for none', () => {
  assert.equal(boxState(0, 10), 'off');
  assert.equal(boxState(3, 10), 'some');
  assert.equal(boxState(10, 10), 'on');
  assert.equal(boxState(0, 0), 'off');
  assert.equal(boxState(12, 10), 'on');
});

test('a click turns a partly or not at all checked box on, and a full one off', () => {
  assert.deepEqual((['off', 'some', 'on'] as const).map(nextCheck), [true, true, false]);
});

test('aria-checked says mixed for the partial state', () => {
  assert.deepEqual((['off', 'some', 'on'] as const).map(ariaChecked), ['false', 'mixed', 'true']);
});
