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

test('a posted report wins over a pending one, and the sources are not in conflict', () => {
  const r = run([tx({ externalId: 'a', status: 'pending' })], [tx({ externalId: 'b', status: 'posted' })]);
  assert.equal(r.transactions[0]?.state, 'confirmed');
  assert.equal(r.transactions[0]?.status, 'posted');
  assert.equal(r.findings.length, 0);
  const other = run([tx({ externalId: 'a', status: 'posted' })], [tx({ externalId: 'b', status: 'pending' })]);
  assert.equal(other.transactions[0]?.status, 'posted');
  assert.equal(other.findings.length, 0);
});

test('a transaction one source does not have is normal: single source, no finding', () => {
  const r = run([tx({ externalId: 'a' })], []);
  assert.equal(r.transactions[0]?.state, 'single_source');
  assert.deepEqual(r.transactions[0]?.sourceIds, ['pierre']);
  assert.equal(r.findings.length, 0);
});

test('pending entries older than 7 days are set aside, on bank accounts and cards alike', () => {
  const bank = run([tx({ externalId: 'a', status: 'pending', occurredAt: '2026-10-10T12:00:00.000Z' })], []);
  assert.equal(bank.transactions[0]?.state, 'stale_pending');
  assert.equal(bank.transactions[0]?.excluded, true);
  assert.equal(bank.stats.byState.stale_pending, 1);
  assert.equal(bank.findings.length, 0);

  const recent = run([tx({ externalId: 'a', status: 'pending', occurredAt: '2026-10-22T12:00:00.000Z' })], []);
  assert.equal(recent.transactions[0]?.state, 'single_source');

  const card = (days: number) =>
    reconcileTransactions({
      accounts: [canonical({ kind: 'credit_card', name: 'Card' })],
      sources: [txSource('pierre', 0, [tx({ externalId: 'a', accountExternalId: 'p1', status: 'pending', occurredAt: new Date(NOW.getTime() - days * 86_400_000).toISOString() })])],
      now: NOW,
    }).transactions[0]?.state;
  assert.equal(card(5), 'single_source');
  assert.equal(card(9), 'stale_pending');
});

test('a pending entry that both sources report is real, however old: the bank itself says pending', () => {
  const old = '2026-08-01T12:00:00.000Z';
  const r = run([tx({ externalId: 'a', status: 'pending', occurredAt: old })], [tx({ externalId: 'b', status: 'pending', occurredAt: old })]);
  assert.equal(r.transactions[0]?.state, 'confirmed');
  assert.equal(r.transactions[0]?.excluded, false);
});

test('a pending entry with a posted twin of the same amount nearby is the authorization that settled', () => {
  const r = run(
    [tx({ externalId: 'a', status: 'pending', amount: 3991, occurredAt: '2026-10-24T01:00:00.000Z', descriptionRaw: 'PAGAMENTO RECEBIDO' })],
    [tx({ externalId: 'b', status: 'posted', amount: 3991, occurredAt: '2026-10-22T11:00:00.000Z', descriptionRaw: 'Pagamento recebido' })],
  );
  const pending = r.transactions.find((t) => t.status === 'pending');
  assert.equal(pending?.state, 'stale_pending');
  assert.equal(pending?.excluded, true);
  assert.equal(r.transactions.find((t) => t.status === 'posted')?.excluded, false);
});

test('single-source records of different sources with the same amount a few days apart are offered as a possible match', () => {
  const r = run(
    [tx({ externalId: 'a', amount: -4200, occurredAt: '2026-10-10T12:00:00.000Z', descriptionRaw: 'ONE' })],
    [tx({ externalId: 'b', amount: -4200, occurredAt: '2026-10-13T12:00:00.000Z', descriptionRaw: 'TWO' })],
  );
  assert.equal(r.transactions.length, 2);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0]!;
  assert.equal(f.kind, 'possible_match');
  assert.equal(f.severity, 'info');
  const first = r.transactions.find((t) => t.id === f.transactionId)!;
  assert.deepEqual(first.sourceIds, ['pierre']);
  assert.equal(r.transactions.find((t) => t.id === f.details.otherTransactionId)?.sourceIds[0], 'pluggy');
  assert.deepEqual(run([tx({ externalId: 'a', amount: -4200, occurredAt: '2026-10-10T12:00:00.000Z', descriptionRaw: 'ONE' })], [tx({ externalId: 'b', amount: -4200, occurredAt: '2026-10-13T12:00:00.000Z', descriptionRaw: 'TWO' })]).findings.map((x) => x.id), [f.id]);
});

