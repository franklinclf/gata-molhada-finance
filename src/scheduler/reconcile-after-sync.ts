import type { Store } from '../store/store.ts';
import { runReconciliation } from '../reconcile/run.ts';

/** What the observer runs after reading new data: rebuild accounts, transactions and findings. */
export function reconcileAfterSync(store: Store): void {
  runReconciliation(store);
}
