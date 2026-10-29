import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../src/auth/password.ts';
import { AuthService } from '../../src/auth/service.ts';
import { base32Decode, generateTotpSecret, hotp, totpCounter } from '../../src/auth/totp.ts';
import { handle, type AppDeps, type AppRequest } from '../../src/http/app.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const PASSWORD = 'a long test password';
const NOW = new Date('2026-10-27T12:00:00Z');

function setup() {
  const secret = generateTotpSecret();
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const auth = new AuthService(store, { passwordHash: hashPassword(PASSWORD), totpSecret: secret, recoveryHashes: [] }, () => NOW);
  const deps: AppDeps = { store, version: 't', now: () => NOW, auth, secureCookies: true };
  const code = (offset = 0) => hotp(base32Decode(secret), totpCounter(NOW.getTime()) + offset);
  return { deps, code };
}

const post = (pathname: string, payload: unknown, headers: Record<string, string> = {}): AppRequest => ({
  method: 'POST',
  pathname,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(payload),
});
const get = (pathname: string, headers: Record<string, string> = {}): AppRequest => ({ method: 'GET', pathname, headers, body: '' });

function cookieOf(setCookie: string | undefined): string {
  return (setCookie ?? '').split(';')[0]!;
}

test('the API is closed without a session and open with one', () => {
  const { deps, code } = setup();
  assert.equal(handle(get('/api/accounts'), deps).status, 401);
  assert.equal(handle(get('/api/auth/session'), deps).status, 401);

  const login = handle(post('/api/auth/login', { password: PASSWORD, code: code() }), deps);
  assert.equal(login.status, 200);
  const setCookie = login.headers['Set-Cookie'];
  assert.match(setCookie ?? '', /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure$/);

  const cookie = cookieOf(setCookie);
  assert.equal(handle(get('/api/auth/session', { cookie }), deps).status, 200);
  assert.equal(handle(get('/api/unknown', { cookie }), deps).status, 404);
});

test('logout clears the cookie and ends the session', () => {
  const { deps, code } = setup();
  const cookie = cookieOf(handle(post('/api/auth/login', { password: PASSWORD, code: code() }), deps).headers['Set-Cookie']);
  const out = handle(post('/api/auth/logout', {}, { cookie }), deps);
  assert.equal(out.status, 200);
  assert.match(out.headers['Set-Cookie'] ?? '', /Max-Age=0/);
  assert.equal(handle(get('/api/auth/session', { cookie }), deps).status, 401);
});

test('login rejects bad credentials, bad content type and bad bodies', () => {
  const { deps, code } = setup();
  assert.equal(handle(post('/api/auth/login', { password: 'nope nope nope', code: code() }), deps).status, 401);
  assert.equal(handle({ ...post('/api/auth/login', { password: PASSWORD, code: code() }), headers: { 'content-type': 'text/plain' } }, deps).status, 400);
  assert.equal(handle({ ...post('/api/auth/login', {}), body: 'not json' }, deps).status, 400);
  assert.equal(handle(post('/api/auth/login', { password: PASSWORD }), deps).status, 400);
  assert.equal(handle(get('/api/auth/login'), deps).status, 405);
});

test('too many failures answer 429 with Retry-After', () => {
  const { deps } = setup();
  for (let i = 0; i < 5; i++) handle(post('/api/auth/login', { password: 'wrong password!!', code: '000000' }), deps);
  const res = handle(post('/api/auth/login', { password: 'wrong password!!', code: '000000' }), deps);
  assert.equal(res.status, 429);
  assert.equal(res.headers['Retry-After'], '900');
});

test('login answers 503 when auth is not configured, and health stays public', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const deps: AppDeps = { store, version: 't', now: () => NOW, auth: new AuthService(store, null, () => NOW), secureCookies: true };
  assert.equal(handle(post('/api/auth/login', { password: PASSWORD, code: '123456' }), deps).status, 503);
  assert.equal(handle(get('/healthz'), deps).status, 200);
});

test('secure cookies can be turned off for local development', () => {
  const { deps, code } = setup();
  const res = handle(post('/api/auth/login', { password: PASSWORD, code: code() }), { ...deps, secureCookies: false });
  assert.doesNotMatch(res.headers['Set-Cookie'] ?? '', /Secure/);
});

