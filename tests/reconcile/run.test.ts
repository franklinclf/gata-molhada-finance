import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadSourceViews, runAccountReconciliation, runReconciliation } from '../../src/reconcile/run.ts';
import { openSqliteStore } from '../../src/store/sqlite-store.ts';
import { account, history, tx } from '../support/builders.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const NOW = new Date('2026-10-26T16:00:00.000Z');

function seeded() {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  for (const id of ['pierre', 'pluggy']) store.registerSource({ id, kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  store.upsertSourceAccounts('pierre', [account({ externalId: 'p1', balance: 500000 })], NOW.toISOString());
  store.upsertSourceTransactions('pierre', history('p1', 'pt'), NOW.toISOString());
  store.upsertSourceAccounts('pluggy', [account({ externalId: 'g1', balance: 514051 })], NOW.toISOString());
  store.upsertSourceTransactions('pluggy', history('g1', 'gt'), NOW.toISOString());
  store.upsertFreshness({ sourceId: 'pierre', institution: 'Bank A', lastUpdatedAt: '2026-10-26T15:38:00.000Z', observedAt: NOW.toISOString() });
  store.upsertFreshness({ sourceId: 'pluggy', institution: 'Bank A', lastUpdatedAt: '2026-10-25T20:00:00.000Z', observedAt: NOW.toISOString() });
  return store;
}

test('rebuilds and saves the canonical accounts from the stored source records', () => {
  const store = seeded();
  const result = runAccountReconciliation(store, { now: () => NOW });
  assert.equal(result.accounts.length, 1);
  const [saved] = store.listCanonicalAccounts();
  assert.equal(saved?.balance, 500000);
  assert.equal(saved?.balanceSourceId, 'pierre');
  assert.equal(saved?.refs.length, 2);
});

test('running it again keeps the same ids and does not duplicate rows', () => {
  const store = seeded();
  runAccountReconciliation(store, { now: () => NOW });
  const first = store.listCanonicalAccounts().map((a) => a.id);
  runAccountReconciliation(store, { now: () => new Date('2026-10-26T17:00:00.000Z') });
  assert.deepEqual(store.listCanonicalAccounts().map((a) => a.id), first);
  assert.equal(store.listCanonicalAccounts().length, 1);
});

test('a source that was never synced is ignored', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  store.registerSource({ id: 'pierre', kind: 'aggregator', capabilities: {} }, NOW.toISOString());
  store.upsertSourceAccounts('pierre', [account({ externalId: 'p1' })], NOW.toISOString());
  const views = loadSourceViews(store, ['pierre', 'pluggy']);
  assert.deepEqual(views.map((v) => v.sourceId), ['pierre']);
  const result = runAccountReconciliation(store, { now: () => NOW });
  assert.deepEqual(result.notes, []);
});

test('with no synced data it saves nothing', () => {
  const store = openSqliteStore(':memory:', MIGRATIONS);
  const result = runAccountReconciliation(store, { now: () => NOW });
  assert.deepEqual(result.accounts, []);
  assert.deepEqual(store.listCanonicalAccounts(), []);
});


function seededTransactions() {
  const store = seeded();
  const at = NOW.toISOString();
  store.upsertSourceTransactions('pierre', [tx({ externalId: 'pierre-only', accountExternalId: 'p1', occurredAt: '2026-10-22T12:00:00.000Z', amount: -777, descriptionRaw: 'ONLY HERE' })], at);
  store.upsertSourceTransactions('pluggy', [tx({ externalId: 'pluggy-only', accountExternalId: 'g1', occurredAt: '2026-10-25T12:00:00.000Z', amount: -777, descriptionRaw: 'WORDED DIFFERENTLY' })], at);
  return store;
}

const later = new Date('2026-10-26T18:00:00.000Z');

test('the full reconciliation saves accounts, transactions, links and the suggestion to join two records', () => {
  const store = seededTransactions();
  const result = runReconciliation(store, { now: () => NOW });
  assert.equal(result.accounts.accounts.length, 1);
  assert.equal(result.transactions.stats.byState.confirmed, 4);
  assert.equal(result.transactions.stats.byState.single_source, 2);
  assert.equal(store.listCanonicalTransactions().length, 6);
  const findings = store.listFindings();
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'possible_match');
});

