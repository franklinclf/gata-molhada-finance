import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstRevealed, revealDelta } from '../../web/src/reveal.ts';

test('the first revealed row is the first one that was hidden', () => {
  assert.equal(firstRevealed(12, 7), 5);
  assert.equal(firstRevealed(12, 0), 11);
  assert.equal(firstRevealed(3, 9), 0);
});

test('the scroll distance brings the row to the foot of the head', () => {
  assert.equal(revealDelta(420.4, 180), 240);
  assert.equal(revealDelta(150, 180), -30);
});
