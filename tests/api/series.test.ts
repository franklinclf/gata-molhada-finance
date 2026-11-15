import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSeries, type SeriesMember } from '../../src/api/series.ts';

const member = (id: string, number: number, amount: number, description: string, billCycle: string | null): SeriesMember => ({
  id, accountId: 'c1', amount: -amount, description, excluded: false, installment: { number, total: 3 }, billCycle,
});

const groups = (list: SeriesMember[]) => [...groupSeries(list).values()].map((g) => g.map((t) => t.id).sort());

test('a bank that cuts the text of some installments still gives one purchase when each charge sits in the bill its number says', () => {
  const list = [
    member('a1', 1, 3334, 'STORE', '2026-09'),
    member('a2', 2, 3333, 'STORE *ONLINE SA', '2026-10'),
    member('a3', 3, 3333, 'STORE', '2026-11'),
  ];
  assert.deepEqual(groups(list), [['a1', 'a2', 'a3']]);
});

test('a cut text does not join a series whose bills do not follow the numbers', () => {
  const list = [
    member('a1', 1, 3334, 'STORE', '2026-09'),
    member('a2', 2, 3333, 'STORE *ONLINE SA', '2026-12'),
  ];
  assert.deepEqual(groups(list), [['a1'], ['a2']]);
});

test('a cut text does not join a series when a bill is unknown', () => {
  const list = [
    member('a1', 1, 3334, 'STORE', '2026-09'),
    member('a2', 2, 3333, 'STORE *ONLINE SA', null),
  ];
  assert.deepEqual(groups(list), [['a1'], ['a2']]);
});

test('a text too short to name a purchase, such as two letters, never joins another', () => {
  const list = [
    member('a1', 1, 3334, 'AB', '2026-09'),
    member('a2', 2, 3333, 'AB *ONLINE SA', '2026-10'),
  ];
  assert.deepEqual(groups(list), [['a1'], ['a2']]);
});
