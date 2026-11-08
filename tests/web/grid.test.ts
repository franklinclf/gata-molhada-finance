import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampBox, collapseEmpty, collapsedHeight, collides, compact, fitToColumns, freeSlot, place, rowsFit, sizeClass, type Box } from '../../web/src/grid.ts';

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

test('wide screens get more columns, and widgets spread over them', async () => {
  const { columnsFor, reflow, sizeClassPx } = await import('../../web/src/grid.ts');
  assert.equal(columnsFor(1000, 14), 12);
  assert.equal(columnsFor(2600, 14), 20);
  assert.equal(columnsFor(9000, 14), 36);
  const spread = reflow([{ id: 'a', x: 0, y: 0, w: 4, h: 5 }, { id: 'b', x: 0, y: 5, w: 4, h: 5 }, { id: 'c', x: 0, y: 10, w: 4, h: 5 }, { id: 'd', x: 0, y: 15, w: 4, h: 5 }], 16);
  assert.deepEqual(spread.map((i) => [i.x, i.y]), [[0, 0], [4, 0], [8, 0], [12, 0]]);
  assert.equal(sizeClassPx(300, 300), 'sm');
  assert.equal(sizeClassPx(320, 588), 'md');
  assert.equal(sizeClassPx(1000, 600), 'lg');
  assert.equal(sizeClassPx(900, 200), 'md');
});

const noOverlap = (items: Box[]) => {
  for (const p of items) for (const q of items) if (p !== q) assert.equal(collides(p, q), false, `${p.id} overlaps ${q.id}`);
};

test('a layout saved on a wider screen never overlaps on 12 columns, and what already fits stays where it is', () => {
  // Saved on 15 columns: three widgets sit at x 12 with w 3, beside others laid out inside 12.
  const saved = [box('a', 0, 0, 4, 6), box('b', 4, 0, 2, 2), box('c', 8, 0, 4, 5), box('d', 12, 0, 3, 4), box('e', 12, 4, 3, 4), box('f', 8, 5, 4, 7)];
  const out = fitToColumns(saved, 12);
  noOverlap(out);
  for (const i of out) assert.ok(i.x + i.w <= 12, `${i.id} is past the last column`);
  for (const id of ['a', 'b', 'c', 'f']) assert.deepEqual(at(out, id), at(saved, id));
  assert.deepEqual(out.map((i) => i.id), saved.map((i) => i.id));
  assert.deepEqual(out.map((i) => i.h), saved.map((i) => i.h));
});

test('a layout that fits is returned untouched, and a widget wider than the grid is narrowed', () => {
  const fits = [box('a', 0, 0, 6, 4), box('b', 6, 0, 6, 4)];
  assert.equal(fitToColumns(fits, 12), fits);
  const out = fitToColumns([box('a', 0, 0, 12, 3), box('wide', 3, 3, 20, 3)], 12);
  assert.equal(at(out, 'wide').w, 12);
  noOverlap(out);
});

test('a saved layout that already overlaps inside the grid is spread out', () => {
  const out = fitToColumns([box('a', 0, 0, 6, 4), box('b', 3, 0, 6, 4), box('c', 14, 0, 4, 4)], 12);
  noOverlap(out);
  for (const i of out) assert.ok(i.x + i.w <= 12);
});

test('widgets with nothing to show shrink to a line and the ones below move up', () => {
  const items = [box('a', 0, 0, 4, 5), box('empty', 4, 0, 4, 5), box('b', 4, 5, 4, 3)];
  const out = collapseEmpty(items, new Set(['empty']));
  assert.equal(at(out, 'empty').h, collapsedHeight(4));
  assert.equal(at(out, 'b').y, collapsedHeight(4));
  assert.equal(at(out, 'a').h, 5);
  noOverlap(out);
  assert.equal(collapseEmpty(items, new Set()), items);
  assert.equal(collapsedHeight(2), 2);
});

test('a widget already shorter than a line is not stretched when it collapses', () => {
  assert.equal(at(collapseEmpty([box('a', 0, 0, 4, 1)], new Set(['a'])), 'a').h, 1);
});
