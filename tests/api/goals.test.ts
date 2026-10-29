import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { addAsset, setAssetValue } from '../../src/api/networth.ts';
import { createGoal, deleteGoal, evaluate, listGoals, updateGoal } from '../../src/api/goals.ts';
import { apiRoute } from '../../src/api/routes.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import type { Goal } from '../../src/store/store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-20T15:00:00Z');
const T = NOW.toISOString();

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pluggy', kind: 'test', capabilities: {} }, T);
  store.replaceCanonicalAccounts([{ id: 'sav', institution: 'Banco', kind: 'savings', name: 'Reserva', last4: null, balance: 200000, balanceSourceId: 'pluggy', balanceAsOf: T, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null, limitGroupId: null, refs: [] }], [], T);
  return store;
}

const goal = (extra: Partial<Goal> = {}): Goal => ({ id: 1, name: 'Viagem', target: 1000000, targetDay: '2027-10-20', track: 'manual', trackRef: null, saved: 0, initial: 0, createdDay: '2026-10-20', archived: false, ...extra });

test('progress is how much of the target is reached, and the pace is judged from where the goal began', () => {
  const g = goal({ initial: 200000, target: 1000000, createdDay: '2026-01-01', targetDay: '2027-01-01' });
  assert.equal(evaluate(g, 600000, false, '2026-07-02').progress, 0.6);
  assert.equal(evaluate(g, 1200000, false, '2026-07-02').progress, 1, 'capped at the whole');
  // Halfway through the year with 2.000 of 10.000 at the start: 6.000 is half of the distance, on pace even though 60% looks ahead.
  assert.equal(evaluate(g, 600000, false, '2026-07-02').status, 'on_track');
  assert.equal(evaluate(g, 300000, false, '2026-07-02').status, 'behind');
  assert.equal(evaluate(goal({ initial: 1000000 }), 1000000, false, '2026-10-20').status, 'achieved');
});

test('status: ahead, on track, behind, overdue and achieved, with the monthly amount needed', () => {
  const g = goal({ createdDay: '2026-01-01', targetDay: '2027-01-01', target: 1200000 });
  const at = (current: number, today: string) => evaluate(g, current, false, today);
  assert.equal(at(800000, '2026-07-02').status, 'ahead', 'half the year gone, two thirds done');
  assert.equal(at(600000, '2026-07-02').status, 'on_track');
  assert.equal(at(300000, '2026-07-02').status, 'behind');
  assert.equal(at(300000, '2027-02-01').status, 'overdue');
  assert.equal(at(1200000, '2026-07-02').status, 'achieved');
  assert.equal(at(1300000, '2027-02-01').status, 'achieved', 'reaching it late is still reaching it');
  assert.equal(evaluate(goal({ targetDay: null }), 10, false, '2026-10-20').status, 'open');
  const monthly = at(300000, '2026-07-02');
  assert.equal(monthly.requiredMonthly, Math.ceil(900000 / 7), '183 days left count as 7 whole months, 9.000 to go');
  assert.equal(at(1200000, '2026-07-02').requiredMonthly, null);
  assert.equal(evaluate(goal({ targetDay: '2026-10-21' }), 0, false, '2026-10-20').requiredMonthly, 1000000, 'at least one month');
});

test('a goal can follow an account, an asset or the net worth, and starts from where they are', () => {
  const store = seeded();
  const acc = createGoal(store, { name: 'Reserva de 10 mil', target: 1000000, track: 'account', trackRef: 'sav' }, NOW);
  assert.ok(acc.ok);
  let [view] = listGoals(store, NOW);
  assert.deepEqual([view?.current, view?.initial, view?.progress], [200000, 200000, 0.2]);
  store.replaceCanonicalAccounts([{ ...store.listCanonicalAccounts()[0]!, balance: 600000 }], [], T);
  [view] = listGoals(store, NOW);
  assert.equal(view?.progress, 0.6, '6.000 of 10.000');

  const car = addAsset(store, { name: 'Tesouro', kind: 'asset', value: 50000 }, NOW);
  assert.ok(car.ok);
  if (car.ok) {
    createGoal(store, { name: 'Tesouro 5 mil', target: 500000, track: 'asset', trackRef: String(car.value.id) }, NOW);
    setAssetValue(store, car.value.id, { day: '2026-10-20', value: 150000 }, NOW);
    assert.equal(listGoals(store, NOW).find((g) => g.name === 'Tesouro 5 mil')?.current, 150000);
    store.deleteAsset(car.value.id);
    const lost = listGoals(store, NOW).find((g) => g.name === 'Tesouro 5 mil')!;
    assert.deepEqual([lost.linkLost, lost.current], [true, 0], 'a deleted asset leaves the goal on its typed amount');
  }
  assert.ok(createGoal(store, { name: 'Patrimônio', target: 2000000, track: 'networth' }, NOW).ok);
});

test('checks on the fields', () => {
  const store = seeded();
  const base = { name: 'Meta', target: 100000, track: 'manual' };
  assert.equal(createGoal(store, { ...base, name: '' }, NOW).ok, false);
  assert.equal(createGoal(store, { ...base, target: 0 }, NOW).ok, false);
  assert.equal(createGoal(store, { ...base, target: 10.5 }, NOW).ok, false);
  assert.equal(createGoal(store, { ...base, track: 'magic' }, NOW).ok, false);
  assert.equal(createGoal(store, { ...base, track: 'account', trackRef: 'nope' }, NOW).ok, false);
  assert.equal(createGoal(store, { ...base, targetDay: '2026-10-01' }, NOW).ok, false, 'a date in the past');
  assert.equal(createGoal(store, { ...base, targetDay: '31/12/2027' }, NOW).ok, false);
  assert.equal(createGoal(store, { ...base, saved: -5 }, NOW).ok, false);
  assert.ok(createGoal(store, base, NOW).ok);
  assert.equal(createGoal(store, { ...base, name: 'meta' }, NOW).ok, false, 'same name');
});

test('editing keeps the start, and the routes work', () => {
  const store = seeded();
  const call = (method: string, path: string, payload?: unknown) => apiRoute(method, path, new URLSearchParams(), store, NOW, payload === undefined ? '' : JSON.stringify(payload));
  const made = call('POST', '/api/goals', { name: 'Casa', target: 5000000, track: 'manual', saved: 100000, targetDay: '2028-01-01' });
  assert.equal(made?.status, 200);
  const id = (made?.body as { id: number }).id;
  assert.equal(call('PUT', `/api/goals/${id}`, { saved: 300000 })?.status, 200);
  const [view] = (call('GET', '/api/goals')?.body as { items: ReturnType<typeof listGoals> }).items;
  assert.deepEqual([view?.current, view?.initial, view?.createdDay], [300000, 100000, '2026-10-20']);
  assert.equal(updateGoal(store, 99, {}, NOW).ok, false);
  assert.equal(call('DELETE', `/api/goals/${id}`)?.status, 200);
  assert.equal(deleteGoal(store, id).ok, false);
});
