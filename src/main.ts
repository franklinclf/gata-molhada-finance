import { fileURLToPath } from 'node:url';
import { loadAiConfig, startAiLoop } from './ai/job.ts';
import { AuthService, loadAuthConfig } from './auth/service.ts';
import { loadConfig } from './config.ts';
import { createHttpServer } from './http/server.ts';
import { fetchHttpClient, retryingClient } from './core/http.ts';
import { observedSources } from './scheduler/defaults.ts';
import { formatObserverEvent } from './scheduler/events.ts';
import { Observer } from './scheduler/observer.ts';
import { reconcileAfterSync } from './scheduler/reconcile-after-sync.ts';
import { openSqliteStore } from './store/sqlite-store.ts';
import { buildAdapters } from './sync/adapters.ts';
import { loadAdapterEnv } from './sync/config.ts';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const config = loadConfig(process.env);
const store = openSqliteStore(config.dbPath, migrationsDir);
const authConfig = loadAuthConfig(process.env);
if (!authConfig) console.warn('AUTH_PASSWORD_HASH or AUTH_TOTP_SECRET is not set, so login is disabled and the API stays closed');
const auth = new AuthService(store, authConfig, () => new Date());
const server = createHttpServer({ store, version: config.version, auth, secureCookies: config.secureCookies }, config.webDir);

const observerStop = new AbortController();
if (config.observer) {
  const sources = observedSources(buildAdapters(loadAdapterEnv(process.env), { store, http: retryingClient(fetchHttpClient()) }));
  if (sources.length === 0) {
    console.warn('OBSERVER is on but no source is configured, so nothing will be watched');
  } else {
    const observer = new Observer({
      store,
      sources,
      reconcile: () => reconcileAfterSync(store),
      onEvent: (event) => {
        const line = formatObserverEvent(event);
        if (line) console.log(line);
      },
    });
    void observer.run(observerStop.signal);
    console.log(`observer on: ${sources.map((s) => s.adapter.id).join(', ')}`);
  }
}

const aiConfig = loadAiConfig(process.env);
if (aiConfig.enabled && aiConfig.apiKey) {
  startAiLoop(store, aiConfig, observerStop.signal, (line) => console.log(line));
  console.log(`ai on: ${aiConfig.models[0]} (fallback ${aiConfig.models[1]}), budget US$ ${aiConfig.monthlyBudgetUsd}/month`);
} else if (aiConfig.enabled) {
  console.warn('AI_ENABLED is on but OPENROUTER_API_KEY is not set, so the categorizer is off');
}

server.on('error', (error) => {
  console.error(`server error: ${error.message}`);
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`listening on :${config.port} (version ${config.version}, schema ${store.schemaVersion()})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  observerStop.abort();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
