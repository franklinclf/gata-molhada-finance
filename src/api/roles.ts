import { normalizeName } from '../core/names.ts';

/**
 * What a transaction is for the arithmetic, apart from what it is called on screen:
 * - card_payment: money that pays a card bill (the credit on the card, or the debit on the bank account),
 * - own_transfer: a move between the user's own accounts,
 * - investment: money put into or taken out of an investment.
 * None of these is spending or income. The role comes from what the source said (its own category and the text), because
 * those are facts. The category shown on screen can be changed by an AI or by the user for display, and must not
 * change a bill from paid to overdue.
 */
export type Role = 'card_payment' | 'own_transfer' | 'investment';

const SOURCE_CATEGORY: Array<[RegExp, Role]> = [
  [/pagamento de cartao|credit card payment|pagamento de fatura|pagamento recebido/, 'card_payment'],
  [/mesma titularidade|same person transfer/, 'own_transfer'],
  [/investiment|investment/, 'investment'],
];

const DESCRIPTION: Array<[RegExp, Role]> = [
  [/^(pagamento recebido|pagto por deb|pagamento de fatura|credit card payment|pagamento fatura)/, 'card_payment'],
  [/^(transferencia mesma titularidade)/, 'own_transfer'],
  [/^(aplicacao|resgate)\b/, 'investment'],
];

/** The categories a person can pick that mean a role. Choosing any other category says the transaction is something else. */
const CHOSEN_CATEGORY: Record<string, Role> = {
  'pagamento de fatura': 'card_payment',
  'transferencia entre minhas contas': 'own_transfer',
  investimentos: 'investment',
};

function firstMatch(rules: Array<[RegExp, Role]>, text: string): Role | null {
  for (const [pattern, role] of rules) if (pattern.test(text)) return role;
  return null;
}

/** The role the source's own words point to. */
export function evidenceRole(sourceCategory: string | null, description: string): Role | null {
  return (sourceCategory ? firstMatch(SOURCE_CATEGORY, normalizeName(sourceCategory)) : null) ?? firstMatch(DESCRIPTION, normalizeName(description));
}

/**
 * The role to use. The user's own choice (a category set on the transaction or a rule) wins in both directions: picking
 * "Pagamento de fatura" makes it a card payment, picking anything else says it is not. An AI category never changes it.
 */
export function roleOf(input: { sourceCategory: string | null; description: string; category: string | null; categoryOrigin: 'source' | 'override' | 'rule' | 'ai' }): Role | null {
  if (input.categoryOrigin === 'override' || input.categoryOrigin === 'rule') {
    return (input.category ? CHOSEN_CATEGORY[normalizeName(input.category)] : undefined) ?? null;
  }
  return evidenceRole(input.sourceCategory, input.description);
}
