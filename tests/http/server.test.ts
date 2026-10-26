import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
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
