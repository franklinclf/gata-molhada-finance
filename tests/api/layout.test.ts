import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { apiRoute } from '../../src/api/routes.ts';
import { defaultLayout, GRID_COLUMNS, loadLayout, MIN_SIZES, MOBILE_COLUMNS, parseLayout, saveLayout, WIDGET_IDS } from '../../src/api/layout.ts';
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
    { version: 2, items: [{ ...item, x: 34, w: 4 }] },
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

const P = (query = '') => new URLSearchParams(query);

test('the desktop layout keeps its old key and shape, and the phone layout has its own', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const old = { version: 2, items: [{ id: 'one', widget: 'findings', x: 0, y: 0, w: 12, h: 3 }] };
  // A layout saved before the phone one existed sits under the original key and still loads as the desktop one.
  store.setSetting('dashboard_layout', JSON.stringify(old), NOW.toISOString());
  assert.deepEqual(loadLayout(store), old);
  assert.deepEqual(loadLayout(store, 'desktop'), old);
  assert.deepEqual(loadLayout(store, 'mobile'), defaultLayout('mobile'));
  saveLayout(store, { version: 2, items: [{ id: 'm', widget: 'cards', x: 0, y: 0, w: 2, h: 4 }] }, NOW, 'mobile');
  assert.deepEqual(loadLayout(store, 'desktop'), old);
  assert.equal(loadLayout(store, 'mobile').items[0]?.id, 'm');
  assert.ok(store.getSetting('dashboard_layout_mobile'));
});

test('the phone default starts with the bills, the month, the balances and the next 14 days, inside two half columns', () => {
  const layout = defaultLayout('mobile');
  assert.deepEqual(layout.items.slice(0, 4).map((i) => i.widget), ['cards', 'outlook', 'balances', 'upcoming']);
  assert.equal(layout.items.length, WIDGET_IDS.length);
  for (const a of layout.items) {
    assert.ok(a.x + a.w <= MOBILE_COLUMNS);
    for (const b of layout.items) {
      if (a !== b) assert.equal(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, false, `${a.id} overlaps ${b.id}`);
    }
  }
});

test('the desktop default respects every smallest size, and single-figure widgets start as small tiles', () => {
  for (const item of defaultLayout().items) {
    assert.ok(item.w >= MIN_SIZES[item.widget].w && item.h >= MIN_SIZES[item.widget].h, item.id);
  }
  const by = Object.fromEntries(defaultLayout().items.map((i) => [i.widget, i]));
  assert.ok(by.balances!.h <= 2 && by.summary!.h <= 2 && by.networth!.h <= 2);
  assert.ok(MIN_SIZES.balances.h === 1 && MIN_SIZES.summary.w <= 2);
});

test('the phone layout accepts only two columns, the desktop one still accepts old wide layouts', () => {
  const item = { id: 'a', widget: 'cards', x: 0, y: 0, w: 4, h: 4 };
  assert.equal(parseLayout({ version: 2, items: [item] }, 'mobile'), null);
  assert.equal(parseLayout({ version: 2, items: [{ ...item, x: 1, w: 2 }] }, 'mobile'), null);
  assert.notEqual(parseLayout({ version: 2, items: [{ ...item, x: 1, w: 1 }] }, 'mobile'), null);
  assert.notEqual(parseLayout({ version: 2, items: [{ ...item, x: 20, w: 16 }] }), null);
  assert.deepEqual(parseLayout({ widgets: [{ id: 'cards', hidden: false }, { id: 'goals', hidden: false }] }, 'mobile')?.items.map((i) => i.x + i.w <= 2), [true, true]);
});

test('the layout routes take a device, default to desktop and reject anything else', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const desk = { version: 2, items: [{ id: 'one', widget: 'findings', x: 0, y: 0, w: 12, h: 3 }] };
  const phone = { version: 2, items: [{ id: 'two', widget: 'cards', x: 0, y: 0, w: 2, h: 6 }] };
  // No device: the old clients keep working on the desktop layout.
  assert.equal(apiRoute('PUT', '/api/layout', P(), store, NOW, JSON.stringify(desk))?.status, 200);
  assert.equal(apiRoute('PUT', '/api/layout', P('device=mobile'), store, NOW, JSON.stringify(phone))?.status, 200);
  assert.deepEqual(apiRoute('GET', '/api/layout', P(), store, NOW)?.body, desk);
  assert.deepEqual(apiRoute('GET', '/api/layout', P('device=desktop'), store, NOW)?.body, desk);
  assert.deepEqual(apiRoute('GET', '/api/layout', P('device=mobile'), store, NOW)?.body, phone);
  // A wide layout is not a phone layout, and the other way round is fine for a desktop (a narrow one).
  assert.equal(apiRoute('PUT', '/api/layout', P('device=mobile'), store, NOW, JSON.stringify(desk))?.status, 400);
  assert.equal(apiRoute('PUT', '/api/layout', P('device=desktop'), store, NOW, JSON.stringify(phone))?.status, 200);
  for (const bad of ['device=tablet', 'device=', 'device=Mobile']) {
    assert.equal(apiRoute('GET', '/api/layout', P(bad), store, NOW)?.status, 400, bad);
    assert.equal(apiRoute('PUT', '/api/layout', P(bad), store, NOW, JSON.stringify(desk))?.status, 400, bad);
  }
  assert.deepEqual(apiRoute('GET', '/api/layout', P('device=mobile'), openSqliteStore(':memory:', MIGRATIONS), NOW)?.body, defaultLayout('mobile'));
});
