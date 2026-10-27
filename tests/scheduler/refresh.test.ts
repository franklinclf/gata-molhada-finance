import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { RefreshBlockedError, requestManualRefresh } from '../../src/scheduler/refresh.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { ScriptedAdapter, syncTime } from '../support/scripted-adapter.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T0 = new Date('2026-10-26T16:00:00.000Z').getTime();
const old = (inst: string) => syncTime('pierre', inst, '2026-10-26T10:00:00.000Z');
const fresh = (inst: string) => syncTime('pierre', inst, '2026-10-26T16:00:30.000Z');

function setup(reads: ConstructorParameters<typeof ScriptedAdapter>[1] = {}) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const adapter = new ScriptedAdapter('pierre', { refreshOnDemand: true, ...reads });
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, new Date(T0).toISOString());
  const clock = { t: T0 };
  const sleeps: number[] = [];
  const progress: string[] = [];
  const common = {
    store,
    adapter,
    now: () => new Date(clock.t),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    onProgress: (m: string) => progress.push(m),
  };
  return { store, adapter, clock, sleeps, progress, common };
}

test('requests the refresh once and reports when each institution updated', async () => {
  const { adapter, store, common, progress } = setup({
    reads: [[old('Bank A'), old('Bank B')], [fresh('Bank A'), old('Bank B')], [fresh('Bank A'), fresh('Bank B')]],
  });
  const outcome = await requestManualRefresh(common);
  assert.equal(adapter.refreshCalls, 1);
  assert.deepEqual(outcome.institutions, [
    { institution: 'Bank A', updated: true, seconds: 5 },
    { institution: 'Bank B', updated: true, seconds: 10 },
  ]);
  assert.deepEqual(outcome.timedOut, []);
  assert.equal(store.lastRefresh('pierre')?.status, 'completed');
  assert.deepEqual(progress, ['refresh requested for 2 institutions', 'Bank A updated after 5s', 'Bank B updated after 10s']);
});

test('stops waiting when every institution has updated', async () => {
  const { common, sleeps } = setup({ reads: [[old('Bank A')], [fresh('Bank A')]] });
  await requestManualRefresh(common);
  assert.deepEqual(sleeps, [5000]);
});

test('gives up after the wait time and names the institutions that did not update', async () => {
  const { store, common, sleeps } = setup({ reads: [[old('Bank A'), old('Bank B')], [fresh('Bank A'), old('Bank B')]] });
  const outcome = await requestManualRefresh({ ...common, waitMs: 20_000, pollMs: 5_000 });
  assert.deepEqual(outcome.timedOut, ['Bank B']);
  assert.equal(outcome.institutions.find((i) => i.institution === 'Bank A')?.updated, true);
  assert.equal(sleeps.length, 4);
  assert.equal(store.lastRefresh('pierre')?.status, 'timeout');
});

test('does not request a refresh when the policy blocks it', async () => {
  const { adapter, store, common } = setup({ reads: [[old('Bank A')]] });
  store.finishRefresh(store.startRefresh('pierre', new Date(T0 - 5 * 60_000).toISOString()), new Date(T0 - 4 * 60_000).toISOString(), 'completed', {});
  await assert.rejects(requestManualRefresh(common), (e: Error) => e instanceof RefreshBlockedError && /5 minutes ago/.test(e.message));
  assert.equal(adapter.refreshCalls, 0);
  assert.equal(adapter.freshnessCalls, 0);
});

test('force skips the spacing check', async () => {
  const { adapter, store, common } = setup({ reads: [[old('Bank A')], [fresh('Bank A')]] });
  store.finishRefresh(store.startRefresh('pierre', new Date(T0 - 5 * 60_000).toISOString()), new Date(T0 - 4 * 60_000).toISOString(), 'completed', {});
  await requestManualRefresh({ ...common, force: true });
  assert.equal(adapter.refreshCalls, 1);
});

test('is blocked when an institution has used almost all of its monthly reads', async () => {
  const { adapter, store, common } = setup({ reads: [[old('Bank A')]] });
  for (let i = 0; i < 220; i++) {
    store.upsertFreshness(syncTime('pierre', 'Bank A', new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 3_600_000).toISOString()));
  }
  await assert.rejects(requestManualRefresh(common), (e: Error) => e instanceof RefreshBlockedError && /Bank A \(\d+ of 240\)/.test(e.message));
  assert.equal(adapter.refreshCalls, 0);
});

test('logs a failed request and does not repeat it', async () => {
  const { adapter, store, common } = setup({ reads: [[old('Bank A')]], refreshError: new Error('HTTP 400 from manual-update') });
  await assert.rejects(requestManualRefresh(common), /HTTP 400/);
  assert.equal(adapter.refreshCalls, 1);
  const last = store.lastRefresh('pierre');
  assert.equal(last?.status, 'failed');
  assert.deepEqual(last?.detail, { error: 'HTTP 400 from manual-update' });
});

test('keeps waiting when a read of the sync times fails', async () => {
  const { common, progress } = setup({ reads: [[old('Bank A')], new Error('network reset'), [fresh('Bank A')]] });
  const outcome = await requestManualRefresh(common);
  assert.deepEqual(outcome.timedOut, []);
  assert.ok(progress.some((m) => /could not read the sync times/.test(m) && /network reset/.test(m)));
});

test('each new sync time counts as a bank read', async () => {
  const { store, common } = setup({ reads: [[old('Bank A')], [fresh('Bank A')]] });
  await requestManualRefresh(common);
  assert.deepEqual(store.quotaUsage('2026-10'), [{ institutionKey: 'bank a', events: 2 }]);
});

test('refuses a source that cannot refresh on demand', async () => {
  const { store } = setup();
  await assert.rejects(requestManualRefresh({ store, adapter: new ScriptedAdapter('pluggy') }), /cannot refresh on demand/);
});
