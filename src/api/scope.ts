import type { CanonicalAccount, CanonicalTransaction, LimitGroup } from '../core/canonical.ts';
import { normalizeName } from '../core/names.ts';
import { mapSourceCategory } from '../ai/source-map.ts';
import { localDay } from '../core/time.ts';
import type { Parties } from '../core/parties.ts';
import { categoryForMcc } from './mcc.ts';
import { counterpartyOf, ownerNames, roleOf, slipBillPayments, type Role } from './roles.ts';
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

/** Key that a category rule matches on. */
const ROLE_CATEGORY: Record<Role, string> = { card_payment: 'Pagamento de fatura', own_transfer: 'Transferência entre minhas contas', investment: 'Investimentos' };

const ROLE_CATEGORY_NAMES = new Set(Object.values(ROLE_CATEGORY));

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
  const all = store.listCanonicalTransactions({ accountId: options.accountId, includeExcluded: options.includeExcluded });
  const { labels: labelsOf, parties: partiesOf } = sourceFacts(store);
  const people = peopleIn(store.listCanonicalTransactions({ includeExcluded: true }), partiesOf);
  const owners = ownerNames(store.listCanonicalTransactions({ includeExcluded: true }).map((t) => ({ sourceCategory: t.category, labels: mergeLabels(t.category, labelsOf.get(t.id)), description: t.description })));
  // A card bill paid by boleto or Pix QR code looks like any transfer; its amount gives it away.
  const cardIds = new Set(store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card').map((a) => a.id));
  const slipPayments = slipBillPayments(
    all.filter((t) => !cardIds.has(t.accountId)).map((t) => ({ id: t.id, day: localDay(t.occurredAt), amount: t.amount, labels: mergeLabels(t.category, labelsOf.get(t.id)), description: t.description })),
    ['pierre', 'pluggy'].flatMap((sourceId) => store.listSourceBills(sourceId)),
  );
  return all
    .filter((t) => ids.has(t.accountId))
    .map((t) => {
      const labels = mergeLabels(t.category, labelsOf.get(t.id));
      const parties = partiesOf.get(t.id);
      const counterparty = counterpartyFor(t.amount, parties, people);
      let category = t.category;
      let origin: CategoryOrigin = 'source';
      const override = overrides.get(t.id);
      const rule = rules.get(ruleKey(t.description));
      const suggested = ai.get(ruleKey(t.description));
      if (override !== undefined) [category, origin] = [override, 'override'];
      else if (rule !== undefined) [category, origin] = [rule, 'rule'];
      else if (labels.some((l) => mapSourceCategory(l) !== null)) category = labels.map((l) => mapSourceCategory(l)).find((c) => c !== null) ?? category;
      // Money sent by Pix or TED to a person (a CPF) is a transfer, whatever the text says. A company could be a shop, so that is left to the label, the merchant code and the AI.
      else if (/^(pix|ted)$/i.test(parties?.operation ?? '') && counterparty?.kind === 'person' && !counterparty.isOwner) category = 'Transferências';
      // The merchant code is a fact, but a source label that already names one of our categories is more specific (delivery apps use restaurant codes).
      else if (categoryForMcc(partiesOf.get(t.id)?.mcc ?? null) !== null) category = categoryForMcc(partiesOf.get(t.id)?.mcc ?? null)!;
      else if (suggested?.status === 'applied' && !ROLE_CATEGORY_NAMES.has(suggested.category)) [category, origin] = [suggested.category, 'ai'];
      const installment = installmentOverrides.get(t.id) ?? t.installment;
      const role = roleOf({ sourceCategory: t.category, labels, description: t.description, category, categoryOrigin: origin, owners, ownerDocument: counterparty?.isOwner === true && /^(pix|ted|transferencia)/i.test(parties?.operation ?? '') }) ?? (slipPayments.has(t.id) && (origin === 'source' || origin === 'ai') ? 'card_payment' : null);
      // What the source or the AI called it must agree with what it is for the arithmetic.
      if (role && (origin === 'source' || origin === 'ai')) category = ROLE_CATEGORY[role];
      return { ...t, installment, category, categoryOrigin: origin, sourceCategory: t.category, sourceLabels: labels, role, counterparty, mcc: parties?.mcc ?? null, operation: parties?.operation ?? null };
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
  for (const sourceId of ['pierre', 'pluggy']) for (const r of store.listSourceTransactions(sourceId)) byRecord.set(`${sourceId}|${r.externalId}`, { label: r.category, parties: r.parties });
  const labels = new Map<string, string[]>();
  const parties = new Map<string, Parties>();
  for (const l of store.listAllTransactionLinks()) {
    const record = byRecord.get(`${l.sourceId}|${l.externalId}`);
    if (!record) continue;
    if (record.label) labels.set(l.transactionId, [...(labels.get(l.transactionId) ?? []), record.label]);
    if (record.parties) {
      const have = parties.get(l.transactionId);
      parties.set(l.transactionId, have ? { operation: have.operation ?? record.parties.operation, mcc: have.mcc ?? record.parties.mcc, payer: have.payer ?? record.parties.payer, receiver: have.receiver ?? record.parties.receiver } : record.parties);
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
