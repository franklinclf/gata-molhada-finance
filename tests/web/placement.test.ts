import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placePanel } from '../../web/src/placement.ts';

const viewport = { width: 1000, height: 800 };
const box = (left: number, top: number, width = 40, height = 36) => ({ left, top, right: left + width, bottom: top + height });

test('a panel opens under its button, left or right aligned to it', () => {
  const panel = { width: 200, height: 160 };
  assert.deepEqual(placePanel(box(300, 100), panel, viewport, 'left'), { left: 300, top: 142, maxHeight: 650, side: 'below' });
  assert.equal(placePanel(box(700, 100), panel, viewport, 'right').left, 540);
});

test('a panel is pushed back inside the viewport on both sides', () => {
  const panel = { width: 200, height: 160 };
  assert.equal(placePanel(box(10, 100), panel, viewport, 'right').left, 8);
  assert.equal(placePanel(box(950, 100), panel, viewport, 'left').left, 792);
  // Wider than the screen: it starts at the margin instead of going negative.
  assert.equal(placePanel(box(100, 100), { width: 2000, height: 100 }, viewport, 'left').left, 8);
});

test('a panel flips above its button when that side has more room, and scrolls when neither fits', () => {
  const panel = { width: 200, height: 300 };
  const flipped = placePanel(box(300, 700), panel, viewport, 'left');
  assert.deepEqual([flipped.side, flipped.top], ['above', 394]);
  const stays = placePanel(box(300, 100), panel, viewport, 'left');
  assert.equal(stays.side, 'below');
  const tight = placePanel(box(300, 400), { width: 200, height: 900 }, viewport, 'left');
  assert.deepEqual([tight.side, tight.maxHeight, tight.top], ['above', 386, 8]);
});
