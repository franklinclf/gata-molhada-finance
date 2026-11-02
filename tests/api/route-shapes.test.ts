import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { apiRoute } from '../../src/api/routes.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-30T12:00:00Z');
const call = (method: string, path: string, body = '') => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const [pathname, query = ''] = path.split('?');
  return apiRoute(method, pathname!, new URLSearchParams(query), store, NOW, body);
};

test('a row id must be plain digits: 1e0 and 0x1 do not alias row 1', () => {
  assert.equal(call('DELETE', '/api/goals/1e0'), null);
  assert.equal(call('DELETE', '/api/goals/0x1'), null);
  assert.equal(call('DELETE', '/api/rules/1.0'), null);
  assert.equal(call('DELETE', '/api/assets/%201'), null);
  assert.equal(call('DELETE', '/api/goals/1')?.status, 404);
});

test('the card bills route needs an account, and answers 404 for one that is not a card', () => {
  assert.equal(call('GET', '/api/cycles')?.status, 400);
  assert.equal(call('GET', '/api/cycles?accountId=nope')?.status, 404);
});

test('the bill check answers only its own path', () => {
  assert.equal(call('GET', '/api/bill-check')?.status, 200);
  assert.equal(call('POST', '/api/bill-check')?.status, 405);
  assert.equal(call('GET', '/api/bill-check/extra'), null);
});

test('an AI decision with a body that is not JSON is a 400, and an empty body is still accepted where it can be', () => {
  assert.equal(call('POST', '/api/ai/accept', '{not json')?.status, 400);
  assert.equal(call('POST', '/api/ai/accept-all', '')?.status, 200);
});

test('the duplicate candidates of a transaction that does not exist is a 404, and the method must be GET', () => {
  assert.equal(call('GET', '/api/transactions/nope/duplicates')?.status, 404);
  assert.equal(call('POST', '/api/transactions/nope/duplicates')?.status, 405);
});
