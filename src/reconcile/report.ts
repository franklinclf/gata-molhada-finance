import type { TransactionReconciliation } from './transactions.ts';

const PASS_LABELS = ['', 'same instant', 'same day', 'installment', 'same amount within 36 hours'];

/** Plain-text summary of a transaction reconciliation. `limit` caps the findings listed per kind. */
export function formatTransactionReport(result: TransactionReconciliation, limit = 10): string[] {
  const { stats, findings } = result;
  const lines: string[] = [];
  lines.push(
    `Transactions: ${stats.groups} (confirmed ${stats.byState.confirmed}, single source ${stats.byState.single_source}, ` +
      `ignored by you ${stats.byState.ignored}, set aside as stale pending ${stats.byState.stale_pending})`,
  );
  const joined = stats.byPass
    .map((n, pass) => (pass === 0 || n === 0 ? null : `${PASS_LABELS[pass]} ${n}`))
    .filter((x): x is string => x !== null);
  lines.push(`Joined across sources by: ${joined.length > 0 ? joined.join(', ') : 'nothing'}`);

  if (findings.length === 0) {
    lines.push('Findings: none');
    return lines;
  }
  const groups = new Map<string, typeof findings>();
  for (const f of findings) {
    const key = `${f.kind} (${f.severity})`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  lines.push(`Findings: ${[...groups].map(([key, list]) => `${list.length} ${key}`).join(', ')}`);
  for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('');
    lines.push(`${key}:`);
    for (const f of list.slice(0, limit)) lines.push(`  - ${f.summary}`);
    if (list.length > limit) lines.push(`  ... ${list.length - limit} more (run with --all)`);
  }
  return lines;
}
