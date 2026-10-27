import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTransactionReport } from '../../src/reconcile/report.ts';
import type { TransactionReconciliation } from '../../src/reconcile/transactions.ts';
import type { Finding } from '../../src/core/canonical.ts';

const finding = (n: number, kind: Finding['kind'] = 'missing_in_source', severity: Finding['severity'] = 'warning'): Finding => ({
  id: `fd_${n}`,
  kind,
  severity,
  accountId: 'acc',
  transactionId: `tx_${n}`,
  summary: `finding ${n}`,
  details: {},
});

const result = (findings: Finding[]): TransactionReconciliation => ({
  transactions: [],
  links: [],
  findings,
  stats: { groups: 10, byState: { confirmed: 6, single_source: 2, conflict: 1, stale_pending: 1 }, byPass: [10, 5, 1, 0, 2] },
});

test('summarizes states and the passes that joined records', () => {
  const lines = formatTransactionReport(result([]));
  assert.equal(lines[0], 'Transactions: 10 (confirmed 6, single source 2, status conflict 1, set aside as stale pending 1)');
  assert.equal(lines[1], 'Joined across sources by: same instant 5, same day 1, same amount within 36 hours 2');
  assert.equal(lines[2], 'Findings: none');
});

test('lists findings grouped by kind and caps each group', () => {
  const findings = [1, 2, 3].map((n) => finding(n)).concat([finding(4, 'stale_pending', 'warning')]);
  const lines = formatTransactionReport(result(findings), 2);
  assert.ok(lines.includes('Findings: 3 missing_in_source (warning), 1 stale_pending (warning)'));
  assert.ok(lines.includes('missing_in_source (warning):'));
  assert.ok(lines.includes('  - finding 1') && lines.includes('  - finding 2'));
  assert.equal(lines.includes('  - finding 3'), false);
  assert.ok(lines.includes('  ... 1 more (run with --all)'));
});
