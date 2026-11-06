import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowColumns } from '../../web/src/flow.ts';
import { chartHeight, shareLabel } from '../../web/src/grid.ts';

test('a chart takes the room left under the other content, within its limits', () => {
  assert.equal(chartHeight({ width: 400, height: 418 }, 270, 90, 260), 148);
  assert.equal(chartHeight({ width: 400, height: 300 }, 270, 90, 260), 90);
  assert.equal(chartHeight({ width: 400, height: 900 }, 270, 90, 260), 260);
  assert.equal(chartHeight(undefined, 270, 90, 260), 90);
});

test('a positive share that rounds to nothing reads "<1%", never "0%"', () => {
  assert.equal(shareLabel(0.003), '<1%');
  assert.equal(shareLabel(0), '0%');
  assert.equal(shareLabel(0.005), '1%');
  assert.equal(shareLabel(0.456), '46%');
  assert.equal(shareLabel(1.33), '133%');
});

test('a month is drawn day by day, with empty days kept and only some days labelled', () => {
  const columns = flowColumns([{ day: '2026-11-03', inflow: 500, outflow: 200 }], '2026-11-01', '2026-11-06', true);
  assert.deepEqual(columns.map((c) => c.key), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  assert.deepEqual(columns.map((c) => c.label), ['1', '', '', '', '5', '']);
  assert.deepEqual([columns[2]!.inflow, columns[2]!.outflow, columns[1]!.inflow], [500, 200, 0]);
});

test('a longer period is summed by month', () => {
  const days = [
    { day: '2026-09-10', inflow: 100, outflow: 40 },
    { day: '2026-09-20', inflow: 50, outflow: 10 },
    { day: '2026-11-02', inflow: 0, outflow: 70 },
  ];
  const columns = flowColumns(days, '2026-09-01', '2026-11-06', false);
  assert.deepEqual(columns.map((c) => c.key), ['2026-09', '2026-10', '2026-11']);
  assert.deepEqual(columns.map((c) => [c.inflow, c.outflow]), [[150, 50], [0, 0], [0, 70]]);
});
