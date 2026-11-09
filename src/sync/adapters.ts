import { PluggyAdapter } from '../adapters/pluggy/adapter.ts';
import type { SourceAdapter } from '../core/adapter.ts';
import type { HttpClient } from '../core/http.ts';
import { MANUAL_IMPORT_SOURCES } from '../core/sources.ts';
import type { Store } from '../store/store.ts';
import type { AdapterEnv } from './config.ts';
import { createSnapshotSink, registerAdapter } from './sync.ts';

export interface BuildDeps {
  store: Store;
  http: HttpClient;
  now?: () => Date;
}

/** The single place that knows which adapters exist. Removing a source means removing its lines here. */
export function buildAdapters(env: AdapterEnv, deps: BuildDeps): SourceAdapter[] {
  const now = deps.now ?? (() => new Date());
  const adapters: SourceAdapter[] = [];

  if (env.pluggy) {
    adapters.push(new PluggyAdapter(env.pluggy, { http: deps.http, sink: createSnapshotSink(deps.store, 'pluggy', now), now }));
  }
  for (const adapter of adapters) registerAdapter(adapter, deps.store, now());
  return adapters;
}

/** Sources that stay active: the ones with an adapter and the ones the owner feeds by hand (PDF statements). Every other registered source is retired. */
export function activeSourceIds(adapters: SourceAdapter[]): string[] {
  return [...adapters.map((a) => a.id), ...MANUAL_IMPORT_SOURCES];
}
