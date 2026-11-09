import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Debounce } from './http/deploy-hook.ts';
import { effectOf, recordAlert, type PluggyEvent } from './http/pluggy-hook.ts';
import { encryptBackupAsync } from './backup/backup.ts';
import { assertCopyWritten, pruneCopies } from './backup/retention.ts';
import { ask } from './ai/analyst.ts';
import type { AiRunScope } from './ai/job.ts';
import { loadAiConfig, runCategorizerNow, runCategorizerOnce, startAiLoop } from './ai/job.ts';
import { openRouterClient } from './ai/openrouter.ts';
import { refreshKeyUsage } from './ai/spend.ts';
import { AuthService, loadAuthConfig } from './auth/service.ts';
import { relyingPartyFor } from './auth/webauthn.ts';
import { runReconciliation } from './reconcile/run.ts';
import { backfillForeignAmounts } from './sync/backfill-foreign.ts';
import { backfillParties } from './sync/backfill-parties.ts';
import { loadConfig } from './config.ts';
import { createHttpServer } from './http/server.ts';
import { fetchHttpClient, retryingClient } from './core/http.ts';
import { observedSources } from './scheduler/defaults.ts';
import { formatObserverEvent } from './scheduler/events.ts';
import { Observer } from './scheduler/observer.ts';
import { createResetter } from './sync/reset.ts';
import { reconcileAfterSync } from './scheduler/reconcile-after-sync.ts';
import { openSqliteStore } from './store/sqlite-store.ts';
import { activeSourceIds, buildAdapters } from './sync/adapters.ts';
import { loadAdapterEnv } from './sync/config.ts';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const config = loadConfig(process.env);
// The database, its journal files and the backups hold everything about the owner's money: readable by the app's user only.
process.umask(0o077);
const store = openSqliteStore(config.dbPath, migrationsDir);
for (const suffix of ['', '-wal', '-shm']) {
  try {
    chmodSync(`${config.dbPath}${suffix}`, 0o600);
  } catch {
    // The journal files exist only while the database is in use.
  }
}
try {
  chmodSync(join(dirname(config.dbPath), 'backups'), 0o700);
} catch {
  // No backups folder yet.
}
const backfilled = backfillParties(store, new Date());
const corrected = backfillForeignAmounts(store, new Date());
if (backfilled > 0 || corrected > 0) {
  runReconciliation(store);
  if (backfilled > 0) console.log(`read who paid and who received on ${backfilled} saved records`);
  if (corrected > 0) console.log(`corrected the amount of ${corrected} purchases made in another currency`);
}
const authConfig = loadAuthConfig(process.env);
if (!authConfig) console.warn('AUTH_PASSWORD_HASH or AUTH_TOTP_SECRET is not set, so login is disabled and the API stays closed');
const relyingParty = relyingPartyFor(process.env.PUBLIC_ORIGIN);
if (authConfig && !relyingParty) console.warn('PUBLIC_ORIGIN is not set to an https address, so passkeys are off (password and code still work)');
const auth = new AuthService(store, authConfig, () => new Date(), {}, relyingParty);
const adapters = buildAdapters(loadAdapterEnv(process.env), { store, http: retryingClient(fetchHttpClient()) });
// A source with no adapter any more (the Pierre integration was removed) keeps its saved records but stops reporting freshness.
// PDF statements have no adapter either, and stay active (`activeSourceIds`).
const retired = store.retireSourcesExcept(activeSourceIds(adapters));
if (retired.length > 0) console.log(`retired sources, kept as saved history: ${retired.join(', ')}`);
/** How many before-reset copies stay in the backups folder. */
const KEEP_RESET_COPIES = 3;
const refreshAdapter = adapters.find((a) => a.capabilities.refreshOnDemand);
const aiOn = (): boolean => aiConfig.enabled && aiConfig.apiKey !== null;
const resetter = refreshAdapter
  ? createResetter({
      store,
      adapter: refreshAdapter,
      backup: () => {
        const dir = join(dirname(config.dbPath), 'backups');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
        store.copyTo(file);
        // A copy that is missing or empty protects nothing, so the reset stops here. Only the newest few copies are kept.
        assertCopyWritten(file);
        pruneCopies(dir, 'before-reset-', KEEP_RESET_COPIES);
        return file;
      },
      categorize: async () => {
        if (!aiOn()) return null;
        const result = await runCategorizerOnce(store, aiConfig, () => new Date());
        return result ? `IA: ${result.asked} descrições perguntadas, ${result.applied} aplicadas, ${result.suggested} para você decidir` : null;
      },
    })
  : undefined;
