import { institutionKey } from '../core/names.ts';
import { localMonth } from '../core/time.ts';
import type { Store } from '../store/store.ts';
import { assessBudget, type BudgetOptions, type InstitutionBudget } from './budget.ts';

/** Bank reads used this month per institution, with the display name taken from the freshness records. */
export function quotaReport(store: Store, now: Date, options: BudgetOptions = {}): InstitutionBudget[] {
  const month = localMonth(now.toISOString());
  const used = new Map(store.quotaUsage(month).map((u) => [u.institutionKey, u.events]));
  const names = new Map<string, string>();
  const exhausted = new Set<string>();
  for (const f of store.listFreshness()) {
    const key = institutionKey(f.institution);
    if (!names.has(key)) names.set(key, f.institution);
    if (f.quotaExhausted) exhausted.add(key);
  }
  const keys = new Set([...used.keys(), ...names.keys()]);
  return assessBudget(
    [...keys].sort().map((key) => ({ institutionKey: key, institution: names.get(key) ?? key, used: used.get(key) ?? 0, exhausted: exhausted.has(key) })),
    options,
  );
}

export function formatQuotaReport(rows: InstitutionBudget[]): string[] {
  if (rows.length === 0) return ['No bank reads recorded this month.'];
  const lines = ['Institution   Reads   Share   Status'];
  for (const r of rows) {
    const share = `${Math.round((r.used / r.limit) * 100)}%`;
    const status = r.exhausted ? 'limit reached' : r.level === 'blocked' ? 'refresh blocked' : r.level === 'warn' ? 'warning' : 'ok';
    lines.push(`${r.institution.padEnd(13)} ${`${r.used}/${r.limit}`.padEnd(7)} ${share.padEnd(7)} ${status}`);
  }
  lines.push('Counts every distinct sync time seen from either source; the real bank usage may be higher.');
  return lines;
}
