import { partiesOf as pierreParties } from '../adapters/pierre/normalize.ts';
import { partiesOf as pluggyParties } from '../adapters/pluggy/normalize.ts';
import type { Store } from '../store/store.ts';

const SETTING = 'parties_backfilled_v2';

function recordsOf(body: unknown, key: 'data' | 'results'): Array<Record<string, unknown>> {
  const list = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : null;
  return Array.isArray(list) ? list.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r)) : [];
}

/**
 * Records saved before the parties were read lack them, but the raw answers the sources gave are still stored. Runs once:
 * it replays those answers, oldest first, so the newest one wins. Returns how many records were filled.
 */
export function backfillParties(store: Store, now: Date): number {
  if (store.getSetting(SETTING) !== null) return 0;
  let filled = 0;
  const sources: Array<[string, string, 'data' | 'results', (r: Record<string, unknown>) => ReturnType<typeof pierreParties>]> = [
    ['pierre', 'get-transactions', 'data', pierreParties],
    ['pluggy', '/v2/transactions', 'results', pluggyParties],
  ];
  for (const [sourceId, prefix, key, partiesOf] of sources) {
    for (const snapshot of store.listSnapshots(sourceId, prefix)) {
      for (const record of recordsOf(snapshot.body, key)) {
        const parties = partiesOf(record);
        if (parties && typeof record.id === 'string') {
          store.setSourceTransactionParties(sourceId, record.id, parties);
          filled += 1;
        }
      }
    }
  }
  store.setSetting(SETTING, now.toISOString(), now.toISOString());
  return filled;
}
