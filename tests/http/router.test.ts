import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, type RouterDeps } from '../../src/http/router.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

function deps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    store: openSqliteStore(':memory:', MIGRATIONS),
    version: '1.2.3',
    now: () => new Date('2026-10-26T15:00:00.000Z'),
    ...overrides,
  };
}

test('GET /healthz reports ok with version and schema version', () => {
  const res = route('GET', '/healthz', deps());
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(res.body ?? ''), {
    status: 'ok',
    version: '1.2.3',
    schemaVersion: 19,
    time: '2026-10-26T15:00:00.000Z',
  });
});

test('HEAD /healthz answers without a body', () => {
  const res = route('HEAD', '/healthz', deps());
  assert.equal(res.status, 200);
  assert.equal(res.body, null);
});

test('GET /healthz answers 503 when the store fails', () => {
  const d = deps();
  d.store.close();
  const res = route('GET', '/healthz', d);
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body ?? '').status, 'degraded');
});

test('POST /healthz is not allowed', () => {
  const res = route('POST', '/healthz', deps());
  assert.equal(res.status, 405);
  assert.equal(res.headers.Allow, 'GET, HEAD');
});

test('unknown paths answer 404 as JSON', () => {
  const res = route('GET', '/nope', deps());
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body ?? ''), { error: 'not_found' });
});
