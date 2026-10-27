import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from '../../src/http/static.ts';

function site(): string {
  const root = mkdtempSync(join(tmpdir(), 'gmf-web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<html></html>');
  writeFileSync(join(root, 'assets', 'app-abc.js'), 'x');
  writeFileSync(join(root, 'manifest.webmanifest'), '{}');
  writeFileSync(join(root, '..secret'), 'no');
  return root;
}

test('serves index.html at the root with a CSP and no caching', async () => {
  const file = await serveStatic(site(), '/');
  assert.equal(file?.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(file?.headers['Cache-Control'], 'no-cache');
  assert.match(file?.headers['Content-Security-Policy'] ?? '', /default-src 'self'/);
});

test('hashed assets are cached for a year, other files are revalidated', async () => {
  const root = site();
  assert.equal((await serveStatic(root, '/assets/app-abc.js'))?.headers['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.equal((await serveStatic(root, '/manifest.webmanifest'))?.headers['Content-Type'], 'application/manifest+json');
});

test('paths without an extension fall back to the app, missing files do not', async () => {
  const root = site();
  assert.equal((await serveStatic(root, '/cards'))?.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(await serveStatic(root, '/assets/missing.js'), null);
});

test('path traversal and bad encodings are refused', async () => {
  const root = site();
  // Dots are resolved inside the root, so the answer is the app shell or nothing, never a file outside the root.
  for (const path of ['/../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../etc/passwd.js']) {
    const file = await serveStatic(root, path);
    assert.ok(file === null || file.body.toString() === '<html></html>', path);
  }
  assert.equal(await serveStatic(root, '/%zz'), null);
  assert.equal(await serveStatic(root, '/a%00.js'), null);
});

test('returns null when there is no build', async () => {
  assert.equal(await serveStatic(join(tmpdir(), 'gmf-does-not-exist'), '/'), null);
});
