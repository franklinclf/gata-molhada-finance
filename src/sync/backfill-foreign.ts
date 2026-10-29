import type { Parties } from '../core/parties.ts';
import type { Store } from '../store/store.ts';

const SETTING = 'foreign_amounts_backfilled';

const cents = (units: number): number => Math.round(units * 100);

interface Found {
  externalId: string;
  currency: string;
  /** Absolute amount in the original currency, in cents. */
  original: number;
  /** Absolute amount in reais, in cents, or null when the source gave none. */
  charged: number | null;
}

function pluggyRecords(body: unknown): Found[] {
  const list = typeof body === 'object' && body !== null ? (body as { results?: unknown }).results : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r: Record<string, unknown>) => {
    const currency = typeof r.currencyCode === 'string' ? r.currencyCode : null;
    if (!currency || currency === 'BRL' || typeof r.id !== 'string' || typeof r.amount !== 'number') return [];
    const charged = typeof r.amountInAccountCurrency === 'number' ? cents(Math.abs(r.amountInAccountCurrency)) : null;
    return [{ externalId: r.id, currency, original: cents(Math.abs(r.amount)), charged }];
  });
}

function pierreRecords(body: unknown): Found[] {
  const list = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r: Record<string, unknown>) => {
    const currency = typeof r.currency_code === 'string' ? r.currency_code : null;
    const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount);
    if (!currency || currency === 'BRL' || typeof r.id !== 'string' || !Number.isFinite(amount)) return [];
    const inAccount = r.amount_in_account_currency === null || r.amount_in_account_currency === undefined ? null : Number(r.amount_in_account_currency);
    return [{ externalId: r.id, currency, original: cents(Math.abs(amount)), charged: inAccount !== null && Number.isFinite(inAccount) ? cents(Math.abs(inAccount)) : null }];
  });
}

/**
 * Purchases in another currency were saved with the foreign number as if it were reais (9 euros counted as R$ 9,00). The raw
 * answers the sources gave still hold the amount charged in reais, so the saved records are corrected from them, once.
 * Returns how many amounts changed.
 */
export function backfillForeignAmounts(store: Store, now: Date): number {
  if (store.getSetting(SETTING) !== null) return 0;
  let changed = 0;
  const sources: Array<[string, string, (body: unknown) => Found[]]> = [
    ['pluggy', '/v2/transactions', pluggyRecords],
    ['pierre', 'get-transactions', pierreRecords],
  ];
  for (const [sourceId, prefix, read] of sources) {
    const saved = new Map(store.listSourceTransactions(sourceId).map((t) => [t.externalId, t]));
    for (const snapshot of store.listSnapshots(sourceId, prefix)) {
      for (const found of read(snapshot.body)) {
        const record = saved.get(found.externalId);
        if (!record) continue;
        const sign = record.amount < 0 ? -1 : 1;
        const parties: Parties = { operation: null, mcc: null, payer: null, receiver: null, ...(record.parties ?? {}), foreign: { currency: found.currency, amount: found.original, converted: found.charged !== null } };
        store.setSourceTransactionParties(sourceId, found.externalId, parties);
        if (found.charged !== null && record.amount !== 0 && Math.abs(record.amount) !== found.charged) {
          store.setSourceTransactionAmount(sourceId, found.externalId, sign * found.charged);
          saved.set(found.externalId, { ...record, amount: sign * found.charged });
          changed++;
        }
      }
    }
  }
  store.setSetting(SETTING, now.toISOString(), now.toISOString());
  return changed;
}
