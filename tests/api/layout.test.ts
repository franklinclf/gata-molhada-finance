import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { apiRoute } from '../../src/api/routes.ts';
import { defaultLayout, loadLayout, parseLayout, WIDGET_IDS } from '../../src/api/layout.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

test('parseLayout keeps the order, drops unknown and repeated ids, and appends missing widgets', () => {
  const layout = parseLayout({ widgets: [{ id: 'spending', hidden: true }, { id: 'nope', hidden: false }, { id: 'spending', hidden: false }, { id: 'cards', hidden: false }] });
  assert.ok(layout);
  assert.deepEqual(layout.widgets.slice(0, 2), [{ id: 'spending', hidden: true }, { id: 'cards', hidden: false }]);
  assert.equal(layout.widgets.length, WIDGET_IDS.length);
});

test('parseLayout rejects the wrong shape', () => {
  for (const value of [null, 'x', {}, { widgets: 'x' }, { widgets: [null] }, { widgets: [{ id: 'cards' }] }, { widgets: new Array(51).fill({ id: 'cards', hidden: false }) }]) {
    assert.equal(parseLayout(value), null);
  }
});

test('the layout defaults, saves and reads back through the API', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  assert.deepEqual(loadLayout(store), defaultLayout());
  const put = apiRoute('PUT', '/api/layout', new URLSearchParams(), store, NOW, JSON.stringify({ widgets: [{ id: 'findings', hidden: true }] }));
  assert.equal(put?.status, 200);
  const got = apiRoute('GET', '/api/layout', new URLSearchParams(), store, NOW);
  assert.deepEqual((got?.body as { widgets: unknown[] }).widgets[0], { id: 'findings', hidden: true });
  assert.equal(apiRoute('PUT', '/api/layout', new URLSearchParams(), store, NOW, 'nope')?.status, 400);
  assert.equal(apiRoute('PUT', '/api/layout', new URLSearchParams(), store, NOW, '{"widgets":3}')?.status, 400);
  assert.equal(apiRoute('DELETE', '/api/layout', new URLSearchParams(), store, NOW)?.status, 405);
});
