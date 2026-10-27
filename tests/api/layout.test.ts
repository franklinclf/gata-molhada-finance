import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { apiRoute } from '../../src/api/routes.ts';
import { defaultLayout, GRID_COLUMNS, loadLayout, parseLayout, WIDGET_IDS } from '../../src/api/layout.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-27T15:00:00Z');

test('the default layout places every widget inside the grid without overlap', () => {
  const layout = defaultLayout();
  assert.equal(layout.items.length, WIDGET_IDS.length);
  for (const a of layout.items) {
    assert.ok(a.x + a.w <= GRID_COLUMNS);
    for (const b of layout.items) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${a.id} overlaps ${b.id}`);
    }
  }
});

test('parseLayout keeps valid items, drops unknown widgets and keeps the settings of each one', () => {
  const layout = parseLayout({
    version: 2,
    items: [
      { id: 'a', widget: 'spending', x: 0, y: 0, w: 6, h: 4, config: { period: '3m' } },
      { id: 'b', widget: 'spending', x: 6, y: 0, w: 6, h: 4 },
      { id: 'c', widget: 'nope', x: 0, y: 4, w: 4, h: 4 },
    ],
  });
  assert.deepEqual(layout?.items.map((i) => [i.id, i.widget, i.config?.period]), [['a', 'spending', '3m'], ['b', 'spending', undefined]]);
});

test('parseLayout rejects bad shapes: out of the grid, repeated ids, bad settings, too many items', () => {
  const item = { id: 'a', widget: 'cards', x: 0, y: 0, w: 4, h: 4 };
  for (const bad of [
    null,
    'x',
    {},
    { version: 1, items: [] },
    { version: 2, items: 'x' },
    { version: 2, items: [{ ...item, x: 10, w: 4 }] },
    { version: 2, items: [{ ...item, w: 0 }] },
    { version: 2, items: [{ ...item, h: 1.5 }] },
    { version: 2, items: [{ ...item, id: 'bad id!' }] },
    { version: 2, items: [item, item] },
    { version: 2, items: [{ ...item, config: { period: 3 } }] },
    { version: 2, items: [{ ...item, config: [] }] },
    { version: 2, items: new Array(41).fill(item).map((x, i) => ({ ...x, id: `i${i}` })) },
  ]) {
    assert.equal(parseLayout(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('the older layout format is converted, hidden widgets dropped', () => {
  const layout = parseLayout({ widgets: [{ id: 'spending', hidden: false }, { id: 'cards', hidden: true }, { id: 'balances', hidden: false }] });
  assert.deepEqual(layout?.items.map((i) => i.widget), ['spending', 'balances']);
  assert.equal(parseLayout({ widgets: [{ id: 'cards' }] }), null);
});

test('the layout defaults, saves and reads back through the API', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  assert.deepEqual(loadLayout(store), defaultLayout());
  const next = { version: 2, items: [{ id: 'one', widget: 'findings', x: 0, y: 0, w: 12, h: 3 }] };
  assert.equal(apiRoute('PUT', '/api/layout', new URLSearchParams(), store, NOW, JSON.stringify(next))?.status, 200);
  assert.deepEqual(apiRoute('GET', '/api/layout', new URLSearchParams(), store, NOW)?.body, next);
  assert.equal(apiRoute('PUT', '/api/layout', new URLSearchParams(), store, NOW, 'nope')?.status, 400);
  assert.equal(apiRoute('PUT', '/api/layout', new URLSearchParams(), store, NOW, '{"version":2,"items":3}')?.status, 400);
  assert.equal(apiRoute('DELETE', '/api/layout', new URLSearchParams(), store, NOW)?.status, 405);
});
