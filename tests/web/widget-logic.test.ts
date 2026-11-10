import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitFontSize, MIN_FIT_FONT } from '../../web/src/fit-text.ts';
import { oldestFirst } from '../../web/src/freshness-order.ts';
import { DEFAULT_WINDOW, monthsCovering, parseWindow, upcomingItems, upcomingTotals } from '../../web/src/upcoming.ts';

test('a figure that fits keeps its size, one that does not shrinks to the box and stops at the floor', () => {
  assert.equal(fitFontSize(18, 80, 100), 18);
  assert.equal(fitFontSize(20, 200, 100), 10);
  assert.equal(fitFontSize(20, 1000, 100), MIN_FIT_FONT);
  assert.equal(fitFontSize(20, 100, 0), 20);
});

test('the upcoming window accepts 1 to 90 days and falls back to 14', () => {
  assert.equal(parseWindow(undefined), DEFAULT_WINDOW);
  assert.equal(parseWindow('30'), 30);
  assert.equal(parseWindow('1'), 1);
  assert.equal(parseWindow('90'), 90);
  for (const bad of ['0', '91', '-3', '2.5', 'abc', '']) assert.equal(parseWindow(bad), DEFAULT_WINDOW, bad);
});

test('the months to load cover the whole window, across a year end', () => {
  assert.deepEqual(monthsCovering('2026-11-10', 14), ['2026-11']);
  assert.deepEqual(monthsCovering('2026-11-25', 14), ['2026-11', '2026-12']);
  assert.deepEqual(monthsCovering('2026-11-10', 90), ['2026-11', '2026-12', '2027-01', '2027-02']);
});

test('the upcoming items are the ones from today to the end of the window, each day once, with the sums', () => {
  const day = (d: string, ...p: Array<[string, number, 'in' | 'out']>) => ({ day: d, inflow: 0, outflow: 0, balance: null, projected: p.map(([name, amount, direction]) => ({ name, amount, direction, kind: 'recurring' as const, late: false })) });
  const days = [day('2026-11-09', ['Passado', 100, 'out']), day('2026-11-12', ['Aluguel', 150_000, 'out']), day('2026-11-12', ['Aluguel', 150_000, 'out']), day('2026-11-20', ['Salário', 500_000, 'in']), day('2026-11-25', ['Longe', 9_000, 'out']), day('2026-11-24', ['Internet', 12_000, 'out'])];
  const items = upcomingItems(days, '2026-11-10', 14);
  assert.deepEqual(items.map((i) => i.name), ['Aluguel', 'Salário', 'Internet']);
  assert.deepEqual(upcomingTotals(items), { out: 162_000, in: 500_000, count: 3 });
  assert.equal(upcomingItems(days, '2026-11-10', 15).length, 4);
  assert.equal(upcomingItems(days, '2026-11-10', 90).length, 4);
});

test('sources are listed with the oldest reading first and never-read ones before all', () => {
  const list = oldestFirst([{ n: 'b', lastUpdatedAt: '2026-11-09T10:00:00Z' }, { n: 'c', lastUpdatedAt: null }, { n: 'a', lastUpdatedAt: '2026-11-01T10:00:00Z' }]);
  assert.deepEqual(list.map((s) => s.n), ['c', 'a', 'b']);
});
