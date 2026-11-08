import type { CanonicalAccount, CanonicalTransaction, LimitGroup } from '../core/canonical.ts';
import { normalizeName } from '../core/names.ts';
import { mapSourceCategory } from '../ai/source-map.ts';
import { localDay } from '../core/time.ts';
import { dayNumber } from '../core/dates.ts';
import type { ForeignAmount, Parties } from '../core/parties.ts';
import { categoryForMcc } from './mcc.ts';
import { pairReversals, type Reversal } from './reversals.ts';
import { categoryFromRules, sortRules, type RuleSubject } from './rules-engine.ts';
import { titleOf } from '../core/title.ts';
import { merchantOf } from '../core/merchant.ts';
import { counterpartyOf, evidenceRole, ownerNames, roleOf, slipBillPayments, type Role } from './roles.ts';
import type { Store } from '../store/store.ts';

export interface ViewOptions {
  /** Include the accounts the user chose to hide. Off by default, so every total ignores them. */
  includeHidden?: boolean;
}

export type CategoryOrigin = 'source' | 'override' | 'rule' | 'ai';

/** A canonical transaction with the category the user sees: a manual choice, then a rule, then what the source said. */
export interface EffectiveTransaction extends CanonicalTransaction {
  categoryOrigin: CategoryOrigin;
  sourceCategory: string | null;
  /** Every label the sources gave this transaction, the one in `sourceCategory` first. */
  sourceLabels: string[];
  /** Card payment, own transfer or investment: not spending or income. Does not depend on the category shown. */
  role: Role | null;
  /** The other side of a Pix, TED or boleto: who got the money (for an outflow) or who sent it. */
  counterparty: Counterparty | null;
  /** Merchant category code of a card purchase, when the source gives it. */
  mcc: string | null;
  /** The kind of operation the source reports (PIX, TED, BOLETO ...), when it does. */
  operation: string | null;
  /** The original amount of a purchase made in another currency (the transaction amount is in reais). */
  foreign: ForeignAmount | null;
  /** The standard name shown on screen ("Pix enviado · Maria", "Pagamento de fatura", "Uber"). `description` stays what the bank wrote. */
  title: string;
  /** Card bill (due month, YYYY-MM) the transaction belongs to when it is not simply the one its date falls in: the owner moved it, or the issuer placed it. */
  billCycle: string | null;
  /** The purchase and the refund that returned it are one entry: this says which side this is and the other one. */
  reversal: Reversal | null;
  /** `billCycle` comes from the issuer (the bill id or its forecast), not from the owner. */
  billByBank: boolean;
  /** The owner set the status by hand. */
  statusByUser: boolean;
  /** The source still says pending, but the issuer already published the bill this card charge is on, so it shows as posted. */
  statusByBill: boolean;
}

export interface Counterparty {
  /** Name the source gave, or the name other transactions with the same document are written under. */
  name: string | null;
  /** Last four digits of the CPF or CNPJ. */
  last4: string | null;
  /** Person (CPF) or company (CNPJ), when the document says. */
  kind: 'person' | 'company' | null;
  /** True when the document is the owner's own. */
  isOwner: boolean;
}

