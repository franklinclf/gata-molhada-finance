import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDay, reconcileTransactions } from '../../src/reconcile/transactions.ts';
import { canonical, fresh, tx, txSource } from '../support/builders.ts';

const NOW = new Date('2026-10-26T16:00:00.000Z');

function run(pierre: ReturnType<typeof tx>[], pluggy: ReturnType<typeof tx>[], extra: Partial<Parameters<typeof reconcileTransactions>[0]> = {}) {
  const p = pierre.map((t) => ({ ...t, accountExternalId: 'p1' }));
  const g = pluggy.map((t) => ({ ...t, accountExternalId: 'g1' }));
  return reconcileTransactions({
    accounts: [canonical()],
    sources: [txSource('pierre', 0, p, [fresh('pierre', 'Bank A', '2026-10-26T15:00:00.000Z')]), txSource('pluggy', 1, g, [fresh('pluggy', 'Bank A', '2026-10-26T15:00:00.000Z')])],
    now: NOW,
    ...extra,
  });
}

test('localDay uses the Brazilian calendar day', () => {
  assert.equal(localDay('2026-10-21T03:00:00.000Z'), '2026-10-21');
  assert.equal(localDay('2026-10-21T02:59:00.000Z'), '2026-10-20');
});

test('joins the same transaction from two sources when instant, amount and description agree', () => {
  const r = run([tx({ externalId: 'a' })], [tx({ externalId: 'b' })]);
  assert.equal(r.transactions.length, 1);
  assert.equal(r.transactions[0]?.state, 'confirmed');
  assert.deepEqual(r.transactions[0]?.sourceIds, ['pierre', 'pluggy']);
  assert.deepEqual(r.links.map((l) => [l.sourceId, l.matchPass]).sort(), [['pierre', 0], ['pluggy', 1]]);
  assert.equal(r.findings.length, 0);
});

test('joins by calendar day when the time differs', () => {
  const r = run([tx({ externalId: 'a', occurredAt: '2026-10-20T12:00:00.000Z' })], [tx({ externalId: 'b', occurredAt: '2026-10-20T18:30:00.000Z' })]);
  assert.equal(r.transactions.length, 1);
  assert.equal(r.links.find((l) => l.sourceId === 'pluggy')?.matchPass, 2);
});

test('joins an installment charge dated differently by the two sources', () => {
  const pierreTx = tx({ externalId: 'a', occurredAt: '2025-11-29T03:00:00.000Z', amount: -29240, description: 'Store 10/12', descriptionRaw: 'STORE 10/12', installment: { number: 10, total: 12 } });
  const pluggyTx = tx({ externalId: 'b', occurredAt: '2026-08-07T03:00:00.000Z', amount: -29240, description: 'Store 10/12', descriptionRaw: 'STORE 10/12', installment: { number: 10, total: 12 } });
  const r = run([pierreTx], [pluggyTx]);
  assert.equal(r.transactions.length, 1);
  assert.equal(r.links.find((l) => l.sourceId === 'pluggy')?.matchPass, 3);
});

test('joins the same amount within 36 hours when the descriptions are worded differently', () => {
  const r = run(
    [tx({ externalId: 'a', amount: -2000, descriptionRaw: 'Transferencia enviada pelo Pix|Alice', description: 'Transferencia enviada pelo Pix|Alice' })],
    [tx({ externalId: 'b', amount: -2000, occurredAt: '2026-10-21T08:00:00.000Z', descriptionRaw: 'Transferencia enviada|Alice', description: 'Transferencia enviada|Alice' })],
  );
  assert.equal(r.transactions.length, 1);
  assert.equal(r.links.find((l) => l.sourceId === 'pluggy')?.matchPass, 4);
});

test('does not join different amounts or transactions more than 36 hours apart', () => {
  const r = run(
    [tx({ externalId: 'a', amount: -2000, descriptionRaw: 'ONE' })],
    [tx({ externalId: 'b', amount: -2001, descriptionRaw: 'TWO' }), tx({ externalId: 'c', amount: -2000, descriptionRaw: 'THREE', occurredAt: '2026-10-23T12:00:00.000Z' })],
  );
  assert.equal(r.transactions.length, 3);
});

test('a monthly charge is not joined to the same charge of another month', () => {
  const r = run(
    [tx({ externalId: 'a', occurredAt: '2026-10-18T12:00:00.000Z', amount: -2390, descriptionRaw: 'STREAMING' })],
    [tx({ externalId: 'b', occurredAt: '2026-09-18T12:00:00.000Z', amount: -2390, descriptionRaw: 'STREAMING' })],
  );
  assert.equal(r.transactions.length, 2);
});

test('identical purchases on one day are paired one to one', () => {
  const same = { amount: -500, descriptionRaw: 'BAKERY', occurredAt: '2026-10-20T12:00:00.000Z' };
  const r = run([tx({ externalId: 'a1', ...same }), tx({ externalId: 'a2', ...same })], [tx({ externalId: 'b1', ...same }), tx({ externalId: 'b2', ...same })]);
  assert.equal(r.transactions.length, 2);
  assert.ok(r.transactions.every((t) => t.state === 'confirmed'));
  assert.equal(new Set(r.transactions.map((t) => t.id)).size, 2);
});

test('a status difference is a conflict and the posted status wins', () => {
  const r = run([tx({ externalId: 'a', status: 'posted' })], [tx({ externalId: 'b', status: 'pending' })], {
    sources: [
      txSource('pierre', 0, [tx({ externalId: 'a', accountExternalId: 'p1', status: 'posted' })], [fresh('pierre', 'Bank A', '2026-10-26T15:00:00.000Z')]),
      txSource('pluggy', 1, [tx({ externalId: 'b', accountExternalId: 'g1', status: 'pending' })], [fresh('pluggy', 'Bank A', '2026-10-25T20:00:00.000Z')]),
    ],
  });
  assert.equal(r.transactions[0]?.state, 'conflict');
  assert.equal(r.transactions[0]?.status, 'posted');
  assert.equal(r.findings[0]?.kind, 'status_conflict');
  assert.equal(r.findings[0]?.severity, 'info');
});

