import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, brl, brlShort, cumulative, dayMonth, isStale, localDay, MASK, periodRange } from '../../web/src/format.ts';
import { moveWidget, toggleWidget } from '../../web/src/layout.ts';
import { defaultLayout } from '../../src/api/layout.ts';

const NOW = new Date('2026-10-27T15:00:00Z');

test('brl formats cents as reais and hides the value on request', () => {
  assert.match(brl(123456), /^R\$\s?1\.234,56$/);
  assert.equal(brl(123456, true), MASK);
  assert.equal(brlShort(250000), '2,5 mil');
  assert.equal(brlShort(12345), '123');
  assert.equal(brlShort(12345, true), '••••');
});

test('ago and isStale describe how old the data is', () => {
  assert.equal(ago(null, NOW), 'sem data');
  assert.equal(ago('2026-10-27T14:59:40Z', NOW), 'agora');
  assert.equal(ago('2026-10-27T14:45:00Z', NOW), 'há 15 min');
  assert.equal(ago('2026-10-27T09:00:00Z', NOW), 'há 6 h');
  assert.equal(ago('2026-10-20T15:00:00Z', NOW), 'há 7 dias');
  assert.equal(isStale('2026-10-27T10:00:00Z', NOW), false);
  assert.equal(isStale('2026-10-27T08:00:00Z', NOW), true);
  assert.equal(isStale(null, NOW), true);
});

test('local days use Brazil time', () => {
  assert.equal(localDay('2026-10-27T02:30:00Z'), '2026-10-26');
  assert.equal(dayMonth('2026-10-05'), '05/10');
});

test('periodRange starts on the first day of the month, counting back', () => {
  assert.deepEqual(periodRange('month', NOW), { from: '2026-10-01', to: '2026-10-27' });
  assert.deepEqual(periodRange('3m', NOW), { from: '2026-08-01', to: '2026-10-27' });
  assert.deepEqual(periodRange('1y', NOW), { from: '2025-11-01', to: '2026-10-27' });
  assert.deepEqual(periodRange('6m', new Date('2026-02-10T12:00:00Z')), { from: '2025-09-01', to: '2026-02-10' });
});

test('cumulative gives one running total per day, filling days without spending', () => {
  assert.deepEqual(cumulative([{ day: '2026-10-02', amount: 100 }, { day: '2026-10-04', amount: 50 }], '2026-10-01', '2026-10-05'), [0, 100, 100, 150, 150]);
});

test('layout helpers move and toggle widgets without changing the original', () => {
  const layout = defaultLayout();
  const first = layout.widgets[0]!.id;
  const second = layout.widgets[1]!.id;
  const moved = moveWidget(layout, first, 1);
  assert.deepEqual(moved.widgets.slice(0, 2).map((w) => w.id), [second, first]);
  assert.equal(layout.widgets[0]!.id, first);
  assert.equal(moveWidget(layout, first, -1), layout);
  assert.equal(toggleWidget(layout, first).widgets[0]!.hidden, true);
});
