import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { runReconciliation } from '../reconcile/run.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';

// Usage: node src/maintenance/purge-source-cli.ts <source id> [--apply]
// Without --apply it only counts what would go. With it, a backup is written first and the canonical data is rebuilt after.
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sourceId = args.find((a) => !a.startsWith('--'));
if (!sourceId || args.some((a) => a.startsWith('--') && a !== '--apply')) {
  console.error('usage: purge-source-cli.ts <source id> [--apply]');
  process.exit(2);
}

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const config = loadConfig(process.env);
const store = openSqliteStore(config.dbPath, migrationsDir);

try {
  if (apply) {
    const dir = join(dirname(config.dbPath), 'backups');
    mkdirSync(dir, { recursive: true });
    const backup = join(dir, `before-purge-${sourceId}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    store.copyTo(backup);
    console.log(`backup written: ${backup}`);
  }
  const report = store.purgeSource(sourceId, apply);
  console.log(`${apply ? 'removed' : 'would remove'} from ${sourceId}:`);
  for (const [table, n] of Object.entries(report.removed)) if (n > 0) console.log(`  ${table}: ${n}`);
  console.log(`choices moved to another source's record: ${report.moved.categoryOverrides} categories, ${report.moved.installmentOverrides} installments`);
  if (apply) {
    runReconciliation(store);
    console.log('canonical data rebuilt');
  } else {
    console.log('nothing changed; run again with --apply to remove');
  }
} finally {
  store.close();
}
