import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activePreset, coverage, dayBounds, daysInMonth, formatDay, isWholeYear, lastDayOf, withDay, pickMonth, rangeLabel, RANGE_PRESETS, yearRange } from '../../web/src/month-range.ts';

const today = '2026-11-15';

test('the first month click picks that month, the second covers both', () => {
  const first = pickMonth(null, '2026-03', today);
  assert.deepEqual(first, { anchor: '2026-03', range: { from: '2026-03-01', to: '2026-03-31' } });
  const second = pickMonth(first.anchor, '2026-01', today);
  assert.deepEqual(second, { anchor: null, range: { from: '2026-01-01', to: '2026-03-31' } });
  // The current month ends today.
  assert.deepEqual(pickMonth('2026-10', '2026-11', today).range, { from: '2026-10-01', to: today });
});

test('a year is the whole year', () => {
  assert.deepEqual(yearRange(2026, today), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(yearRange(2027, today), { from: '2027-01-01', to: '2027-12-31' });
  assert.equal(isWholeYear(2026, yearRange(2026, today), today), true);
  assert.equal(isWholeYear(2026, { from: '2026-02-01', to: today }, today), false);
});

test('coverage tells full, partial and untouched months', () => {
  const range = { from: '2026-03-10', to: '2026-05-31' };
  assert.equal(coverage('2026-02', range, today), 'none');
  assert.equal(coverage('2026-03', range, today), 'part');
  assert.equal(coverage('2026-04', range, today), 'full');
  assert.equal(coverage('2026-06', range, today), 'none');
  assert.equal(coverage('2026-06', {}, today), 'full');
});

test('days offered follow the real length of the month', () => {
  assert.deepEqual([daysInMonth('2026-02'), daysInMonth('2028-02'), daysInMonth('2026-04'), daysInMonth('2026-12')], [28, 29, 30, 31]);
  assert.equal(lastDayOf('2026-02', '2026-05-10'), 28);
  // The current month stops at today.
  assert.equal(lastDayOf('2026-05', '2026-05-10'), 10);
  assert.equal(formatDay('2026-03-05'), '05/03/2026');
  assert.equal(formatDay(undefined), '');
});

test('day pickers need a range, and inside one month the two sides cannot cross', () => {
  assert.equal(dayBounds({}, 'from', today), null);
  assert.equal(dayBounds({ from: '2026-03-01' }, 'to', today), null);
  const span = { from: '2026-02-01', to: '2026-04-30' };
  assert.deepEqual([dayBounds(span, 'from', today), dayBounds(span, 'to', today)], [{ min: 1, max: 28 }, { min: 1, max: 30 }]);
  const one = { from: '2026-03-05', to: '2026-03-20' };
  assert.deepEqual([dayBounds(one, 'from', today), dayBounds(one, 'to', today)], [{ min: 1, max: 20 }, { min: 5, max: 31 }]);
});

test('withDay keeps the month and pulls an out of range day inside', () => {
  const span = { from: '2026-02-01', to: '2026-04-30' };
  assert.deepEqual(withDay(span, 'from', 15, today), { from: '2026-02-15', to: '2026-04-30' });
  assert.deepEqual(withDay(span, 'from', 31, today), { from: '2026-02-28', to: '2026-04-30' });
  assert.deepEqual(withDay(span, 'to', 0, today), { from: '2026-02-01', to: '2026-04-01' });
  const one = { from: '2026-03-05', to: '2026-03-20' };
  assert.deepEqual(withDay(one, 'to', 2, today), { from: '2026-03-05', to: '2026-03-05' });
  assert.deepEqual(withDay({}, 'from', 3, today), {});
});

test('presets and labels', () => {
  const by = (id: string) => RANGE_PRESETS.find((p) => p.id === id)!.range(today);
  assert.deepEqual(by('month'), { from: '2026-11-01', to: today });
  assert.deepEqual(by('last'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(by('3m'), { from: '2026-09-01', to: today });
  assert.deepEqual(by('all'), {});
  assert.equal(activePreset({ from: '2026-10-01', to: '2026-10-31' }, today)?.id, 'last');
  assert.equal(activePreset({ from: '2026-10-02', to: '2026-10-31' }, today), undefined);
  assert.equal(rangeLabel({}, today), 'Todo o período');
  assert.equal(rangeLabel(by('last'), today), 'out/2026');
  assert.equal(rangeLabel(by('3m'), today), 'set/2026 a nov/2026');
  assert.equal(rangeLabel(by('year'), today), '2026');
  assert.equal(rangeLabel({ from: '2026-10-05', to: '2026-10-20' }, today), '05/10/2026 a 20/10/2026');
  assert.equal(rangeLabel({ from: '2026-10-05' }, today), '05/10/2026 a hoje');
});
