import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig applies defaults', () => {
  assert.deepEqual(loadConfig({}), { port: 8080, dbPath: 'data/gmf.sqlite', version: 'dev', observer: false });
});

test('loadConfig reads the environment', () => {
  assert.deepEqual(loadConfig({ PORT: '3000', DB_PATH: '/var/lib/gmf/db.sqlite', APP_VERSION: 'abc123' }), {
    port: 3000,
    dbPath: '/var/lib/gmf/db.sqlite',
    version: 'abc123',
    observer: false,
  });
});

test('loadConfig rejects an invalid port', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: '80.5' }), /Invalid PORT/);
});

test('loadConfig turns the observer on only for on, 1 or true', () => {
  for (const value of ['on', '1', 'true', 'TRUE', ' On ']) assert.equal(loadConfig({ OBSERVER: value }).observer, true, value);
  for (const value of ['', 'off', '0', 'false', 'yes']) assert.equal(loadConfig({ OBSERVER: value }).observer, false, value);
  assert.equal(loadConfig({}).observer, false);
});
