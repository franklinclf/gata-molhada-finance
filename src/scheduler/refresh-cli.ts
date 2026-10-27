import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { fetchHttpClient, retryingClient } from '../core/http.ts';
import { runReconciliation } from '../reconcile/run.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { buildAdapters } from '../sync/adapters.ts';
import { loadAdapterEnv } from '../sync/config.ts';
import { syncSource } from '../sync/sync.ts';
import { quotaReport, formatQuotaReport } from './quota.ts';
import { parseRefreshArgs } from './refresh-args.ts';
import { RefreshBlockedError, requestManualRefresh } from './refresh.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
let args;
try {
  args = parseRefreshArgs(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);
try {
  const adapters = buildAdapters(loadAdapterEnv(process.env), { store, http: retryingClient(fetchHttpClient()) });
  const adapter = adapters.find((a) => a.capabilities.refreshOnDemand);
  if (!adapter) {
    console.error('No source can refresh on demand. Set PIERRE_API_KEY.');
    process.exitCode = 1;
  } else {
    try {
      const outcome = await requestManualRefresh({ store, adapter, force: args.force, onProgress: (m) => console.log(m) });
      const result = await syncSource(adapter, { store }, new Date(Date.now() - 14 * 86_400_000));
      runReconciliation(store);
      console.log(`read ${result.accounts} accounts, ${result.transactions} transactions, ${result.bills} bills`);
      for (const e of result.errors) console.error(`  error: ${e}`);
      if (outcome.timedOut.length > 0) {
        console.error(`did not update in time: ${outcome.timedOut.join(', ')} (their previous data stays in use)`);
      }
      if (outcome.timedOut.length > 0 || result.errors.length > 0) process.exitCode = 1;
    } catch (error) {
      if (error instanceof RefreshBlockedError) {
        console.error('Refresh not started:');
        for (const reason of error.reasons) console.error(`  - ${reason}`);
        console.error('Use --force to skip the spacing and budget checks.');
      } else {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exitCode = 1;
    }
    console.log('');
    for (const line of formatQuotaReport(quotaReport(store, new Date()))) console.log(line);
  }
} finally {
  store.close();
}
