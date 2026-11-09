import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { hashPassword } from '../../src/auth/password.ts';
import { AuthService } from '../../src/auth/service.ts';
import { base32Decode, generateTotpSecret, hotp, totpCounter } from '../../src/auth/totp.ts';
import { createHttpServer } from '../../src/http/server.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

test('the HTTP server serves /healthz over a real socket', async (t) => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const server = createHttpServer({ store, version: '9.9.9' });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('this environment does not allow listening sockets');
      return;
    }
    throw error;
  }
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { version: string }).version, '9.9.9');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


/** Drives the server's request handler without a socket: a request whose body is `chunks`, counting how often the server pulls from it. */
function exchange(server: ReturnType<typeof createHttpServer>, method: string, url: string, headers: Record<string, string>, chunks: Buffer[]) {
  let pulled = 0;
  const req = new Readable({
    read() {
      pulled++;
      this.push(chunks.shift() ?? null);
    },
  }) as Readable & Partial<IncomingMessage>;
  Object.assign(req, { method, url, headers });
  return new Promise<{ status: number; body: string; pulled: number }>((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
        return this;
      },
      end(body?: unknown, done?: () => void) {
        if (typeof done === 'function') done();
        resolve({ status, body: body === undefined ? '' : String(body), pulled });
      },
    };
    const handler = server.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void;
    handler(req as IncomingMessage, res as unknown as ServerResponse);
  });
}

test('the upload route answers before reading the body when there is no session or the file is too large', async () => {
  const secret = generateTotpSecret();
  const now = new Date('2026-10-27T12:00:00Z');
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const auth = new AuthService(store, { passwordHash: hashPassword('a long test password'), totpSecret: secret, recoveryHashes: [] }, () => now);
  const login = auth.login('a long test password', hotp(base32Decode(secret), totpCounter(now.getTime())), null, 'test');
  assert.ok(login.ok);
  const cookie = `gmf_session=${login.token}`;
  const server = createHttpServer({ store, version: 't', now: () => now, auth });
  const pdf = { 'content-type': 'application/pdf' };
  const piece = () => [Buffer.alloc(1024 * 1024, 0x20)];
  // A stranger announcing 7 MB gets 401 and the body is never read.
  const stranger = await exchange(server, 'POST', '/api/bill-files?name=x.pdf', { ...pdf, 'content-length': String(7 * 1024 * 1024) }, piece());
  assert.deepEqual([stranger.status, stranger.pulled], [401, 0]);
  // Signed in, a declared size over 6 MB is refused before reading too.
  const declared = await exchange(server, 'POST', '/api/bill-files', { ...pdf, cookie, 'content-length': String(7 * 1024 * 1024) }, piece());
  assert.deepEqual([declared.status, declared.pulled], [413, 0]);
  // Without a declared size, reading stops past 6 MB.
  const streamed = await exchange(server, 'POST', '/api/bill-files', { ...pdf, cookie }, Array.from({ length: 8 }, () => Buffer.alloc(1024 * 1024, 0x20)));
  assert.equal(streamed.status, 413);
  // Under the cap the bytes reach the route intact, not decoded as text (this is not a PDF, so the route says so).
  const small = await exchange(server, 'POST', '/api/bill-files', { ...pdf, cookie }, [Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
  assert.deepEqual([small.status, (JSON.parse(small.body) as { error: string }).error], [422, 'unreadable_pdf']);
  // The AI reading route takes a page image of up to 1.5 MB as JSON, also only from a session.
  const page = JSON.stringify({ fileHash: 'a'.repeat(64), image: 'A'.repeat(1024 * 1024) });
  const vision = await exchange(server, 'POST', '/api/bill-files/vision', { 'content-type': 'application/json', cookie }, [Buffer.from(page)]);
  assert.equal(vision.status, 501);
  const anonymous = await exchange(server, 'POST', '/api/bill-files/vision', { 'content-type': 'application/json', 'content-length': String(page.length) }, [Buffer.from(page)]);
  assert.deepEqual([anonymous.status, anonymous.pulled], [401, 0]);
  // Every other route keeps the small cap.
  const other = await exchange(server, 'PUT', '/api/layout', { 'content-type': 'application/json', cookie }, [Buffer.alloc(300 * 1024, 0x20)]);
  assert.equal(other.status, 413);
});
