import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Observer, type ObserverEvent } from '../../src/scheduler/observer.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { ScriptedAdapter, syncTime } from '../support/scripted-adapter.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T0 = new Date('2026-10-26T16:00:00.000Z').getTime();
const at = (sourceId: string, minutes: number) => syncTime(sourceId, 'Bank A', new Date(T0 - minutes * 60_000).toISOString());

function setup(adapters: ScriptedAdapter[], intervals: number[] = adapters.map(() => 300_000), abortAfterMs?: number) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  for (const a of adapters) store.registerSource({ id: a.id, kind: 'aggregator', capabilities: {} }, new Date(T0).toISOString());
  const clock = { t: T0 };
  const controller = new AbortController();
  const events: ObserverEvent[] = [];
  let reconciles = 0;
  const observer = new Observer({
    store,
    sources: adapters.map((adapter, i) => ({ adapter, intervalMs: intervals[i] as number })),
    reconcile: () => {
      reconciles++;
    },
    now: () => new Date(clock.t),
    onEvent: (e) => events.push(e),
    // Time passes only when the observer sleeps, so the run loop is deterministic.
    sleep: async (ms) => {
      clock.t += ms;
      if (abortAfterMs !== undefined && clock.t >= T0 + abortAfterMs) controller.abort();
    },
  });
  return { store, observer, clock, controller, events, reconciles: () => reconciles, sources: adapters.map((adapter, i) => ({ adapter, intervalMs: intervals[i] as number })) };
}

test('the first check records the sync times and reads the source', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]] });
  const { observer, events, reconciles, sources, store } = setup([adapter]);
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['changed', 'synced']);
  assert.equal(reconciles(), 1);
  assert.equal(adapter.transactionCalls.length, 1);
  assert.equal(store.listFreshness().length, 1);
});

test('a check that finds nothing new does not read the source', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]] });
  const { observer, events, reconciles, sources } = setup([adapter]);
  await observer.tick(sources[0]!);
  events.length = 0;
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['checked']);
  assert.equal(adapter.transactionCalls.length, 1);
  assert.equal(reconciles(), 1);
});

test('newer sync times trigger a read of the last 14 days and a rebuild', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)], [at('pierre', 1)]] });
  const { observer, events, reconciles, sources } = setup([adapter]);
  await observer.tick(sources[0]!);
  events.length = 0;
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['changed', 'synced']);
  assert.equal(adapter.transactionCalls.length, 2);
  assert.equal(adapter.transactionCalls[1]?.toISOString(), new Date(T0 - 14 * 86_400_000).toISOString());
  assert.equal(reconciles(), 2);
  const changed = events[0];
  assert.deepEqual(changed?.type === 'changed' ? changed.institutions : [], ['Bank A']);
});

test('a read that failed is retried at the next check even if nothing new was reported', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]], failTransactions: 1 });
  const { observer, events, sources } = setup([adapter]);
  await observer.tick(sources[0]!);
  const first = events.find((e) => e.type === 'synced');
  assert.equal(first?.type === 'synced' ? first.result.errors.length : 0, 1);
  events.length = 0;
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['synced']);
  assert.equal(adapter.transactionCalls.length, 2);
  events.length = 0;
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['checked']);
});

test('errors are reported, back off, and clear after a success', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [new Error('offline'), new Error('offline'), [at('pierre', 1)]] });
  const { observer, events, clock, sources } = setup([adapter], [300_000]);
  await observer.tick(sources[0]!);
  await observer.tick(sources[0]!);
  const waits = events.filter((e) => e.type === 'error').map((e) => (e.type === 'error' ? e.retryInMs : 0));
  assert.deepEqual(waits, [600_000, 1_200_000]);
  clock.t += 1_200_000;
  await observer.tick(sources[0]!);
  assert.equal(events.at(-1)?.type, 'synced');
});

test('the wait after errors never exceeds the maximum', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [new Error('offline')] });
  const { observer, events, sources } = setup([adapter], [300_000]);
  for (let i = 0; i < 8; i++) await observer.tick(sources[0]!);
  const last = events.at(-1);
  assert.equal(last?.type === 'error' ? last.retryInMs : 0, 1_800_000);
});

test('a source without a freshness check is skipped', async () => {
  const adapter = new ScriptedAdapter('plain');
  Object.defineProperty(adapter, 'fetchFreshness', { value: undefined });
  const { observer, events, sources } = setup([adapter]);
  await observer.tick(sources[0]!);
  assert.deepEqual(events, []);
});

test('run checks each source at its own interval until aborted', async () => {
  const slow = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]] });
  const fast = new ScriptedAdapter('pluggy', { reads: [[at('pluggy', 30)]] });
  const { observer, controller } = setup([slow, fast], [300_000, 120_000], 600_000);
  await observer.run(controller.signal);
  // The loop stops when the clock reaches 10 minutes, before checking again at that instant.
  assert.equal(slow.freshnessCalls, 2);
  assert.equal(fast.freshnessCalls, 5);
});

test('run stops at once when the signal is already aborted', async () => {
  const adapter = new ScriptedAdapter('pierre', { reads: [[at('pierre', 30)]] });
  const { observer, controller } = setup([adapter]);
  controller.abort();
  await observer.run(controller.signal);
  assert.equal(adapter.freshnessCalls, 0);
});

test('a wake makes the source due now and a forced read happens even when the sync time did not move', async () => {
  const adapter = new ScriptedAdapter('pluggy', { reads: [[at('pluggy', 30)]] });
  const { observer, events, sources, store } = setup([adapter]);
  await observer.tick(sources[0]!);
  events.length = 0;
  observer.wake('pluggy');
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['checked']);
  observer.wake('pluggy', true);
  await observer.tick(sources[0]!);
  assert.deepEqual(events.map((e) => e.type), ['checked', 'synced']);
  assert.equal(adapter.transactionCalls.length, 2);
  assert.equal(store.listFreshness().length, 1);
});

test('a wake during a running check schedules another one right after it', async () => {
  const adapter = new ScriptedAdapter('pluggy', { reads: [[at('pluggy', 30)]] });
  const { observer, sources, clock } = setup([adapter], [300_000]);
  const original = adapter.fetchFreshness.bind(adapter);
  adapter.fetchFreshness = async () => {
    observer.wake('pluggy');
    return original();
  };
  await observer.tick(sources[0]!);
  const states = (observer as unknown as { states: Map<string, { nextDueAt: number }> }).states;
  assert.equal(states.get('pluggy')?.nextDueAt, 0);
  assert.ok(clock.t > 0);
});

test('waking an unknown source does nothing', () => {
  const { observer } = setup([new ScriptedAdapter('pluggy')]);
  observer.wake('nobody', true);
});
