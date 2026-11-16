import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centsToPosition, clampHandles, positionToCents, STEPS } from '../../web/src/amount-slider.ts';

test('the ends map to the minimum and the maximum', () => {
  assert.equal(positionToCents(0, 250, 5_000_000), 250);
  assert.equal(positionToCents(STEPS, 250, 5_000_000), 5_000_000);
  assert.equal(centsToPosition(250, 250, 5_000_000), 0);
  assert.equal(centsToPosition(5_000_000, 250, 5_000_000), STEPS);
});

test('the scale is logarithmic: the first half stays among small amounts', () => {
  const half = positionToCents(STEPS / 2, 100, 10_000_000);
  assert.ok(half > 20_000 && half < 60_000, `half was ${half}`);
  let last = -1;
  for (let p = 0; p <= STEPS; p += 50) {
    const v = positionToCents(p, 100, 10_000_000);
    assert.ok(v >= last);
    last = v;
  }
});

test('a position survives the round trip within a step', () => {
  for (const cents of [500, 2_000, 15_000, 120_000, 2_000_000]) {
    const back = positionToCents(centsToPosition(cents, 100, 10_000_000), 100, 10_000_000);
    assert.ok(Math.abs(back - cents) / cents < 0.05, `${cents} came back as ${back}`);
  }
});

test('a flat range does not divide by zero', () => {
  assert.equal(positionToCents(300, 500, 500), 500);
  assert.equal(centsToPosition(500, 500, 500), 0);
});

test('the handles never cross', () => {
  assert.deepEqual(clampHandles(300, 700, 'low'), [300, 700]);
  assert.deepEqual(clampHandles(800, 700, 'low'), [700, 700]);
  assert.deepEqual(clampHandles(300, 200, 'high'), [300, 300]);
});