test('an authenticated session reaches the data endpoints with their query string', () => {
  const { deps, code } = setup();
  const cookie = cookieOf(handle(post('/api/auth/login', { password: PASSWORD, code: code() }), deps).headers['Set-Cookie']);
  const ok = handle({ ...get('/api/balances', { cookie }), search: '' }, deps);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body ?? '').total, 0);
  assert.equal(handle({ ...get('/api/cashflow', { cookie }), search: 'from=bad' }, deps).status, 400);
  assert.equal(handle(get('/api/balances'), deps).status, 401);
});

test('writes need a JSON content type', () => {
  const { deps, code } = setup();
  const cookie = cookieOf(handle(post('/api/auth/login', { password: PASSWORD, code: code() }), deps).headers['Set-Cookie']);
  const plain: AppRequest = { method: 'PUT', pathname: '/api/accounts/x', headers: { cookie, 'content-type': 'text/plain' }, body: '{"hidden":true}' };
  assert.equal(handle(plain, deps).status, 415);
  const json: AppRequest = { ...plain, headers: { cookie, 'content-type': 'application/json' } };
  assert.equal(handle(json, deps).status, 404);
});

import { createHmac } from 'node:crypto';
import { Debounce, decide, validSignature } from '../../src/http/deploy-hook.ts';

const SECRET = 'a-webhook-secret';
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const ci = (extra: Record<string, unknown> = {}) => JSON.stringify({ action: 'completed', workflow_run: { name: 'CI', conclusion: 'success', head_branch: 'main', event: 'push', ...extra } });
const hook = (body: string, headers: Record<string, string>): AppRequest => ({ method: 'POST', pathname: '/api/hooks/deploy', headers: { 'content-type': 'application/json', ...headers }, body });

test('the deploy webhook does not exist without a secret', () => {
  const { deps } = setup();
  assert.equal(handle(hook(ci(), { 'x-github-event': 'workflow_run', 'x-hub-signature-256': sign(ci()) }), deps).status, 404);
});

test('the deploy webhook needs a valid signature, and only a green CI run on main triggers a deploy', () => {
  const { deps } = setup();
  let triggered = 0;
  const armed: AppDeps = { ...deps, deployHook: { secret: SECRET, trigger: () => void triggered++ } };
  const send = (body: string, event: string, signature = sign(body)) => handle(hook(body, { 'x-github-event': event, 'x-hub-signature-256': signature }), armed);

  assert.equal(send(ci(), 'workflow_run', 'sha256=00').status, 401, 'a wrong signature is refused');
  assert.equal(send(ci(), 'workflow_run', sign(ci(), 'other-secret')).status, 401);
  assert.equal(handle(hook(ci(), { 'x-github-event': 'workflow_run' }), armed).status, 401, 'no signature at all');
  assert.equal(triggered, 0);

  assert.deepEqual(JSON.parse(send('{"zen":"x"}', 'ping').body ?? ''), { decision: 'ping' });
  assert.equal(JSON.parse(send(ci({ conclusion: 'failure' }), 'workflow_run').body ?? '').decision, 'ignore');
  assert.equal(JSON.parse(send(ci({ head_branch: 'feature' }), 'workflow_run').body ?? '').decision, 'ignore');
  assert.equal(JSON.parse(send(ci({ event: 'pull_request' }), 'workflow_run').body ?? '').decision, 'ignore');
  assert.equal(JSON.parse(send(ci({ name: 'Other' }), 'workflow_run').body ?? '').decision, 'ignore');
  assert.equal(JSON.parse(send(ci(), 'push').body ?? '').decision, 'ignore');
  assert.equal(triggered, 0);

  const ok = send(ci(), 'workflow_run');
  assert.deepEqual([ok.status, JSON.parse(ok.body ?? '').decision, triggered], [202, 'deploy', 1]);
  assert.equal(send('not json', 'workflow_run').status, 400);
  assert.equal(handle({ ...hook(ci(), {}), method: 'GET' }, armed).status, 405);
});

test('signature and decision helpers, and the debounce', () => {
  assert.equal(validSignature('body', sign('body'), SECRET), true);
  assert.equal(validSignature('body', sign('body'), ''), false, 'an empty secret never validates');
  assert.equal(validSignature('body', undefined, SECRET), false);
  assert.equal(validSignature('body', 'sha256=zz', SECRET), false);
  assert.equal(decide('workflow_run', null), 'ignore');
  let clock = 1_000_000;
  const gate = new Debounce(10_000, () => clock);
  assert.deepEqual([gate.allow(), gate.allow()], [true, false]);
  clock += 10_001;
  assert.equal(gate.allow(), true);
});