const backup = async (passphrase: string): Promise<Buffer> => {
  // A consistent copy next to the database (same disk), read once and removed.
  const copy = join(dirname(config.dbPath), `.backup-${randomBytes(6).toString('hex')}.sqlite`);
  try {
    store.copyTo(copy);
    return await encryptBackupAsync(await readFile(copy), passphrase);
  } finally {
    rmSync(copy, { force: true });
  }
};
const aiConfig = loadAiConfig(process.env);
const analyst = aiConfig.enabled && aiConfig.apiKey ? (input: { conversationId?: number; question: string }) => ask(store, { client: openRouterClient(aiConfig.apiKey!), models: aiConfig.analystModels, now: () => new Date(), monthlyBudgetUsd: aiConfig.monthlyBudgetUsd }, input).finally(() => void refreshKeyUsage(store, aiConfig.apiKey!, new Date())) : undefined;
// The host watches this file (gmf-deploy.path): writing it starts a deploy. Without a secret the route does not exist.
const deploySecret = process.env.DEPLOY_WEBHOOK_SECRET?.trim();
const hookDebounce = new Debounce(10_000);
const deployHook = deploySecret ? { secret: deploySecret, trigger: () => hookDebounce.allow() && writeFileSync(join(dirname(config.dbPath), '.deploy-requested'), `${new Date().toISOString()}\n`) } : undefined;
// The deploy service watches this file; the webhook and the "check for a new version" button both write it.
const deployFile = join(dirname(config.dbPath), '.deploy-requested');
const deployDebounce = new Debounce(30_000);
const deployNow = () => deployDebounce.allow() && (writeFileSync(deployFile, `${new Date().toISOString()}\n`), true);
// Pluggy tells the app when an item changed. Its dashboard sends no headers, so the secret is the last part of the URL.
const pluggySecret = process.env.PLUGGY_WEBHOOK_SECRET?.trim();
const pluggyLabels = new Map((loadAdapterEnv(process.env).pluggy?.items ?? []).map((item) => [item.itemId, item.label]));
let observer: Observer | undefined;
let wakeTimer: NodeJS.Timeout | undefined;
/** What the events of one burst asked for, merged: a forced read wins over a check, and the oldest start wins. */
let pendingWake: { sync: boolean; readFrom: Date | undefined } = { sync: false, readFrom: undefined };
// Pluggy sends a burst per item (item/updated plus one transactions event per account), so the read waits a moment and runs once.
const wakeObserver = (sync: boolean, readFrom: Date | undefined): void => {
  if (!observer) return;
  pendingWake = { sync: pendingWake.sync || sync, readFrom: readFrom && (!pendingWake.readFrom || readFrom < pendingWake.readFrom) ? readFrom : pendingWake.readFrom };
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    const wake = pendingWake;
    pendingWake = { sync: false, readFrom: undefined };
    observer?.wake('pluggy', wake.sync, wake.readFrom);
  }, 3_000);
};
/** Margin before the oldest changed record, so the read and its clean-up (which skips the first day) both cover it. */
const READ_MARGIN_MS = 2 * 86_400_000;
/** How far back the next read must go to see what a transactions event named: new records can be months old, and an updated or deleted one is looked up. */
const readFromOf = (event: PluggyEvent): Date | undefined => {
  const oldest = event.transactionsMinDate ?? (event.transactionIds.length > 0 ? store.earliestSourceTransactionAt('pluggy', event.transactionIds) : null);
  return oldest === null ? undefined : new Date(Date.parse(oldest) - READ_MARGIN_MS);
};
const pluggyHook = pluggySecret
  ? {
      secret: pluggySecret,
      onEvent: (event: PluggyEvent): void => {
        const label = pluggyLabels.get(event.itemId);
        const now = new Date();
        if (label === undefined) {
          // A connection added or renewed at Meu Pluggy can arrive under a new item id, which is not read until PLUGGY_ITEMS has it.
          if (event.event === 'item/created') recordAlert(store, event.itemId, { institution: 'Meu Pluggy', event: event.event, code: null, message: event.itemId, at: now.toISOString() }, now);
          console.log(`pluggy webhook: ${event.event} for an item not in PLUGGY_ITEMS`);
          return;
        }
        const effect = effectOf(event.event);
        if (effect.alert === 'raise') recordAlert(store, event.itemId, { institution: label, event: event.event, code: event.errorCode, message: event.errorMessage, at: now.toISOString() }, now);
        if (effect.alert === 'clear') recordAlert(store, event.itemId, null, now);
        if (effect.wake) wakeObserver(effect.wake === 'sync', effect.wake === 'sync' ? readFromOf(event) : undefined);
        console.log(`pluggy webhook: ${event.event} for ${label}${event.errorCode ? ` (${event.errorCode})` : ''}`);
      },
    }
  : undefined;
const categorize = aiConfig.enabled && aiConfig.apiKey ? (scope: AiRunScope) => runCategorizerNow(store, aiConfig, () => new Date(), scope).finally(() => void refreshKeyUsage(store, aiConfig.apiKey!, new Date())) : undefined;
/** The owner asked for a refresh at Meu Pluggy: check its items often for a while, so the new data shows up even if a webhook is late. */
const WATCH_MS = 10 * 60_000;
const watchSources = (): { until: string } | null => {
  if (!observer) return null;
  const until = Date.now() + WATCH_MS;
  observer.boost('pluggy', until);
  return { until: new Date(until).toISOString() };
};
const server = createHttpServer({ store, version: config.version, auth, secureCookies: config.secureCookies, resetter, backup, deployHook, pluggyHook, watchSources, analyst, categorize, deployNow: config.version === 'dev' ? undefined : deployNow, startedAt: new Date().toISOString() }, config.webDir);

const observerStop = new AbortController();
if (config.observer) {
  const sources = observedSources(adapters, new Set(pluggyHook ? ['pluggy'] : []));
  if (sources.length === 0) {
    console.warn('OBSERVER is on but no source is configured, so nothing will be watched');
  } else {
    observer = new Observer({
      store,
      sources,
      reconcile: () => reconcileAfterSync(store),
      onEvent: (event) => {
        const line = formatObserverEvent(event);
        if (line) console.log(line);
      },
    });
    void observer.run(observerStop.signal);
    console.log(`observer on: ${sources.map((s) => `${s.adapter.id} every ${Math.round(s.intervalMs / 60_000)} min`).join(', ')}${pluggyHook ? ' (Pluggy webhook on)' : ''}`);
  }
}

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
  clearTimeout(wakeTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
