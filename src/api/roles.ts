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
  [/^(pagamento recebido|pagto por deb|pagamento de fatura|credit card payment|pagamento fatura|gastos cartao de credito)/, 'card_payment'],
  // A card bill paid from the bank account: the bank names the issuer (Bradescard's bills go to "BANCO IBI").
  [/^(pagto eletron cobranca banco (bradescard|ibi)|pagamento efetuado banco ibi)/, 'card_payment'],
  [/^(transferencia mesma titularidade)/, 'own_transfer'],
  [/^(aplicacao|resgate)\b/, 'investment'],
];

/** The categories a person can pick that mean a role (ours, or a source label that means the same). Choosing any other category says the transaction is something else. */
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
export function evidenceRole(labels: string | null | Array<string | null>, description: string): Role | null {
  // The two sources can label one transaction differently (Pierre said card fees, Meu Pluggy said card payment), so every label counts.
  for (const label of Array.isArray(labels) ? labels : [labels]) {
    const found = label ? firstMatch(SOURCE_CATEGORY, normalizeName(label)) : null;
    if (found) return found;
  }
  return firstMatch(DESCRIPTION, normalizeName(description));
}

/** The other party of a transfer, from texts like "Transferência enviada|Maria Souza". Null when the text has none. */
export function counterpartyOf(description: string): string | null {
  const at = description.lastIndexOf('|');
  if (at < 0) return null;
  const name = normalizeName(description.slice(at + 1));
  return name.split(' ').length >= 2 && name.length >= 8 ? name : null;
}

/** Names the owner appears under: the counterparty of every transfer a source itself marked as between the owner's own accounts. */
export function ownerNames(transactions: Array<{ sourceCategory: string | null; labels?: string[]; description: string }>): Set<string> {
  const names = new Set<string>();
  for (const t of transactions) {
    if (evidenceRole(t.labels ?? t.sourceCategory, t.description) !== 'own_transfer') continue;
    const name = counterpartyOf(t.description);
    if (name) names.add(name);
  }
  return names;
}

/** True when the counterparty is the owner. Banks truncate names, so one may be the start of the other. */
export function isOwner(description: string, owners: Set<string>): boolean {
  const name = counterpartyOf(description);
  if (!name) return false;
  for (const owner of owners) if (owner === name || owner.startsWith(name) || name.startsWith(owner)) return true;
  return false;
}

/**
 * The role to use. The user's own choice (a category set on the transaction or a rule) wins in both directions: picking
 * "Pagamento de fatura" makes it a card payment, picking anything else says it is not. An AI category never changes it.
 */
export function roleOf(input: { sourceCategory: string | null; labels?: string[]; description: string; category: string | null; categoryOrigin: 'source' | 'override' | 'rule' | 'ai'; owners?: Set<string> }): Role | null {
  if (input.categoryOrigin === 'override' || input.categoryOrigin === 'rule') {
    // The user may pick our name for it or the sources' ("Credit card payment", "Same person transfer"): both mean the role.
    return (input.category ? (CHOSEN_CATEGORY[normalizeName(input.category)] ?? evidenceRole(input.category, '')) : null) ?? null;
  }
  const found = evidenceRole(input.labels ?? input.sourceCategory, input.description);
  if (found) return found;
  // A transfer to or from the owner's own name moves money between the owner's accounts.
  if (input.owners && input.owners.size > 0 && /transfer|pix|ted/i.test(`${(input.labels ?? [input.sourceCategory]).join(' ')} ${input.description}`) && isOwner(input.description, input.owners)) return 'own_transfer';
  return null;
}
