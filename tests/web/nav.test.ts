import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNavOrder, moveNavItem, shiftNavItem, topNavItem } from '../../web/src/nav.ts';

const known = ['a', 'b', 'c', 'd'];

test('a saved order keeps its sequence, drops unknown ids and puts new sections at the end', () => {
  assert.deepEqual(applyNavOrder(['c', 'x', 'a'], known), ['c', 'a', 'b', 'd']);
  assert.deepEqual(applyNavOrder([], known), known);
  assert.deepEqual(applyNavOrder(['b', 'b'], known), ['b', 'a', 'c', 'd']);
});

test('shifting moves one step and stops at the edges', () => {
  assert.deepEqual(shiftNavItem(known, 'c', -1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(shiftNavItem(known, 'b', 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(shiftNavItem(known, 'a', -1), known);
  assert.deepEqual(shiftNavItem(known, 'd', 1), known);
  assert.deepEqual(shiftNavItem(known, 'zz', 1), known);
});

test('dropping on another section puts the dragged one right before it', () => {
  assert.deepEqual(moveNavItem(known, 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveNavItem(known, 'a', 'a'), known);
  assert.deepEqual(moveNavItem(known, 'a', 'zz'), known);
});

test('sending a section to the top keeps the others in order and ignores unknown or first ids', () => {
  assert.deepEqual(topNavItem(known, 'd'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(topNavItem(known, 'a'), known);
  assert.deepEqual(topNavItem(known, 'zz'), known);
});
