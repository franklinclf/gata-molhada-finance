import { PluggyAdapter } from '../adapters/pluggy/adapter.ts';
import type { SourceAdapter } from '../core/adapter.ts';
import type { HttpClient } from '../core/http.ts';
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
