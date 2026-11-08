import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineExtent } from '../../web/src/chart-scale.ts';

test('a running total is drawn from zero, a fitted line from its lowest point', () => {
  assert.deepEqual(lineExtent([4000, 9000, 7000], 'zero'), { min: 0, max: 9000 });
  assert.deepEqual(lineExtent([4000, 9000, 7000], 'fit'), { min: 4000, max: 9000 });
  assert.deepEqual(lineExtent([-500, 300], 'zero'), { min: -500, max: 300 });
  assert.deepEqual(lineExtent([-500, -200], 'fit'), { min: -500, max: -200 });
});

test('a flat or empty series still has a range to divide by', () => {
  const flat = lineExtent([700, 700, 700], 'fit');
  assert.ok(flat.max > flat.min);
  assert.deepEqual(lineExtent([0, 0], 'zero'), { min: 0, max: 1 });
  assert.deepEqual(lineExtent([], 'fit'), { min: 0, max: 1 });
});
