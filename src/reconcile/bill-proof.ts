import { localDay } from '../core/time.ts';
import { cyclesFor } from '../api/cycles.ts';
import { effectiveTransactions, ruleKey, type EffectiveTransaction } from '../api/scope.ts';
import type { Store } from '../store/store.ts';

/**
 * Card issuers often leave charges "pending" for good: they sit in one source and never turn into posted records,
 * and the rule that sets aside pending entries seen by one source only drops them from the totals. A published bill
 * is the proof they were real: if the bill is larger than the charges we count, and the set-aside entries of that
 * cycle add up to exactly the difference, they belong to the bill and are restored. A charge that comes back every
 * month with the same text and amount, after one the bill proved, is restored too.
 *
 * This runs on the saved canonical data after every reconciliation, so it is rebuilt from facts each time and
 * nothing is stored that could go stale.
 */

const MAX_CANDIDATES = 22;
const RECURRENCE_DAYS: [number, number] = [20, 40];

/** Subset of `items` whose values add up to `target`, if exactly one such subset exists (the whole set counts as one). */
function uniqueSubset(values: number[], target: number): number[] | null {
  if (target <= 0 || values.length === 0 || values.length > MAX_CANDIDATES) return null;
  if (values.reduce((a, b) => a + b, 0) === target) return values.map((_, i) => i);
  let found: number[] | null = null;
  let count = 0;
  const walk = (i: number, sum: number, chosen: number[]) => {
    if (count > 1 || sum > target) return;
    if (sum === target) {
      count++;
      found = [...chosen];
      return;
    }
    if (i === values.length) return;
    chosen.push(i);
    walk(i + 1, sum + values[i]!, chosen);
    chosen.pop();
    walk(i + 1, sum, chosen);
  };
  walk(0, 0, []);
  return count === 1 ? found : null;
}

const DAY = 86_400_000;

export function proveByBills(store: Store, now: Date): string[] {
  const accounts = store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card');
  const all = effectiveTransactions(store, { includeHidden: true, includeExcluded: true });
  const today = localDay(now.toISOString());
  const restored = new Set<string>();

  for (const account of accounts) {
    const own = all.filter((t) => t.accountId === account.id);
    const setAside = (t: EffectiveTransaction) => t.state === 'stale_pending' && t.role === null && !restored.has(t.id);

    // 1. A closed bill larger than what we count, explained exactly by set-aside entries of its cycle.
    for (const cycle of cyclesFor(store, account, all, today)) {
      if (cycle.billTotal === null || cycle.status === 'unknown' || cycle.status === 'open') continue;
      const gap = cycle.billTotal - (cycle.charges - cycle.credits);
      if (Math.abs(gap) <= 100) continue;
      const candidates = own.filter((t) => setAside(t) && localDay(t.occurredAt) >= cycle.from && localDay(t.occurredAt) <= cycle.to);
      // Money out counts toward the bill, money in takes away from it.
      const values = candidates.map((t) => -t.amount);
      if (values.some((v) => v <= 0)) continue;
      const picked = uniqueSubset(values, gap);
      if (picked) for (const i of picked) restored.add(candidates[i]!.id);
    }

    // 2. The same charge again a month later, after one the bill proved: installments and subscriptions.
    const proven = (t: EffectiveTransaction) => restored.has(t.id) || t.state === 'billed';
    const pending = own.filter(setAside).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    for (const t of pending) {
      const at = new Date(t.occurredAt).getTime();
      const key = ruleKey(t.description);
      const earlier = own.some((o) => o.id !== t.id && proven(o) && o.amount === t.amount && ruleKey(o.description) === key && at - new Date(o.occurredAt).getTime() >= RECURRENCE_DAYS[0] * DAY && at - new Date(o.occurredAt).getTime() <= RECURRENCE_DAYS[1] * DAY);
      if (earlier) restored.add(t.id);
    }
  }

  const ids = [...restored];
  if (ids.length > 0) store.markTransactionsBilled(ids);
  return ids;
}
