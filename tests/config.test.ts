import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig applies defaults', () => {
  assert.deepEqual(loadConfig({}), { port: 8080, dbPath: 'data/gmf.sqlite', version: 'dev' });
});

test('loadConfig reads the environment', () => {
  assert.deepEqual(loadConfig({ PORT: '3000', DB_PATH: '/var/lib/gmf/db.sqlite', APP_VERSION: 'abc123' }), {
    port: 3000,
    dbPath: '/var/lib/gmf/db.sqlite',
    version: 'abc123',
  });
});

test('loadConfig rejects an invalid port', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: '80.5' }), /Invalid PORT/);
});
