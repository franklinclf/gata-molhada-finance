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
  // Itaú shows a card bill paid with the account balance as "PAGAMENTO COM SALDO", a credit on the card.
  [/^(pagamento recebido|pagto por deb|pagamento de fatura|credit card payment|pagamento fatura|gastos cartao de credito|pagamento com saldo)/, 'card_payment'],
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
export function roleOf(input: { sourceCategory: string | null; labels?: string[]; description: string; category: string | null; categoryOrigin: 'source' | 'override' | 'rule' | 'ai'; owners?: Set<string>; ownerDocument?: boolean }): Role | null {
  if (input.categoryOrigin === 'override' || input.categoryOrigin === 'rule') {
    // The user may pick our name for it or the sources' ("Credit card payment", "Same person transfer"): both mean the role.
    return (input.category ? (CHOSEN_CATEGORY[normalizeName(input.category)] ?? evidenceRole(input.category, '')) : null) ?? null;
  }
  const found = evidenceRole(input.labels ?? input.sourceCategory, input.description);
  if (found) return found;
  // The other side's document is the owner's own.
  if (input.ownerDocument) return 'own_transfer';
  // A transfer to or from the owner's own name moves money between the owner's accounts.
  if (input.owners && input.owners.size > 0 && /transfer|pix|ted/i.test(`${(input.labels ?? [input.sourceCategory]).join(' ')} ${input.description}`) && isOwner(input.description, input.owners)) return 'own_transfer';
  return null;
}

const SLIP_TEXT = /boleto|bank slip|pix qr code|pagto antec|recebto pagto/;
const SLIP_WINDOW_BEFORE_DAYS = 45;
const SLIP_WINDOW_AFTER_DAYS = 30;

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) / 86_400_000);

/**
 * Card bills paid with a boleto or a Pix QR code. The bank names the payee's collection system, not the card, so the text
 * alone says nothing. The amount does: an outflow that looks like a slip payment and equals a bill total to the cent,
 * close to that bill's due date, is that bill's payment. Each bill is used once.
 */
export function slipBillPayments(
  outflows: Array<{ id: string; day: string; amount: number; labels: string[]; description: string }>,
  bills: Array<{ dueDate: string; total: number }>,
): Set<string> {
  const free = bills.filter((b) => b.total > 0).map((b) => ({ due: dayNumber(b.dueDate), total: b.total }));
  const found = new Set<string>();
  const candidates = outflows
    .filter((t) => t.amount < 0 && SLIP_TEXT.test(normalizeName([...t.labels, t.description].join(' '))))
    .sort((a, b) => a.day.localeCompare(b.day));
  for (const t of candidates) {
    const day = dayNumber(t.day);
    const at = free.findIndex((b) => b.total === -t.amount && day >= b.due - SLIP_WINDOW_BEFORE_DAYS && day <= b.due + SLIP_WINDOW_AFTER_DAYS);
    if (at < 0) continue;
    free.splice(at, 1);
    found.add(t.id);
  }
  return found;
}
