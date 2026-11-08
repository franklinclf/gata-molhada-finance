/**
 * Short display names for accounts and cards. The bank sends its own text for the account name: it often repeats the
 * institution ("Itaú Itaú Click"), ends with a legal suffix ("S.A. - Instituição de Pagamento") or is written in capitals.
 */

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const CONNECTORS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
/** Words that only say what kind of company the name belongs to. */
const LEGAL = /^(s\.?a\.?|s\/a|ltda\.?|-|–|—)$/;

function dropLegalSuffix(words: string[]): string[] {
  const out = [...words];
  for (;;) {
    const last = fold(out[out.length - 1] ?? '');
    const lastThree = out.slice(-3).map(fold).join(' ');
    if (LEGAL.test(last)) out.pop();
    else if (/^institui[cç][aã]o de pagamentos?$/.test(lastThree)) out.splice(-3);
    else if (out.length > 1 && /^pagamentos?$/.test(last)) out.pop();
    else return out;
  }
}

function titleCase(words: string[]): string[] {
  const letters = words.join('');
  if (letters !== letters.toUpperCase() || letters === letters.toLowerCase()) return words;
  // Short capitals stay as they are ("MC", "BB"); the rest is written as a name.
  return words.map((w, i) => {
    if (i > 0 && CONNECTORS.has(w.toLowerCase())) return w.toLowerCase();
    return w.length <= 2 ? w : w.charAt(0) + w.slice(1).toLowerCase();
  });
}

/** What the bank's name says besides the institution and the legal suffix, "" when nothing is left (a generic "Banco X"). */
export function productName(institution: string, name: string): string {
  let words = dropLegalSuffix(name.trim().split(/\s+/).filter(Boolean));
  const bank = fold(institution).split(/\s+/).filter(Boolean);
  const starts = (list: string[]) => bank.length > 0 && list.length >= bank.length && bank.every((b, i) => fold(list[i]!) === b);
  if (words.length > 1 && fold(words[0]!) === 'banco' && starts(words.slice(1))) words = words.slice(1);
  if (starts(words)) words = words.slice(bank.length);
  // "Nu Pagamentos" for Nubank: the name is the start of the institution's.
  else if (words.length === 1 && words[0]!.length >= 2 && bank.join('').startsWith(fold(words[0]!))) words = [];
  return titleCase(words).join(' ');
}

const GENERIC: Record<string, string> = { checking: 'Conta corrente', savings: 'Poupança' };

/** The account without its institution, for lists that already show the institution: the product name, or "Conta corrente" / "Poupança". */
export function accountName(institution: string, name: string, kind?: string): string {
  return productName(institution, name) || GENERIC[kind ?? ''] || 'Conta';
}

/** The card with its institution once ("Bradesco Visa Signature"). The last four digits are left to the caller, which shows them apart so a cut name does not hide them. */
export function cardName(institution: string, name: string): string {
  return [institution, productName(institution, name)].filter(Boolean).join(' ');
}

/** A net worth line. The API writes a bank account as "Institution · bank name" (and may end it with "(saldo negativo)"); other lines stay as they are. */
export function netWorthLabel(name: string, kind: string): string {
  if (kind !== 'bank') return name;
  const note = name.endsWith(' (saldo negativo)') ? ' (saldo negativo)' : '';
  const [institution, ...rest] = name.slice(0, name.length - note.length).split(' · ');
  if (rest.length === 0) return name;
  const product = productName(institution!, rest.join(' · '));
  return (product ? `${institution} · ${product}` : institution!) + note;
}
