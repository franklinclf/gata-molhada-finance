import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idsBetween, movedTooFar, newRows, stepIndex, toggleId, withRange } from '../../web/src/row-selection.ts';

const order = ['a', 'b', 'c', 'd', 'e'];

test('a hold is cancelled only when the finger drifts past the tolerance', () => {
  assert.equal(movedTooFar({ x: 0, y: 0 }, { x: 4, y: 4 }), false);
  assert.equal(movedTooFar({ x: 0, y: 0 }, { x: 0, y: 14 }), true);
});

test('a range goes in either direction and includes both ends', () => {
  assert.deepEqual(idsBetween(order, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(idsBetween(order, 'd', 'b'), ['b', 'c', 'd']);
  assert.deepEqual(idsBetween(order, 'a', 'zz'), ['a']);
});

test('a range joins the selection without repeats, and keeps picks outside the loaded list', () => {
  assert.deepEqual(withRange(['c', 'old'], order, 'b', 'd'), ['b', 'c', 'd', 'old']);
});

test('toggle and step', () => {
  assert.deepEqual(toggleId(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleId(['a', 'b'], 'a'), ['b']);
  assert.equal(stepIndex(0, -1, 5), 0);
  assert.equal(stepIndex(4, 1, 5), 4);
  assert.equal(stepIndex(2, 1, 5), 3);
});

test('a page adds only rows not loaded yet', () => {
  assert.deepEqual(newRows([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]), [{ id: 'c' }]);
});
