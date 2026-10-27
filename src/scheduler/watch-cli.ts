import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { fetchHttpClient, retryingClient } from '../core/http.ts';
import { openSqliteStore } from '../store/sqlite-store.ts';
import { reconcileAfterSync } from './reconcile-after-sync.ts';
import { buildAdapters } from '../sync/adapters.ts';
import { loadAdapterEnv } from '../sync/config.ts';
import { observedSources } from './defaults.ts';
import { formatObserverEvent } from './events.ts';
import { Observer } from './observer.ts';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const once = process.argv.includes('--once');
const verbose = process.argv.includes('--verbose') || once;
const unknown = process.argv.slice(2).filter((a) => !['--once', '--verbose'].includes(a));
if (unknown.length > 0) {
  console.error(`error: Unknown argument: ${unknown.join(' ')}`);
  process.exit(2);
}

const store = openSqliteStore(loadConfig(process.env).dbPath, migrationsDir);
let exitCode = 0;
try {
  const adapters = buildAdapters(loadAdapterEnv(process.env), { store, http: retryingClient(fetchHttpClient()) });
  const sources = observedSources(adapters);
  if (sources.length === 0) {
    console.error('No source to watch. Set PIERRE_API_KEY and/or the PLUGGY_* variables.');
    exitCode = 1;
  } else {
    const observer = new Observer({
      store,
      sources,
      reconcile: () => reconcileAfterSync(store),
      onEvent: (event) => {
        if (event.type === 'error') exitCode = 1;
        const line = formatObserverEvent(event, verbose);
        if (line) console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
      },
    });
    if (once) {
      for (const source of sources) await observer.tick(source);
    } else {
      const controller = new AbortController();
      process.on('SIGINT', () => controller.abort());
      process.on('SIGTERM', () => controller.abort());
      console.log(`Watching ${sources.map((s) => `${s.adapter.id} every ${Math.round(s.intervalMs / 60_000)} min`).join(', ')}. Ctrl+C stops.`);
      await observer.run(controller.signal);
    }
  }
} finally {
  store.close();
}
process.exitCode = exitCode;
