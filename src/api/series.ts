import { normalizeName } from '../core/names.ts';

/** Some issuers write the installment into the description ("Store 5/6"), which would make every installment look like another purchase. */
export function seriesDescription(description: string): string {
  return description.replace(/\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/, '').trim();
}

export const seriesText = (description: string) => normalizeName(seriesDescription(description));

/** Texts shorter than this are too generic to say that a longer one is the same purchase. */
export const MIN_PREFIX = 8;

/** What the grouping reads of a transaction. */
export interface SeriesMember {
  id: string;
  accountId: string;
  amount: number;
  description: string;
  excluded: boolean;
  installment: { number: number; total: number } | null;
}

/**
 * The installment charges of each purchase, by a key that names the card, the text, the count and the amount. Charges left out
 * of the totals, credits, single installments and the ids in `skip` belong to no purchase. Both the plan of installments and the
 * names the owner gives a purchase use this, so "the same purchase" means the same thing everywhere.
 */
export function groupSeries<T extends SeriesMember>(transactions: T[], skip?: ReadonlySet<string>): Map<string, T[]> {
  const series = new Map<string, T[]>();
  const shapes = new Map<string, { accountId: string; text: string; total: number; amount: number }>();
  for (const t of transactions) {
    if (!t.installment || t.excluded || t.installment.total < 2 || t.amount >= 0 || skip?.has(t.id)) continue;
    // 3 x 100,00 can be billed 33,34 / 33,33 / 33,33: amounts within one cent per instalment are the same purchase.
    const tolerance = t.installment.total;
    const text = seriesText(t.description);
    const same = (s: { accountId: string; total: number; amount: number }) => s.accountId === t.accountId && s.total === tolerance && Math.abs(s.amount - -t.amount) <= tolerance;
    let key: string | undefined;
    for (const [k, s] of shapes) if (same(s) && s.text === text) key = k;
    // A bank can change the text halfway (Nubank adds the store name to "Parcelamento de Compra"): a series whose text starts
    // like this one, with the same count and amount and without this number yet, is the same purchase.
    if (key === undefined) {
      for (const [k, s] of shapes) {
        const prefix = s.text.length >= MIN_PREFIX && text.length >= MIN_PREFIX && (s.text.startsWith(text) || text.startsWith(s.text));
        if (same(s) && prefix && !series.get(k)!.some((o) => o.installment!.number === t.installment!.number)) key = k;
      }
    }
    if (key === undefined) {
      key = `${t.accountId}|${seriesDescription(t.description)}|${tolerance}|${-t.amount}`;
      shapes.set(key, { accountId: t.accountId, text, total: tolerance, amount: -t.amount });
    }
    series.set(key, [...(series.get(key) ?? []), t]);
  }
  return series;
}

/** The ids of the installments of the purchase this transaction is part of, itself included; just its own id when it is part of none. */
export function seriesMates<T extends SeriesMember>(transactions: T[], id: string): string[] {
  for (const list of groupSeries(transactions).values()) if (list.some((t) => t.id === id)) return list.map((t) => t.id);
  return [id];
}

/**
 * The name each transaction shows: its own, or for an installment the newest name given to any installment of the same purchase,
 * so a name given on one installment is on all of them, also on the ones that arrive later or after the bank changes the text.
 */
export function namesWithSeries<T extends SeriesMember>(transactions: T[], names: ReadonlyMap<string, { name: string; updatedAt: string }>): Map<string, string> {
  const out = new Map([...names].map(([id, n]) => [id, n.name]));
  for (const list of groupSeries(transactions).values()) {
    let newest: { name: string; updatedAt: string } | undefined;
    for (const t of list) {
      const n = names.get(t.id);
      if (n && (newest === undefined || n.updatedAt > newest.updatedAt)) newest = n;
    }
    if (newest) for (const t of list) out.set(t.id, newest.name);
  }
  return out;
}
