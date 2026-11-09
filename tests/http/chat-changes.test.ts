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
  const code = hotp(base32Decode(secret), totpCounter(NOW.getTime()));
  return { deps, code };
}

const post = (pathname: string, payload: unknown, headers: Record<string, string> = {}): AppRequest => ({ method: 'POST', pathname, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
const get = (pathname: string, headers: Record<string, string> = {}): AppRequest => ({ method: 'GET', pathname, headers, body: '' });
const cookieOf = (setCookie: string | undefined): string => (setCookie ?? '').split(';')[0]!;

function signedIn() {
  const { deps, code } = setup();
  const cookie = cookieOf(handle(post('/api/auth/login', { password: PASSWORD, code }), deps).headers['Set-Cookie']);
  return { deps, cookie };
}

/** A change waiting for a tap, as the analyst leaves it: a budget line for a month, planned again from its stored arguments. */
function pendingBudget(deps: AppDeps, createdAt = NOW.toISOString()) {
  const conversationId = deps.store.createChatConversation('teste', createdAt);
  const messageId = deps.store.addChatMessage({ conversationId, role: 'assistant', content: 'Preciso do seu toque.', steps: null, model: null, costUsd: null, createdAt });
  const id = deps.store.addChatChange({ conversationId, messageId, tool: 'set_budget', label: 'Orçamento de Supermercado em 10/2026: R$ 500,00', count: 1, args: { name: 'Supermercado', scope: 'category', month: '2026-10', amount: 500, recurring: false }, before: null, after: null, status: 'pending', destructive: false, undoable: true, createdAt, resolvedAt: null });
  return { conversationId, id };
}

test('confirm, undo and cancel are session routes that answer with the change, and the conversation lists its changes', () => {
  const { deps, cookie } = signedIn();
  const { conversationId, id } = pendingBudget(deps);
  assert.equal(handle(post(`/api/chat/changes/${id}/confirm`, {}), deps).status, 401);
  assert.equal(handle(get(`/api/chat/changes/${id}/confirm`, { cookie }), deps).status, 405);
  assert.equal(handle(post('/api/chat/changes/abc/confirm', {}, { cookie }), deps).status, 404);
  assert.equal(handle(post(`/api/chat/changes/${id}/explode`, {}, { cookie }), deps).status, 404);
  assert.equal(handle(post('/api/chat/changes/999/confirm', {}, { cookie }), deps).status, 404);

  const listed = JSON.parse(handle(get(`/api/chat/conversations/${conversationId}`, { cookie }), deps).body as string) as { items: Array<{ role: string; changes: Array<{ id: number; status: string; label: string }> }> };
  assert.deepEqual(listed.items[0]!.changes.map((c) => [c.id, c.status]), [[id, 'pending']]);

  const confirmed = handle(post(`/api/chat/changes/${id}/confirm`, {}, { cookie }), deps);
  assert.equal(confirmed.status, 200);
  assert.equal((JSON.parse(confirmed.body as string) as { change: { status: string } }).change.status, 'applied');
  assert.deepEqual(deps.store.listBudgets().map((b) => [b.name, b.amount]), [['Supermercado', 50000]]);
  assert.equal(handle(post(`/api/chat/changes/${id}/confirm`, {}, { cookie }), deps).status, 409, 'confirmed once');

  const undone = handle(post(`/api/chat/changes/${id}/undo`, {}, { cookie }), deps);
  assert.equal((JSON.parse(undone.body as string) as { change: { status: string } }).change.status, 'undone');
  assert.deepEqual(deps.store.listBudgets(), []);
  const twice = handle(post(`/api/chat/changes/${id}/undo`, {}, { cookie }), deps);
  assert.deepEqual([twice.status, (JSON.parse(twice.body as string) as { error: string }).error], [409, 'not_applied']);
});

test('cancel closes a pending change, and a stale pending one is reported as expired', () => {
  const { deps, cookie } = signedIn();
  const { id } = pendingBudget(deps);
  const declined = handle(post(`/api/chat/changes/${id}/decline`, {}, { cookie }), deps);
  assert.equal((JSON.parse(declined.body as string) as { change: { status: string } }).change.status, 'declined');
  assert.deepEqual(deps.store.listBudgets(), []);

  const old = pendingBudget(deps, new Date(NOW.getTime() - 31 * 60_000).toISOString());
  const late = handle(post(`/api/chat/changes/${old.id}/confirm`, {}, { cookie }), deps);
  assert.deepEqual([late.status, (JSON.parse(late.body as string) as { error: string }).error], [409, 'expired']);
  assert.deepEqual(deps.store.listBudgets(), []);
});

test('undo and confirm do not wait for a question that is being answered', async () => {
  const { deps, cookie } = signedIn();
  const { id } = pendingBudget(deps);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const armed: AppDeps = { ...deps, analyst: async () => { await gate; return { conversationId: 1, answer: 'ok', steps: [], model: 'm', costUsd: 0, stoppedBy: null, messageId: 1, changes: [] }; } };
  const first = handle(post('/api/chat', { question: 'oi' }, { cookie }), armed);
  const running = first.deferred!();
  assert.equal(handle(post('/api/chat', { question: 'outra' }, { cookie }), armed).status, 429);
  assert.equal(handle(post(`/api/chat/changes/${id}/confirm`, {}, { cookie }), armed).status, 200, 'a tap is not a question');
  release();
  assert.equal((await running).status, 200);
});
