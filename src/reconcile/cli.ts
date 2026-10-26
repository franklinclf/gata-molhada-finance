import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { formatBRL } from '../core/money.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { summarizeAccounts } from './accounts.ts';
import { runAccountReconciliation } from './run.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);

try {
  const result = runAccountReconciliation(store);
  if (result.accounts.length === 0) {
    console.error('No accounts found. Run `npm run sync` first.');
    process.exitCode = 1;
  } else {
    const groupOf = new Map(result.groups.map((g, i) => [g.id, `G${i + 1}`]));
    console.log('Institution  Kind         Name                        Last4  Balance          From    Pool  Sources');
    for (const a of result.accounts) {
      const sources = a.refs.map((r) => `${r.sourceId}${r.role === 'duplicate' ? '*' : ''}`).join(',');
      console.log(
        [
          a.institution.padEnd(12),
          a.kind.padEnd(12),
          a.name.slice(0, 26).padEnd(27),
          (a.last4 ?? '').padEnd(6),
          formatBRL(a.balance).padStart(14),
          ` ${(a.balanceSourceId ?? '').padEnd(7)}`,
          (a.limitGroupId ? (groupOf.get(a.limitGroupId) ?? '') : '').padEnd(5),
          sources,
        ].join(' '),
      );
    }
    console.log('  (* = duplicate copy ignored)');

    const totals = summarizeAccounts(result.accounts);
    console.log('');
    console.log(`Bank balance:     ${formatBRL(totals.bankBalance)}`);
    console.log(`Cards owed:       ${formatBRL(totals.cardOwed)}`);
    console.log(`Credit limit:     ${formatBRL(totals.creditLimit)} (used ${formatBRL(totals.creditUsed)}, available ${formatBRL(totals.creditAvailable)})`);
    if (result.notes.length > 0) {
      console.log('');
      console.log('Notes:');
      for (const note of result.notes) console.log(`  - ${note}`);
    }
  }
} finally {
  store.close();
}
