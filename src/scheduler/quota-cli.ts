import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { formatQuotaReport, quotaReport } from './quota.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);
try {
  for (const line of formatQuotaReport(quotaReport(store, new Date()))) console.log(line);
} finally {
  store.close();
}
