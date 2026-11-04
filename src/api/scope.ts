import type { CanonicalAccount, CanonicalTransaction, LimitGroup } from '../core/canonical.ts';
import { normalizeName } from '../core/names.ts';
import { mapSourceCategory } from '../ai/source-map.ts';
import { localDay } from '../core/time.ts';
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
  // A set-aside pending entry the owner called posted is brought back, so it must be loaded even when excluded ones are not wanted.
  const loaded = store.listCanonicalTransactions({ accountId: options.accountId, includeExcluded: true });
  const all = options.includeExcluded ? loaded : loaded.filter((t) => !t.excluded || (t.state === 'stale_pending' && txOverrides.get(t.id)?.status === 'posted'));
  const { labels: labelsOf, parties: partiesOf } = sourceFacts(store);
  const engineRules = sortRules(store.listRules());
  const regexes = new Map<string, RegExp | null>();
  const institutionOf = new Map(store.listCanonicalAccounts().map((a) => [a.id, a.institution]));
  const people = peopleIn(store.listCanonicalTransactions({ includeExcluded: true }), partiesOf);
  const owners = ownerNames(store.listCanonicalTransactions({ includeExcluded: true }).map((t) => ({ sourceCategory: t.category, labels: mergeLabels(t.category, labelsOf.get(t.id)), description: t.description })));
  // A card bill paid by boleto or Pix QR code looks like any transfer; its amount gives it away.
  const cardIds = new Set(store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card').map((a) => a.id));
  const slipPayments = slipBillPayments(
    // Every live bank transaction, whatever the view asked for, so the same boleto is matched the same way on every screen.
    store.listCanonicalTransactions({ includeExcluded: false }).filter((t) => !cardIds.has(t.accountId)).map((t) => ({ id: t.id, day: localDay(t.occurredAt), amount: t.amount, labels: mergeLabels(t.category, labelsOf.get(t.id)), description: t.description })),
    store.listSourceIds().flatMap((sourceId) => store.listSourceBills(sourceId)),
  );
  const rows: EffectiveTransaction[] = all
    .filter((t) => ids.has(t.accountId))
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
      else if (labels.some((l) => mapSourceCategory(l) !== null)) category = labels.map((l) => mapSourceCategory(l)).find((c) => c !== null) ?? category;
      // Money sent by Pix or TED to a person (a CPF) is a transfer, whatever the text says. A company could be a shop, so that is left to the label, the merchant code and the AI.
      else if (/^(pix|ted)$/i.test(parties?.operation ?? '') && counterparty?.kind === 'person' && !counterparty.isOwner) category = 'Transferências';
      // The merchant code is a fact, but a source label that already names one of our categories is more specific (delivery apps use restaurant codes).
      else if (categoryForMcc(partiesOf.get(t.id)?.mcc ?? null) !== null) category = categoryForMcc(partiesOf.get(t.id)?.mcc ?? null)!;
      else if (suggested?.status === 'applied' && !ROLE_CATEGORY_NAMES.has(suggested.category)) [category, origin] = [suggested.category, 'ai'];
      const installment = installmentOverrides.get(t.id) ?? t.installment;
      // A condition rule matches on text and amounts, so on its own it must not turn a card payment into spending. Only a rule that names a role category sets the role.
      const roleOrigin: CategoryOrigin = engineHit && !ROLE_CATEGORY_NAMES.has(category ?? '') ? 'ai' : origin;
      const role = roleOf({ sourceCategory: t.category, labels, description: t.description, category, categoryOrigin: roleOrigin, owners, ownerDocument: counterparty?.isOwner === true && /^(pix|ted|transferencia)/i.test(parties?.operation ?? '') }) ?? (slipPayments.has(t.id) && (origin === 'source' || origin === 'ai') ? 'card_payment' : null);
      // What the source or the AI called it must agree with what it is for the arithmetic.
      if (role && (origin === 'source' || origin === 'ai' || engineHit)) category = ROLE_CATEGORY[role];
      // The owner renamed or merged this category: the new name shows everywhere. A card payment, a move between your accounts and an investment keep their fixed names.
      if (category !== null && !ROLE_CATEGORY_NAMES.has(category)) category = resolveAlias(aliases, category);
      // The owner's word about the status wins over the source's. Calling a set-aside pending entry posted brings it back into the totals.
      const word = txOverrides.get(t.id);
      // A payment of the bill carries the id of the bill it pays; it stays with its date.
      const bankBill = role === 'card_payment' ? null : bankBillOf(parties, billMonth);
      const status = word?.status ?? t.status;
      const revived = word?.status === 'posted' && t.state === 'stale_pending';
      return { ...t, status, state: revived ? 'single_source' : t.state, excluded: revived ? false : t.excluded, installment, category, categoryOrigin: origin, sourceCategory: t.category, sourceLabels: labels, role, counterparty, mcc: parties?.mcc ?? null, operation: parties?.operation ?? null, foreign: parties?.foreign ?? null, reversal: null, billCycle: word?.cycleKey ?? bankBill, billByBank: word?.cycleKey == null && bankBill !== null, statusByUser: word?.status != null, title: titleOf({ description: t.description, amount: t.amount, role, operation: parties?.operation ?? null, counterparty }) };
    });
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
