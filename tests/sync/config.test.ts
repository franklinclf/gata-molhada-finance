import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAdapterEnv, parsePluggyItems } from '../../src/sync/config.ts';
import { parseSyncArgs } from '../../src/sync/args.ts';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

test('parsePluggyItems reads labels with spaces and accents', () => {
  assert.deepEqual(parsePluggyItems(`Banco A:${UUID_A}, Crédito Ágil :${UUID_B}`), [
    { label: 'Banco A', itemId: UUID_A },
    { label: 'Crédito Ágil', itemId: UUID_B },
  ]);
});

test('parsePluggyItems rejects malformed and duplicate entries', () => {
  assert.throws(() => parsePluggyItems(UUID_A), /expected Label:itemId/);
  assert.throws(() => parsePluggyItems(`:${UUID_A}`), /expected Label:itemId/);
  assert.throws(() => parsePluggyItems('Banco A:'), /expected Label:itemId/);
  assert.throws(() => parsePluggyItems(`A:${UUID_A},B:${UUID_A}`), /duplicate item id/);
  assert.throws(() => parsePluggyItems(' , '), /no items/);
});

test('loadAdapterEnv enables only the configured sources', () => {
  assert.deepEqual(loadAdapterEnv({}), {});
  assert.deepEqual(loadAdapterEnv({ PIERRE_API_KEY: ' sk-1 ' }), {}, 'the Pierre integration was removed, so its key is ignored');
  const both = loadAdapterEnv({
    PLUGGY_CLIENT_ID: 'cid',
    PLUGGY_CLIENT_SECRET: 'sec',
    PLUGGY_ITEMS: `Banco A:${UUID_A}`,
  });
  assert.equal(both.pluggy?.items[0]?.label, 'Banco A');
  assert.equal(both.pluggy?.clientId, 'cid');
});

test('loadAdapterEnv treats empty values as missing', () => {
  assert.deepEqual(loadAdapterEnv({ PIERRE_API_KEY: '', PLUGGY_CLIENT_ID: '', PLUGGY_CLIENT_SECRET: '', PLUGGY_ITEMS: '' }), {});
});

test('loadAdapterEnv refuses a partial Pluggy configuration', () => {
  assert.throws(() => loadAdapterEnv({ PLUGGY_CLIENT_ID: 'cid' }), /PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET and PLUGGY_ITEMS together/);
});

test('parseSyncArgs defaults to the last 90 days and every source', () => {
  const args = parseSyncArgs([], new Date('2026-10-26T15:00:00.000Z'));
  assert.equal(args.since.toISOString(), '2026-07-28T15:00:00.000Z');
  assert.equal(args.source, null);
});

test('parseSyncArgs reads --since and --source', () => {
  const args = parseSyncArgs(['--since', '2025-10-26', '--source', 'pluggy'], new Date('2026-10-26T15:00:00.000Z'));
  assert.equal(args.since.toISOString(), '2025-10-26T00:00:00.000Z');
  assert.equal(args.source, 'pluggy');
});

test('parseSyncArgs rejects bad input', () => {
  const now = new Date('2026-10-26T15:00:00.000Z');
  assert.throws(() => parseSyncArgs(['--since'], now), /--since expects/);
  assert.throws(() => parseSyncArgs(['--since', '26/10/2026'], now), /--since expects/);
  assert.throws(() => parseSyncArgs(['--since', '2026-13-45'], now), /--since expects/);
  assert.throws(() => parseSyncArgs(['--source'], now), /--source expects/);
  assert.throws(() => parseSyncArgs(['--bogus'], now), /Unknown argument/);
});