test('a status conflict that the sync times do not explain is a warning', () => {
  const r = run([tx({ externalId: 'a', status: 'posted' })], [tx({ externalId: 'b', status: 'pending' })]);
  assert.equal(r.findings[0]?.severity, 'warning');
});

test('a transaction in one source only is missing when the other source synced after it', () => {
  const r = run([tx({ externalId: 'a' })], []);
  assert.equal(r.transactions[0]?.state, 'single_source');
  assert.equal(r.findings[0]?.kind, 'missing_in_source');
  assert.equal(r.findings[0]?.details.missingIn, 'pluggy');
});

test('a transaction newer than the other source last sync is only not synced yet', () => {
  const r = run([tx({ externalId: 'a', occurredAt: '2026-10-26T14:00:00.000Z' })], [], {
    sources: [
      txSource('pierre', 0, [tx({ externalId: 'a', accountExternalId: 'p1', occurredAt: '2026-10-26T14:00:00.000Z' })], [fresh('pierre', 'Bank A', '2026-10-26T15:00:00.000Z')]),
      txSource('pluggy', 1, [tx({ externalId: 'x', accountExternalId: 'g1', occurredAt: '2026-10-10T12:00:00.000Z', amount: -1 })], [fresh('pluggy', 'Bank A', '2026-10-25T20:00:00.000Z')]),
    ],
  });
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes('not_yet_synced'));
  assert.equal(r.findings.find((f) => f.kind === 'not_yet_synced')?.severity, 'info');
});

test('no finding for a transaction older than everything the other source has', () => {
  const r = run([tx({ externalId: 'a', occurredAt: '2026-07-01T12:00:00.000Z' })], [tx({ externalId: 'b', occurredAt: '2026-10-01T12:00:00.000Z', amount: -777, descriptionRaw: 'OTHER' })]);
  const old = r.transactions.find((t) => t.occurredAt.startsWith('2026-07-01'));
  assert.equal(old?.state, 'single_source');
  assert.equal(r.findings.filter((f) => f.transactionId === old?.id).length, 0);
});

test('a lone pending bank transaction is set aside after 7 days, a card one after 30', () => {
  const bank = run([tx({ externalId: 'a', status: 'pending', occurredAt: '2026-10-10T12:00:00.000Z' })], []);
  assert.equal(bank.transactions[0]?.state, 'stale_pending');
  assert.equal(bank.transactions[0]?.excluded, true);
  assert.equal(bank.stats.byState.stale_pending, 1);

  const recentBank = run([tx({ externalId: 'a', status: 'pending', occurredAt: '2026-10-22T12:00:00.000Z' })], []);
  assert.equal(recentBank.transactions[0]?.state, 'single_source');

  const card = (days: number) =>
    reconcileTransactions({
      accounts: [canonical({ kind: 'credit_card', name: 'Card' })],
      sources: [txSource('pierre', 0, [tx({ externalId: 'a', accountExternalId: 'p1', status: 'pending', occurredAt: new Date(NOW.getTime() - days * 86_400_000).toISOString() })])],
      now: NOW,
    }).transactions[0]?.state;
  assert.equal(card(20), 'single_source');
  assert.equal(card(35), 'stale_pending');
});

test('a pending transaction that both sources report is never set aside', () => {
  const old = '2026-08-01T12:00:00.000Z';
  const r = run([tx({ externalId: 'a', status: 'pending', occurredAt: old })], [tx({ externalId: 'b', status: 'pending', occurredAt: old })]);
  assert.equal(r.transactions[0]?.state, 'confirmed');
});

test('fills missing fields from the other source', () => {
  const r = run([tx({ externalId: 'a', category: null, descriptionRaw: null })], [tx({ externalId: 'b', category: 'Food', descriptionRaw: 'COFFEE SHOP' })]);
  assert.equal(r.transactions[0]?.category, 'Food');
});

test('ignores duplicate copies of an account and accounts known to one source only', () => {
  const account = canonical({
    refs: [
      { sourceId: 'pierre', externalId: 'p1', role: 'member' },
      { sourceId: 'pluggy', externalId: 'g1', role: 'duplicate' },
    ],
  });
  const r = reconcileTransactions({
    accounts: [account],
    sources: [txSource('pierre', 0, [tx({ externalId: 'a', accountExternalId: 'p1' })]), txSource('pluggy', 1, [tx({ externalId: 'b', accountExternalId: 'g1' })])],
    now: NOW,
  });
  assert.equal(r.transactions.length, 1);
  assert.equal(r.findings.length, 0);
});

test('canonical ids are stable and do not depend on input order', () => {
  const a = [tx({ externalId: 'a', descriptionRaw: 'ONE', amount: -100 }), tx({ externalId: 'b', descriptionRaw: 'TWO', amount: -200 })];
  const first = run(a, []);
  const second = run([...a].reverse(), []);
  assert.deepEqual(first.transactions.map((t) => t.id).sort(), second.transactions.map((t) => t.id).sort());
  assert.ok(first.transactions.every((t) => /^tx_[0-9a-f]{16}$/.test(t.id)));
});

test('finding ids are stable between runs', () => {
  const first = run([tx({ externalId: 'a' })], []);
  const second = run([tx({ externalId: 'a' })], []);
  assert.deepEqual(first.findings.map((f) => f.id), second.findings.map((f) => f.id));
});
