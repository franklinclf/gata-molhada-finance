import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampBox, collides, compact, freeSlot, place, rowsFit, sizeClass, type Box } from '../../web/src/grid.ts';

const box = (id: string, x: number, y: number, w: number, h: number): Box => ({ id, x, y, w, h });
const at = (items: Box[], id: string) => items.find((i) => i.id === id)!;

test('collides only when rectangles overlap, not when they touch', () => {
  assert.equal(collides(box('a', 0, 0, 4, 4), box('b', 4, 0, 4, 4)), false);
  assert.equal(collides(box('a', 0, 0, 4, 4), box('b', 0, 4, 4, 4)), false);
  assert.equal(collides(box('a', 0, 0, 4, 4), box('b', 3, 3, 4, 4)), true);
});

test('compact lifts boxes into the gaps above them', () => {
  const out = compact([box('a', 0, 0, 4, 4), box('b', 0, 10, 4, 4), box('c', 4, 7, 4, 3)]);
  assert.deepEqual([at(out, 'b').y, at(out, 'c').y], [4, 0]);
});

test('clampBox keeps a box inside the grid and above the size limits', () => {
  assert.deepEqual(clampBox(box('a', 10, -3, 6, 1)), { id: 'a', x: 6, y: 0, w: 6, h: 2 });
  assert.deepEqual(clampBox(box('a', 0, 0, 20, 99)), { id: 'a', x: 0, y: 0, w: 12, h: 40 });
});

test('moving a box onto another pushes it down and nothing overlaps afterwards', () => {
  const items = [box('a', 0, 0, 4, 4), box('b', 4, 0, 4, 4), box('c', 8, 0, 4, 4)];
  const out = place(items, 'a', { x: 4, y: 0 });
  assert.deepEqual([at(out, 'a').x, at(out, 'a').y], [4, 0]);
  assert.ok(at(out, 'b').y >= 4 || at(out, 'b').x !== 4);
  for (const p of out) for (const q of out) if (p !== q) assert.equal(collides(p, q), false, `${p.id} overlaps ${q.id}`);
});

test('resizing a box pushes neighbours below it', () => {
  const items = [box('a', 0, 0, 6, 4), box('b', 0, 4, 6, 4)];
  const out = place(items, 'a', { h: 6 });
  assert.equal(at(out, 'a').h, 6);
  assert.equal(at(out, 'b').y, 6);
});

test('dropping a box into empty space above settles it at the top', () => {
  const out = place([box('a', 0, 0, 4, 4), box('b', 4, 8, 4, 4)], 'b', { x: 4, y: 20 });
  assert.equal(at(out, 'b').y, 0);
});

test('place ignores an unknown id and keeps the order of the list', () => {
  const items = [box('a', 0, 0, 4, 4), box('b', 4, 0, 4, 4)];
  assert.equal(place(items, 'zzz', { x: 1 }), items);
  assert.deepEqual(place(items, 'b', { x: 8 }).map((i) => i.id), ['a', 'b']);
});

test('freeSlot finds the first gap, scanning left to right and down', () => {
  assert.deepEqual(freeSlot([], 4, 4), { x: 0, y: 0 });
  assert.deepEqual(freeSlot([box('a', 0, 0, 4, 4)], 4, 4), { x: 4, y: 0 });
  assert.deepEqual(freeSlot([box('a', 0, 0, 12, 4)], 4, 4), { x: 0, y: 4 });
  assert.deepEqual(freeSlot([box('a', 0, 0, 8, 4), box('b', 0, 4, 4, 2)], 6, 2), { x: 4, y: 4 });
});

test('the size class follows the cells a widget has', () => {
  assert.equal(sizeClass(3, 6), 'sm');
  assert.equal(sizeClass(6, 3), 'sm');
  assert.equal(sizeClass(4, 5), 'md');
  assert.equal(sizeClass(8, 6), 'lg');
  assert.equal(sizeClass(6, 8), 'lg');
  assert.equal(rowsFit(3), 0);
  assert.ok(rowsFit(10) > rowsFit(6));
});
