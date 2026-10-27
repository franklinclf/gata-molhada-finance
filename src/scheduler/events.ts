import type { ObserverEvent } from './observer.ts';

/** One readable line per observer event. `checked` events are quiet unless `verbose` is set. */
export function formatObserverEvent(event: ObserverEvent, verbose = false): string | null {
  switch (event.type) {
    case 'checked':
      return verbose ? `${event.sourceId}: no new data` : null;
    case 'changed':
      return `${event.sourceId}: new data from ${event.institutions.join(', ')}`;
    case 'synced': {
      const r = event.result;
      const problems = r.errors.length > 0 ? `, ${r.errors.length} failed step(s): ${r.errors.join('; ')}` : '';
      return `${event.sourceId}: read ${r.accounts} accounts, ${r.transactions} transactions, ${r.bills} bills${problems}`;
    }
    case 'error':
      return `${event.sourceId}: ${event.message} (next try in ${Math.round(event.retryInMs / 60_000)} min)`;
  }
}
