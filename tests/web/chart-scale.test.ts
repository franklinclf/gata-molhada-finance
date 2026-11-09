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

test('axis labels: every column when they fit, otherwise a step, always the first and the last without touching', async () => {
  const { labelPlan } = await import('../../web/src/chart-scale.ts');
  const roomy = labelPlan(12, 600, 30, 6);
  assert.ok(roomy.every(Boolean));
  const days = labelPlan(30, 300, 20, 6);
  const at = days.flatMap((on, i) => (on ? [i] : []));
  assert.equal(at[0], 0);
  assert.equal(at[at.length - 1], 29);
  assert.ok(at.length < 30 && at.length > 2);
  const gaps = at.slice(1).map((v, i) => v - at[i]!);
  assert.ok(Math.min(...gaps) >= 2);
  const wide = labelPlan(30, 900, 20, 6);
  assert.ok(wide.every(Boolean));
  assert.deepEqual(labelPlan(0, 300, 20), []);
  assert.deepEqual(labelPlan(1, 10, 20), [true]);
});
