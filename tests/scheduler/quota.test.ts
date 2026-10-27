import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { formatQuotaReport, quotaReport } from '../../src/scheduler/quota.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T16:00:00.000Z');

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  for (const id of ['pierre', 'pluggy']) store.registerSource({ id, kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  const at = NOW.toISOString();
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T10:00:00.000Z', observedAt: at });
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T14:00:00.000Z', observedAt: at });
  store.upsertFreshness({ sourceId: 'pluggy', institution: 'Bank A', lastUpdatedAt: '2026-10-26T09:00:00.000Z', observedAt: at });
  store.upsertFreshness({ sourceId: 'pluggy', institution: 'Bank B', lastUpdatedAt: '2026-10-26T09:00:00.000Z', observedAt: at, quotaExhausted: true });
  return store;
}

test('reports reads per institution for the current month, from both sources', () => {
  const rows = quotaReport(seeded(), NOW);
  assert.deepEqual(rows.map((r) => [r.institution, r.used, r.level, r.exhausted]), [
    ['Bank A', 3, 'ok', false],
    ['Bank B', 1, 'blocked', true],
  ]);
});

test('ignores reads from other months', () => {
  const store = seeded();
  assert.equal(quotaReport(store, new Date('2026-11-15T12:00:00.000Z')).every((r) => r.used === 0), true);
});

test('formats a readable table with a caveat', () => {
  const lines = formatQuotaReport(quotaReport(seeded(), NOW));
  assert.equal(lines[0], 'Institution   Reads   Share   Status');
  assert.ok(lines[1]?.startsWith('Bank A        3/240   1%      ok'));
  assert.ok(lines[2]?.endsWith('limit reached'));
  assert.match(lines.at(-1) ?? '', /real bank usage may be higher/);
  assert.deepEqual(formatQuotaReport([]), ['No bank reads recorded this month.']);
});
