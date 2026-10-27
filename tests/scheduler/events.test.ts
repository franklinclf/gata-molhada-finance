import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observedSources, POLL_INTERVAL_MS } from '../../src/scheduler/defaults.ts';
import { formatObserverEvent } from '../../src/scheduler/events.ts';
import { parseRefreshArgs } from '../../src/scheduler/refresh-args.ts';
import { ScriptedAdapter } from '../support/scripted-adapter.ts';

test('checked events are quiet unless verbose', () => {
  assert.equal(formatObserverEvent({ type: 'checked', sourceId: 'pierre' }), null);
  assert.equal(formatObserverEvent({ type: 'checked', sourceId: 'pierre' }, true), 'pierre: no new data');
});

test('formats changes, reads and errors in one line each', () => {
  assert.equal(formatObserverEvent({ type: 'changed', sourceId: 'pluggy', institutions: ['Bank A', 'Bank B'] }), 'pluggy: new data from Bank A, Bank B');
  const ok = { sourceId: 'pierre', accounts: 11, transactions: 468, bills: 37, freshness: 5, warnings: [], errors: [] };
  assert.equal(formatObserverEvent({ type: 'synced', sourceId: 'pierre', result: ok }), 'pierre: read 11 accounts, 468 transactions, 37 bills');
  assert.match(formatObserverEvent({ type: 'synced', sourceId: 'pierre', result: { ...ok, errors: ['bills: HTTP 500'] } }) ?? '', /1 failed step\(s\): bills: HTTP 500/);
  assert.equal(formatObserverEvent({ type: 'error', sourceId: 'pierre', message: 'offline', retryInMs: 600_000 }), 'pierre: offline (next try in 10 min)');
});

test('each source is checked at its own interval, and sources without a check are left out', () => {
  const pierre = new ScriptedAdapter('pierre');
  const other = new ScriptedAdapter('other');
  const plain = new ScriptedAdapter('plain');
  Object.defineProperty(plain, 'fetchFreshness', { value: undefined });
  const sources = observedSources([pierre, other, plain]);
  assert.deepEqual(sources.map((s) => [s.adapter.id, s.intervalMs]), [['pierre', POLL_INTERVAL_MS.pierre], ['other', 300_000]]);
  assert.equal(POLL_INTERVAL_MS.pluggy, 120_000);
});

test('parseRefreshArgs accepts --force and rejects anything else', () => {
  assert.deepEqual(parseRefreshArgs([]), { force: false });
  assert.deepEqual(parseRefreshArgs(['--force']), { force: true });
  assert.throws(() => parseRefreshArgs(['--now']), /Unknown argument: --now/);
});
