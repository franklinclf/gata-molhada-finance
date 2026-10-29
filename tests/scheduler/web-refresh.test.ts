import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRefresher } from '../../src/scheduler/web-refresh.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { ScriptedAdapter, syncTime } from '../support/scripted-adapter.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const T0 = '2026-10-26T16:00:00.000Z';

function setup() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, T0);
  const adapter = new ScriptedAdapter('pierre', {
    refreshOnDemand: true,
    reads: [[syncTime('pierre', 'Bank A', '2026-10-26T10:00:00.000Z')], [syncTime('pierre', 'Bank A', '2026-10-26T16:00:30.000Z')]],
  });
  const refresher = createRefresher({ store, adapter, now: () => new Date(T0), waitMs: 1_000, pollMs: 1 });
  return { store, adapter, refresher };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

test('starts one refresh in the background and blocks a second one while it runs', async () => {
  const { adapter, refresher } = setup();
  assert.deepEqual(refresher.start(), { started: true });
  assert.equal(refresher.state().running, true);
  const again = refresher.start();
  assert.equal(again.started, false);
  await until(() => !refresher.state().running);
  assert.equal(adapter.refreshCalls, 1);
  assert.equal(refresher.state().result, 'completed');
});

test('explains why a refresh is not allowed right after another one', async () => {
  const { refresher } = setup();
  refresher.start();
  await until(() => !refresher.state().running);
  const blocked = refresher.start();
  assert.equal(blocked.started, false);
  assert.match((blocked as { reasons: string[] }).reasons.join(' '), /minimum 15/);
});

test('when the source refuses refresh requests, the page is told so and the request is not repeated', async () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, T0);
  const refused = new Error('Pluggy refused the refresh (Nubank: HTTP 400)');
  refused.name = 'RefreshRefusedError';
  const adapter = new ScriptedAdapter('pierre', { refreshOnDemand: true, reads: [[syncTime('pierre', 'Bank A', '2026-10-26T10:00:00.000Z')]], refreshError: refused });
  const refresher = createRefresher({ store, adapter, now: () => new Date(T0), waitMs: 1_000, pollMs: 1 });
  assert.deepEqual(refresher.start(), { started: true });
  await until(() => !refresher.state().running);
  assert.equal(refresher.state().result, 'refused');
  assert.match(refresher.state().error ?? '', /HTTP 400/);
  const again = refresher.start();
  assert.equal(again.started, false);
  assert.equal(adapter.refreshCalls, 1, 'the second click did not ask the source again');
});
