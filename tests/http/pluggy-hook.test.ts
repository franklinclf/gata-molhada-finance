import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { handle, type AppDeps, type AppRequest } from '../../src/http/app.ts';
import { effectOf, parsePluggyEvent, readAlerts, recordAlert, tokenMatches, type PluggyEvent } from '../../src/http/pluggy-hook.ts';
import { AuthService } from '../../src/auth/service.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-29T12:00:00Z');
const SECRET = 'f3a9c2d1e8b74a65f3a9c2d1e8b74a65';

function setup(armed: boolean) {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const auth = new AuthService(store, null, () => NOW);
  const events: PluggyEvent[] = [];
  const deps: AppDeps = { store, version: 't', now: () => NOW, auth, secureCookies: true, ...(armed ? { pluggyHook: { secret: SECRET, onEvent: (e) => void events.push(e) } } : {}) };
  return { deps, events, store };
}

const hook = (token: string, body: string, method = 'POST'): AppRequest => ({ method, pathname: `/api/hooks/pluggy/${token}`, headers: { 'content-type': 'application/json' }, body });
const updated = JSON.stringify({ event: 'item/updated', eventId: 'e1', itemId: 'item-1', triggeredBy: 'SYNC' });

test('the token check accepts only the exact secret', () => {
  assert.equal(tokenMatches(SECRET, SECRET), true);
  assert.equal(tokenMatches(`${SECRET}x`, SECRET), false);
  assert.equal(tokenMatches('', SECRET), false);
  assert.equal(tokenMatches('anything', ''), false);
});

test('the Pluggy webhook does not exist without a secret, and a wrong token looks the same', () => {
  assert.equal(handle(hook(SECRET, updated), setup(false).deps).status, 404);
  const { deps, events } = setup(true);
  const wrong = handle(hook('not-the-secret', updated), deps);
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body, '{"error":"not_found"}');
  assert.equal(events.length, 0);
});

test('a valid delivery is acknowledged and handed over, including events the app does not use', () => {
  const { deps, events } = setup(true);
  assert.equal(handle(hook(SECRET, updated), deps).status, 202);
  assert.deepEqual(events.map((e) => [e.event, e.itemId]), [['item/updated', 'item-1']]);
  const other = handle(hook(SECRET, JSON.stringify({ event: 'connector/status_updated', connectorId: 5 })), deps);
  assert.equal(other.status, 202);
  assert.equal(other.body, '{"received":false}');
  assert.equal(events.length, 1);
});

test('only POST is accepted, and a body that is not JSON is a 400', () => {
  const { deps } = setup(true);
  assert.equal(handle(hook(SECRET, updated, 'GET'), deps).status, 405);
  assert.equal(handle(hook(SECRET, 'not json'), deps).status, 400);
});

test('an item error carries its code through', () => {
  const event = parsePluggyEvent({ event: 'item/error', itemId: 'i', error: { code: 'INVALID_CREDENTIALS', message: 'bad login' } });
  assert.deepEqual(event, { event: 'item/error', itemId: 'i', errorCode: 'INVALID_CREDENTIALS', errorMessage: 'bad login' });
  assert.equal(parsePluggyEvent({ event: 'item/error' }), null);
  assert.equal(parsePluggyEvent('x'), null);
});

test('what each event asks of the app', () => {
  assert.deepEqual(effectOf('item/updated'), { wake: 'check', alert: 'clear' });
  assert.deepEqual(effectOf('transactions/created'), { wake: 'sync', alert: null });
  assert.deepEqual(effectOf('transactions/deleted'), { wake: 'sync', alert: null });
  assert.deepEqual(effectOf('item/error'), { wake: false, alert: 'raise' });
  assert.deepEqual(effectOf('item/waiting_user_action'), { wake: false, alert: 'raise' });
  assert.deepEqual(effectOf('connector/status_updated'), { wake: false, alert: null });
});

test('an alert stays until a later event clears it', () => {
  const { store } = setup(false);
  recordAlert(store, 'item-1', { institution: 'Itaú', event: 'item/error', code: 'INVALID_CREDENTIALS', message: null, at: NOW.toISOString() }, NOW);
  assert.equal(readAlerts(store)['item-1']?.institution, 'Itaú');
  recordAlert(store, 'item-2', null, NOW);
  assert.equal(Object.keys(readAlerts(store)).length, 1);
  recordAlert(store, 'item-1', null, NOW);
  assert.deepEqual(readAlerts(store), {});
});
