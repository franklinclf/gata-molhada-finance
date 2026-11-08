import type { RuleConditions } from './api.ts';

export type PartyDirection = 'in' | 'out';

/** Longest condition value the API accepts (see MAX_VALUE_LENGTH in the rule engine). */
const MAX_NAME = 200;

/** True when a transfer has a person or company that a rule can name: not the owner, and a name short enough to save. */
export function partyRuleApplies(t: { amount: number; role: string | null; operation: string | null; counterparty: { name: string | null; isOwner: boolean } | null }): boolean {
  const name = t.counterparty?.name?.trim() ?? '';
  return name !== '' && name.length <= MAX_NAME && !t.counterparty!.isOwner && t.role === null && /^(pix|ted)$/i.test(t.operation ?? '');
}

/** Money sent to (out) or received from (in) this name. The engine compares names without case or accents. */
export function partyRuleConditions(name: string, direction: PartyDirection): RuleConditions {
  return { match: 'all', items: [{ field: 'counterparty', operator: 'equals', value: name.trim() }, { field: 'direction', operator: 'equals', value: direction }] };
}

/** Rule names are at most 80 characters and unique, so the person's name is the part that varies. */
export function partyRuleName(name: string, direction: PartyDirection): string {
  return `Transferências ${direction === 'out' ? 'para' : 'de'} ${name.trim().replace(/\s+/g, ' ').slice(0, 50)}`;
}