test('no possible match when the amounts differ, the gap is long, or both records are from one source', () => {
  assert.equal(run([tx({ externalId: 'a', amount: -100, descriptionRaw: 'ONE' })], [tx({ externalId: 'b', amount: -101, occurredAt: '2026-10-21T12:00:00.000Z', descriptionRaw: 'TWO' })]).findings.length, 0);
  assert.equal(run([tx({ externalId: 'a', amount: -100, descriptionRaw: 'ONE' })], [tx({ externalId: 'b', amount: -100, occurredAt: '2026-10-28T12:00:00.000Z', descriptionRaw: 'TWO' })]).findings.length, 0);
  assert.equal(run([tx({ externalId: 'a', amount: -100, descriptionRaw: 'ONE' }), tx({ externalId: 'b', amount: -100, occurredAt: '2026-10-22T12:00:00.000Z', descriptionRaw: 'TWO' })], []).findings.length, 0);
});

test('records dated before dataStart are not used', () => {
  const r = run([tx({ externalId: 'a', occurredAt: '2025-12-31T12:00:00.000Z', descriptionRaw: 'OLD' }), tx({ externalId: 'b', occurredAt: '2026-01-02T12:00:00.000Z', descriptionRaw: 'NEW' })], [], { dataStart: '2026-01-01' });
  assert.deepEqual(r.transactions.map((t) => t.descriptionRaw), ['NEW']);
});

test('records the user joined by hand become one transaction, even far apart', () => {
  const pierreTx = tx({ externalId: 'a', amount: -5000, occurredAt: '2026-10-01T12:00:00.000Z', descriptionRaw: 'ONE' });
  const pluggyTx = tx({ externalId: 'b', amount: -4999, occurredAt: '2026-10-09T12:00:00.000Z', descriptionRaw: 'TWO' });
  const manual = { pairs: [[{ sourceId: 'pierre', externalId: 'a' }, { sourceId: 'pluggy', externalId: 'b' }]] as [{ sourceId: string; externalId: string }, { sourceId: string; externalId: string }][], ignored: [] };
  const r = run([pierreTx], [pluggyTx], { manual });
  assert.equal(r.transactions.length, 1);
  assert.deepEqual(r.transactions[0]?.sourceIds, ['pierre', 'pluggy']);
  assert.equal(r.transactions[0]?.state, 'confirmed');
  assert.equal(r.links.find((l) => l.sourceId === 'pluggy')?.matchPass, 9);
});

test('a manual join of two records from the same source is refused', () => {
  const a = tx({ externalId: 'a', descriptionRaw: 'ONE', amount: -1 });
  const b = tx({ externalId: 'b', descriptionRaw: 'TWO', amount: -2, occurredAt: '2026-10-22T12:00:00.000Z' });
  const manual = { pairs: [[{ sourceId: 'pierre', externalId: 'a' }, { sourceId: 'pierre', externalId: 'b' }]] as [{ sourceId: string; externalId: string }, { sourceId: string; externalId: string }][], ignored: [] };
  assert.equal(run([a, b], [], { manual }).transactions.length, 2);
});

test('a record the user ignored is kept but left out of the totals', () => {
  const r = run([tx({ externalId: 'a' })], [tx({ externalId: 'b' })], { manual: { pairs: [], ignored: [{ sourceId: 'pluggy', externalId: 'b' }] } });
  assert.equal(r.transactions[0]?.state, 'ignored');
  assert.equal(r.transactions[0]?.excluded, true);
  assert.equal(r.stats.byState.ignored, 1);
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