test('running it again keeps ids and the opening time of open suggestions', () => {
  const store = seededTransactions();
  runReconciliation(store, { now: () => NOW });
  const before = store.listFindings()[0];
  runReconciliation(store, { now: () => later });
  const after = store.listFindings()[0];
  assert.equal(after?.id, before?.id);
  assert.equal(after?.openedAt, before?.openedAt);
  assert.equal(after?.lastSeenAt, later.toISOString());
  assert.equal(store.listCanonicalTransactions().length, 6);
});

test('joining the two records by hand resolves the suggestion and survives the next rebuild', () => {
  const store = seededTransactions();
  runReconciliation(store, { now: () => NOW });
  const finding = store.listFindings()[0]!;
  assert.equal(store.addManualLink(finding.transactionId, String(finding.details.otherTransactionId), NOW.toISOString()), true);
  runReconciliation(store, { now: () => later });
  assert.deepEqual(store.listFindings(), []);
  assert.equal(store.listCanonicalTransactions().length, 5);
  runReconciliation(store, { now: () => new Date('2026-10-26T19:00:00.000Z') });
  assert.equal(store.listCanonicalTransactions().length, 5);

  const joined = store.listCanonicalTransactions().find((t) => t.sourceIds.length === 2 && t.amount === -777)!;
  store.removeManualLinks(joined.id);
  runReconciliation(store, { now: () => new Date('2026-10-26T20:00:00.000Z') });
  assert.equal(store.listCanonicalTransactions().length, 6);
});

test('a dismissed suggestion does not come back', () => {
  const store = seededTransactions();
  runReconciliation(store, { now: () => NOW });
  store.dismissFinding(store.listFindings()[0]!.id, NOW.toISOString());
  runReconciliation(store, { now: () => later });
  assert.deepEqual(store.listFindings(), []);
  assert.equal(store.listCanonicalTransactions().length, 6);
});

test('ignoring a transaction keeps it out of the totals through rebuilds, and bringing it back restores it', () => {
  const store = seededTransactions();
  runReconciliation(store, { now: () => NOW });
  const target = store.listCanonicalTransactions().find((t) => t.amount === -777 && t.sourceIds[0] === 'pierre')!;
  store.setTransactionIgnored(target.id, true, NOW.toISOString());
  runReconciliation(store, { now: () => later });
  const ignored = store.listCanonicalTransactions({ includeExcluded: true }).find((t) => t.state === 'ignored');
  assert.equal(ignored?.excluded, true);
  assert.equal(store.listCanonicalTransactions().some((t) => t.state === 'ignored'), false);
  store.setTransactionIgnored(ignored!.id, false, NOW.toISOString());
  runReconciliation(store, { now: () => new Date('2026-10-26T19:00:00.000Z') });
  assert.equal(store.listCanonicalTransactions({ includeExcluded: true }).some((t) => t.state === 'ignored'), false);
});

test('records before the data start are deleted', () => {
  const store = seededTransactions();
  store.upsertSourceTransactions('pierre', [tx({ externalId: 'ancient', accountExternalId: 'p1', occurredAt: '2025-06-01T12:00:00.000Z', amount: -1, descriptionRaw: 'ANCIENT' })], NOW.toISOString());
  assert.ok(store.listSourceTransactions('pierre').some((t) => t.externalId === 'ancient'));
  runReconciliation(store, { now: () => NOW });
  assert.equal(store.listSourceTransactions('pierre').some((t) => t.externalId === 'ancient'), false);
  assert.equal(store.listCanonicalTransactions().some((t) => t.descriptionRaw === 'ANCIENT'), false);
});
