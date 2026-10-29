import type { PluggyConfig, PluggyItemConfig } from '../adapters/pluggy/adapter.ts';

export interface AdapterEnv {
  pluggy?: PluggyConfig;
}

/**
 * Parses `Label:itemId,Other Label:itemId`. The label is whatever the user calls the
 * connection (usually the bank), and the item id is the part after the last colon.
 */
export function parsePluggyItems(value: string): PluggyItemConfig[] {
  const items = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const cut = part.lastIndexOf(':');
      const label = cut > 0 ? part.slice(0, cut).trim() : '';
      const itemId = cut > 0 ? part.slice(cut + 1).trim() : '';
      if (label === '' || itemId === '') throw new Error(`PLUGGY_ITEMS: expected Label:itemId, got "${part}"`);
      return { label, itemId };
    });
  if (items.length === 0) throw new Error('PLUGGY_ITEMS: no items found');
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.itemId)) throw new Error(`PLUGGY_ITEMS: duplicate item id ${item.itemId}`);
    seen.add(item.itemId);
  }
  return items;
}

export function loadAdapterEnv(env: Record<string, string | undefined>): AdapterEnv {
  const out: AdapterEnv = {};

  const clientId = env.PLUGGY_CLIENT_ID?.trim();
  const clientSecret = env.PLUGGY_CLIENT_SECRET?.trim();
  const items = env.PLUGGY_ITEMS?.trim();
  const given = [clientId, clientSecret, items].filter((v) => v).length;
  if (given === 3) {
    out.pluggy = { clientId: clientId as string, clientSecret: clientSecret as string, items: parsePluggyItems(items as string) };
  } else if (given > 0) {
    throw new Error('Pluggy needs PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET and PLUGGY_ITEMS together');
  }
  return out;
}
