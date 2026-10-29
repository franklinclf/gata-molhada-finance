import { fileURLToPath } from 'node:url';
import { fetchHttpClient, retryingClient } from '../core/http.ts';
import type { SourceAdapter } from '../core/adapter.ts';
import { loadConfig } from '../config.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { buildAdapters } from './adapters.ts';
import { parseSyncArgs, type SyncArgs } from './args.ts';
import { loadAdapterEnv } from './config.ts';
import { syncSource } from './sync.ts';

function fail(error: unknown): never {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

let args: SyncArgs;
try {
  args = parseSyncArgs(process.argv.slice(2), new Date());
} catch (error) {
  fail(error);
}

const config = loadConfig(process.env);
const store = openSqliteStore(config.dbPath, migrationsDir);

try {
  let adapters: SourceAdapter[];
  try {
    adapters = buildAdapters(loadAdapterEnv(process.env), { store, http: retryingClient(fetchHttpClient()) }).filter(
      (adapter) => args.source === null || adapter.id === args.source,
    );
  } catch (error) {
    fail(error);
  }

  if (adapters.length === 0) {
    console.error('No source to sync. Set the PLUGGY_* variables, or check --source.');
    process.exitCode = 1;
  }

  for (const adapter of adapters) {
    const result = await syncSource(adapter, { store }, args.since);
    console.log(
      `${result.sourceId}: ${result.accounts} accounts, ${result.transactions} transactions, ${result.bills} bills, ${result.freshness} institutions`,
    );
    for (const warning of result.warnings) console.log(`  warning: ${warning}`);
    for (const error of result.errors) console.error(`  error: ${error}`);
    if (result.errors.length > 0) process.exitCode = 1;
  }
} finally {
  store.close();
}
