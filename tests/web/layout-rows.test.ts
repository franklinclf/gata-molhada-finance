import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WidgetId } from '../../web/src/api.ts';
import { shiftReading, widgetRows } from '../../web/src/layout-rows.ts';

const item = (id: string, widget: string, x: number, y: number, w = 4, h = 2) => ({ id, widget: widget as WidgetId, x, y, w, h });
const ALL = ['a', 'b', 'c', 'd'] as unknown as WidgetId[];

test('widgetRows lists shown widgets in reading order, then the hidden ones', () => {
  const rows = widgetRows([item('2', 'b', 0, 4), item('1', 'a', 0, 0), item('3', 'c', 4, 0)], ALL, false);
  assert.deepEqual(rows.map((r) => [r.widget, r.item?.id ?? null]), [['a', '1'], ['c', '3'], ['b', '2'], ['d', null]]);
  assert.deepEqual(rows.map((r) => [r.canUp, r.canDown]), [[false, true], [true, true], [true, false], [false, false]]);
});

test('widgetRows follows the packed stack on the phone', () => {
  const rows = widgetRows([item('2', 'b', 0, 9, 2), item('1', 'a', 0, 0, 1)], ALL, true);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.widget), ['a', 'b']);
});

test('shiftReading swaps two widgets in reading order and keeps the list order', () => {
  const items = [item('1', 'a', 0, 0), item('2', 'b', 0, 2), item('3', 'c', 0, 4)];
  const down = shiftReading(items, '1', 1, 12);
  assert.deepEqual(down.map((i) => i.id), ['1', '2', '3']);
  const byId = (id: string) => down.find((i) => i.id === id)!;
  assert.ok(byId('2').y < byId('1').y || (byId('2').y === byId('1').y && byId('2').x < byId('1').x));
  assert.ok(byId('1').y > 0 || byId('1').x > 0);
  assert.ok(byId('3').y >= byId('2').y);
});

test('shiftReading at the edge or with an unknown id changes nothing', () => {
  const items = [item('1', 'a', 0, 0), item('2', 'b', 0, 2)];
  assert.equal(shiftReading(items, '1', -1, 12), items);
  assert.equal(shiftReading(items, '2', 1, 12), items);
  assert.equal(shiftReading(items, 'x', 1, 12), items);
});