/** The name a category goes by now: follows renames and merges, with a bound so a loop cannot hang a screen. */
export function resolveAlias(aliases: Map<string, string>, name: string): string {
  let current = name;
  for (let i = 0; i < 6; i++) {
    const next = aliases.get(current);
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

/** Key that a category rule matches on. */
const ROLE_CATEGORY: Record<Role, string> = { card_payment: 'Pagamento de fatura', own_transfer: 'Transferência entre minhas contas', investment: 'Investimentos' };

const ROLE_CATEGORY_NAMES = new Set(Object.values(ROLE_CATEGORY));

/** What a rule sees of a transaction. */
export function ruleSubjectOf(t: { description: string; counterparty: { name: string | null } | null; sourceLabels: string[]; accountId: string; operation: string | null; mcc: string | null; status: 'pending' | 'posted'; amount: number; occurredAt: string; role: string | null }, institution: string): RuleSubject {
  return {
    description: t.description,
    merchant: merchantOf(t),
    counterparty: t.counterparty?.name ?? '',
    sourceLabel: t.sourceLabels.join(' | '),
    institution,
    account: t.accountId,
    operation: t.operation ?? '',
    mcc: t.mcc ?? '',
    status: t.status,
    direction: t.amount < 0 ? 'out' : 'in',
    amount: t.amount,
    date: localDay(t.occurredAt),
    role: t.role ?? '',
  };
}

export function ruleKey(description: string): string {
  // "Store 03/12" and "Store 04/12" are the same shop, so the installment number is not part of the key.
  return normalizeName(description.replace(/\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/, ''));
}

export function visibleAccounts(store: Store, options: ViewOptions = {}): CanonicalAccount[] {
  const all = store.listCanonicalAccounts();
  if (options.includeHidden) return all;
  const hidden = store.listHiddenAccountIds();
  return all.filter((a) => !hidden.has(a.id));
}

/** Limit groups with their hidden members removed. A group with no visible member disappears. */
export function visibleLimitGroups(store: Store, accounts: CanonicalAccount[]): LimitGroup[] {
  const ids = new Set(accounts.map((a) => a.id));
  return store
    .listLimitGroups()
    .map((g) => ({ ...g, memberIds: g.memberIds.filter((id) => ids.has(id)) }))
    .filter((g) => g.memberIds.length > 0);
}

/** Per card, the due months of the bills the issuers published and the latest closing day among them. A published bill has closed. */
function publishedBills(store: Store): Map<string, { months: Set<string>; lastClosing: string }> {
  const accountOf = new Map<string, string>();
  for (const a of store.listCanonicalAccounts()) if (a.kind === 'credit_card') for (const r of a.refs) if (r.role === 'member') accountOf.set(`${r.sourceId}|${r.externalId}`, a.id);
  const result = new Map<string, { months: Set<string>; lastClosing: string }>();
  for (const sourceId of store.listSourceIds()) {
    for (const b of store.listSourceBills(sourceId)) {
      const accountId = accountOf.get(`${sourceId}|${b.accountExternalId}`);
      if (accountId === undefined || b.closingDate === null) continue;
      const entry = result.get(accountId) ?? { months: new Set<string>(), lastClosing: b.closingDate };
      entry.months.add(b.dueDate.slice(0, 7));
      if (b.closingDate > entry.lastClosing) entry.lastClosing = b.closingDate;
      result.set(accountId, entry);
    }
  }
  return result;
}

/** The bill (due month) the issuer put a charge on: its bill when it has one, otherwise the month it expects. Null when it said nothing. */
function bankBillOf(parties: Parties | undefined, billMonth: Map<string, string>): string | null {
  return (parties?.billId ? billMonth.get(parties.billId) : undefined) ?? parties?.billForecast ?? null;
}

export function effectiveTransactions(
  store: Store,
  options: ViewOptions & { accountId?: string; includeExcluded?: boolean } = {},
  accounts: CanonicalAccount[] = visibleAccounts(store, options),
): EffectiveTransaction[] {
  const ids = new Set(accounts.map((a) => a.id));
  const overrides = store.listCategoryOverrides();
  const rules = store.listCategoryRules();
  const ai = store.listAiCategories();
  const installmentOverrides = store.listInstallmentOverrides();
  const txOverrides = store.listTransactionOverrides();
  const aliases = store.listCategoryAliases();
  const billMonth = new Map<string, string>();
  for (const sourceId of store.listSourceIds()) for (const b of store.listSourceBills(sourceId)) billMonth.set(b.externalId, b.dueDate.slice(0, 7));
  const institutionOf = new Map(store.listCanonicalAccounts().map((a) => [a.id, a.institution]));
  const published = publishedBills(store);
  // A set-aside pending entry the owner called posted is brought back, so it must be loaded even when excluded ones are not wanted.
  // Every account is loaded, also when one is asked for, so the other side of a move between accounts is found the same way on every screen.
  const loaded = store.listCanonicalTransactions({ includeExcluded: true });
  const all = options.includeExcluded ? loaded : loaded.filter((t) => !t.excluded || (t.state === 'stale_pending' && txOverrides.get(t.id)?.status === 'posted'));
  const { labels: labelsOf, parties: partiesOf } = sourceFacts(store);
  const engineRules = sortRules(store.listRules());
  const regexes = new Map<string, RegExp | null>();
  const people = peopleIn(store.listCanonicalTransactions({ includeExcluded: true }), partiesOf);
  const owners = ownerNames(store.listCanonicalTransactions({ includeExcluded: true }).map((t) => ({ sourceCategory: t.category, labels: mergeLabels(t.category, labelsOf.get(t.id)), description: t.description })));
  // A card bill paid by boleto or Pix QR code looks like any transfer; its amount gives it away.
  const cardIds = new Set(store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card').map((a) => a.id));
  const slipPayments = slipBillPayments(
    // Every live bank transaction, whatever the view asked for, so the same boleto is matched the same way on every screen.
    store.listCanonicalTransactions({ includeExcluded: false }).filter((t) => !cardIds.has(t.accountId)).map((t) => ({ id: t.id, day: localDay(t.occurredAt), amount: t.amount, labels: mergeLabels(t.category, labelsOf.get(t.id)), description: t.description })),
    store.listSourceIds().flatMap((sourceId) => store.listSourceBills(sourceId)),
  );
  // Rows are built for every account, so the other side of a move to a hidden account is found the same way on every screen.
  const built: EffectiveTransaction[] = all
    .map((t) => {
      const labels = mergeLabels(t.category, labelsOf.get(t.id));
      const parties = partiesOf.get(t.id);
      const counterparty = counterpartyFor(t.amount, parties, people);
      let category = t.category;
      let origin: CategoryOrigin = 'source';
      let engineHit: ReturnType<typeof categoryFromRules> = null;
      const override = overrides.get(t.id);
      const rule = rules.get(ruleKey(t.description));
      const suggested = ai.get(ruleKey(t.description));
      if (override !== undefined) [category, origin] = [override, 'override'];
      else if (rule !== undefined) [category, origin] = [rule, 'rule'];
      else if (engineRules.length > 0 && (engineHit = categoryFromRules(ruleSubjectOf({ ...t, counterparty, sourceLabels: labels, operation: parties?.operation ?? null, mcc: parties?.mcc ?? null, role: evidenceRole(labels, t.description) }, institutionOf.get(t.accountId) ?? ''), engineRules, regexes))) [category, origin] = [engineHit.category, 'rule'];
      // A tax slip is a tax whatever the source called it (one source labels federal tax slips as fixed income).
      else if (TAX_SLIP.test(normalizeName(t.description))) category = 'Impostos e taxas';
      else if (labels.some((l) => mapSourceCategory(l) !== null)) category = labels.map((l) => mapSourceCategory(l)).find((c) => c !== null) ?? category;
      // Money sent by Pix or TED to a person (a CPF) is a transfer, whatever the text says. A company could be a shop, so that is left to the label, the merchant code and the AI.
      else if (/^(pix|ted)$/i.test(parties?.operation ?? '') && counterparty?.kind === 'person' && !counterparty.isOwner) category = 'Transferências';
      // The merchant code is a fact, but a source label that already names one of our categories is more specific (delivery apps use restaurant codes).
      else if (categoryForMcc(partiesOf.get(t.id)?.mcc ?? null) !== null) category = categoryForMcc(partiesOf.get(t.id)?.mcc ?? null)!;
      else if (suggested?.status === 'applied' && !ROLE_CATEGORY_NAMES.has(suggested.category)) [category, origin] = [suggested.category, 'ai'];
      const installment = installmentOverrides.get(t.id) ?? t.installment;
      // A condition rule matches on text and amounts, so on its own it must not turn a card payment into spending. Only a rule that names a role category sets the role.
      const roleOrigin: CategoryOrigin = engineHit && !ROLE_CATEGORY_NAMES.has(category ?? '') ? 'ai' : origin;
      // The other side's document is the owner's on a Pix, a TED or anything the source calls a transfer (some come as "OUTROS"). A yield is income even when the source names the owner as payer.
      const operation = parties?.operation ?? '';
      const ownerDocument = counterparty?.isOwner === true && (/^(pix|ted|transferencia)/i.test(operation) || (!/^rendimento/i.test(operation) && /transfer/i.test(`${labels.join(' ')} ${t.description}`)));
      const role = roleOf({ sourceCategory: t.category, labels, description: t.description, category, categoryOrigin: roleOrigin, owners, ownerDocument, card: cardIds.has(t.accountId) }) ?? (slipPayments.has(t.id) && (origin === 'source' || origin === 'ai') ? 'card_payment' : null);
      // What the source or the AI called it must agree with what it is for the arithmetic.
      if (role && (origin === 'source' || origin === 'ai' || engineHit)) category = ROLE_CATEGORY[role];
      // A source label that names a role ("Fixed income" on a tax slip, "Investments" on a card purchase) without being one says nothing true: the owner picks.
      else if (!role && origin === 'source' && category !== null && ROLE_CATEGORY_NAMES.has(category)) category = null;
      // The owner renamed or merged this category: the new name shows everywhere. A card payment, a move between your accounts and an investment keep their fixed names.
      if (category !== null && !ROLE_CATEGORY_NAMES.has(category)) category = resolveAlias(aliases, category);
      // The owner's word about the status wins over the source's. Calling a set-aside pending entry posted brings it back into the totals.
      const word = txOverrides.get(t.id);
      // A payment of the bill carries the id of the bill it pays; it stays with its date.
      const bankBill = role === 'card_payment' ? null : bankBillOf(parties, billMonth);
      // Meu Pluggy keeps a card purchase pending until the issuer posts it, which can be long after the bill that holds it closed.
      // Once that bill is published the purchase is part of it, whatever the source still says.
      const billCycle = word?.cycleKey ?? bankBill;
      const bill = published.get(t.accountId);
      const byBill = word?.status == null && t.status === 'pending' && role === null && bill !== undefined && (billCycle !== null ? bill.months.has(billCycle) : localDay(t.occurredAt) <= bill.lastClosing);
      const status = word?.status ?? (byBill ? 'posted' : t.status);
      const revived = word?.status === 'posted' && t.state === 'stale_pending';
      return { ...t, status, state: revived ? 'single_source' : t.state, excluded: revived ? false : t.excluded, installment, category, categoryOrigin: origin, sourceCategory: t.category, sourceLabels: labels, role, counterparty, mcc: parties?.mcc ?? null, operation: parties?.operation ?? null, foreign: parties?.foreign ?? null, reversal: null, billCycle, billByBank: word?.cycleKey == null && bankBill !== null, statusByUser: word?.status != null, statusByBill: byBill, title: titleOf({ description: t.description, amount: t.amount, role, operation: parties?.operation ?? null, counterparty }) };
    });
  const mirrored = ownMirrors(built, cardIds);
  const rows = built
    .filter((t) => ids.has(t.accountId) && (options.accountId === undefined || t.accountId === options.accountId))
    .map((t) => (mirrored.has(t.id) ? { ...t, role: 'own_transfer' as const, category: ROLE_CATEGORY.own_transfer, title: titleOf({ description: t.description, amount: t.amount, role: 'own_transfer', operation: t.operation, counterparty: t.counterparty }) } : t));
  // A refund and the purchase it returned are one entry. The refund takes the category of the purchase (unless the owner chose its own),
  // so the category's total is net of it instead of the credit landing in "Estorno" or in income.
  const pairs = pairReversals(rows, store.listReversalLinks());
  if (pairs.size === 0) return rows;
  const byId = new Map(rows.map((t) => [t.id, t]));
  return rows.map((t) => {
    const reversal = pairs.get(t.id);
    if (!reversal) return t;
    const charge = reversal.side === 'refund' ? byId.get(reversal.otherId) : undefined;
    return charge && t.categoryOrigin !== 'override' && charge.category !== null ? { ...t, reversal, category: charge.category } : { ...t, reversal };
  });
}

/** Federal tax slips (DARF, the Simples Nacional DAS). */
const TAX_SLIP = /\bdarf\b|\bdas simples\b|receita fed/;

/** The two sides of a move between own accounts can be dated this many days apart. */
const MIRROR_DAYS = 2;

/**
 * Bank Pix and transfers with no role that are the other side of a move the source did mark as between the owner's
 * accounts. Some banks write the owner's name cut short ("REM <name> dd/mm") or no name at all, and a cut name can also be
 * the start of a relative's name, so the name proves nothing: the mirror does. A mirror is a marked move on another bank
 * account with the opposite sign and the same amount, at most two days apart. The closest pairs are matched first, over all
 * accounts at once (by days apart, then by time), and each side is used once, so a payment to someone else of the same amount
 * does not take a mirror from its real other side. Marked moves pair with each other before they pair with anything else, and a
 * marked move whose opposite sits on its own account (a pair of one account) has its other side there and takes no mirror.
 * A category the owner chose (by hand or by a rule) is never changed.
 */
export function ownMirrors(rows: EffectiveTransaction[], cardIds: Set<string>): Set<string> {
  const dayOf = (t: EffectiveTransaction) => dayNumber(localDay(t.occurredAt));
  const bank = rows.filter((t) => !t.excluded && t.amount !== 0 && !cardIds.has(t.accountId));
  const marked = bank.filter((t) => t.role === 'own_transfer');
  const candidates = bank.filter((t) => t.role === null && (t.categoryOrigin === 'source' || t.categoryOrigin === 'ai') && (/^(pix|ted)$/i.test(t.operation ?? '') || /transfer/i.test(`${t.sourceLabels.join(' ')} ${t.description}`)));
  const markedBy = new Map<number, EffectiveTransaction[]>();
  for (const t of marked) markedBy.set(Math.abs(t.amount), [...(markedBy.get(Math.abs(t.amount)) ?? []), t]);
  const used = new Set<string>();
  // Every pair of a row from `side` and a marked move with the opposite sign and amount, closest first: days apart, then time apart.
  const match = (side: EffectiveTransaction[], sameAccount: boolean): EffectiveTransaction[] => {
    const pairs: Array<{ a: EffectiveTransaction; b: EffectiveTransaction; days: number; ms: number }> = [];
    for (const a of side) {
      for (const b of markedBy.get(Math.abs(a.amount)) ?? []) {
        const days = Math.abs(dayOf(a) - dayOf(b));
        if (a.id !== b.id && b.amount === -a.amount && (a.accountId === b.accountId) === sameAccount && days <= MIRROR_DAYS) pairs.push({ a, b, days, ms: Math.abs(Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) });
      }
    }
    pairs.sort((x, y) => x.days - y.days || x.ms - y.ms || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id));
    const taken: EffectiveTransaction[] = [];
    for (const { a, b } of pairs) {
      if (used.has(a.id) || used.has(b.id)) continue;
      used.add(a.id);
      used.add(b.id);
      taken.push(a);
    }
    return taken;
  };
  match(marked, false);
  match(marked, true);
  return new Set(match(candidates, false).map((t) => t.id));
}

/** Hash of the other side's document per transaction, for comparing two records without exposing it on screen. */
export function counterpartyHashes(store: Store): Map<string, string> {
  const result = new Map<string, string>();
  const { parties } = sourceFacts(store);
  for (const t of store.listCanonicalTransactions({ includeExcluded: true })) {
    const p = parties.get(t.id);
    const other = t.amount < 0 ? p?.receiver : p?.payer;
    if (other?.hash) result.set(t.id, other.hash);
  }
  return result;
}

/** What the source records behind each canonical transaction say: their labels, and who paid and who received. */
function sourceFacts(store: Store): { labels: Map<string, string[]>; parties: Map<string, Parties> } {
  const byRecord = new Map<string, { label: string | null; parties: Parties | undefined }>();
  for (const sourceId of store.listSourceIds()) for (const r of store.listSourceTransactions(sourceId)) byRecord.set(`${sourceId}|${r.externalId}`, { label: r.category, parties: r.parties });
  const labels = new Map<string, string[]>();
  const parties = new Map<string, Parties>();
  for (const l of store.listAllTransactionLinks()) {
    const record = byRecord.get(`${l.sourceId}|${l.externalId}`);
    if (!record) continue;
    if (record.label) labels.set(l.transactionId, [...(labels.get(l.transactionId) ?? []), record.label]);
    if (record.parties) {
      const have = parties.get(l.transactionId);
      parties.set(l.transactionId, have ? { operation: have.operation ?? record.parties.operation, mcc: have.mcc ?? record.parties.mcc, payer: have.payer ?? record.parties.payer, receiver: have.receiver ?? record.parties.receiver, foreign: have.foreign ?? record.parties.foreign ?? null, billId: have.billId ?? record.parties.billId ?? null, billForecast: have.billForecast ?? record.parties.billForecast ?? null } : record.parties);
    }
  }
  return { labels, parties };
}

/** Who the owner is and what people are called, learned from the transactions themselves. */
interface People {
  ownerHashes: Set<string>;
  nameByHash: Map<string, string>;
}

const MIN_OWNER_TRANSACTIONS = 3;

function peopleIn(transactions: Array<{ id: string; amount: number; description: string }>, partiesOf: Map<string, Parties>): People {
  // The owner is on every one of their own outflows as payer and on every inflow as receiver.
  const payers = new Map<string, number>();
  const receivers = new Map<string, number>();
  const names = new Map<string, Map<string, number>>();
  for (const t of transactions) {
    const parties = partiesOf.get(t.id);
    if (!parties) continue;
    const mine = t.amount < 0 ? parties.payer : parties.receiver;
    if (mine?.hash) (t.amount < 0 ? payers : receivers).set(mine.hash, ((t.amount < 0 ? payers : receivers).get(mine.hash) ?? 0) + 1);
    const other = t.amount < 0 ? parties.receiver : parties.payer;
    const written = t.description.includes('|') ? t.description.slice(t.description.lastIndexOf('|') + 1).trim() : null;
    const name = other?.name ?? (written && counterpartyOf(t.description) ? written : null);
    if (other?.hash && name) {
      const seen = names.get(other.hash) ?? new Map<string, number>();
      seen.set(name, (seen.get(name) ?? 0) + 1);
      names.set(other.hash, seen);
    }
  }
  const top = (counts: Map<string, number>) => [...counts].filter(([, n]) => n >= MIN_OWNER_TRANSACTIONS).sort((a, b) => b[1] - a[1])[0]?.[0];
  const ownerHashes = new Set([top(payers), top(receivers)].filter((h): h is string => h !== undefined));
  const nameByHash = new Map([...names].map(([hash, seen]) => [hash, [...seen].sort((a, b) => b[1] - a[1])[0]![0]]));
  return { ownerHashes, nameByHash };
}

function counterpartyFor(amount: number, parties: Parties | undefined, people: People): Counterparty | null {
  const other = amount < 0 ? parties?.receiver : parties?.payer;
  if (!other || (other.hash === null && other.name === null)) return null;
  return { name: other.name ?? (other.hash ? (people.nameByHash.get(other.hash) ?? null) : null), last4: other.last4, kind: other.kind, isOwner: other.hash !== null && people.ownerHashes.has(other.hash) };
}

function mergeLabels(primary: string | null, others: string[] | undefined): string[] {
  return [...new Set([...(primary ? [primary] : []), ...(others ?? [])])];
}
