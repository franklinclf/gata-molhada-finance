import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { formatBRL } from '../core/money.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { summarizeAccounts } from './accounts.ts';
import { formatTransactionReport } from './report.ts';
import { runReconciliation } from './run.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const showAll = process.argv.includes('--all');
const unknown = process.argv.slice(2).filter((a) => a !== '--all');
if (unknown.length > 0) {
  console.error(`error: Unknown argument: ${unknown.join(' ')}`);
  process.exit(2);
}

const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);
try {
  const { accounts, transactions } = runReconciliation(store);
  if (accounts.accounts.length === 0) {
    console.error('No accounts found. Run `npm run sync` first.');
    process.exitCode = 1;
  } else {
    const totals = summarizeAccounts(accounts.accounts);
    console.log(`Accounts: ${accounts.accounts.length} (bank balance ${formatBRL(totals.bankBalance)}, cards owed ${formatBRL(totals.cardOwed)})`);
    for (const line of formatTransactionReport(transactions, showAll ? Number.MAX_SAFE_INTEGER : 10)) console.log(line);
  }
} finally {
  store.close();
}
