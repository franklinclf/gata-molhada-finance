import { formatBRL } from '../core/money.ts';
import { runReconciliation } from '../reconcile/run.ts';
import { localDay, localMonth } from '../core/time.ts';
import { categoryParents } from '../api/category-groups.ts';
import { resolveBudget, setBudget } from '../api/budgets.ts';
import { deleteIncome, saveIncome } from '../api/income.ts';
import { isManualId, manualNumber } from '../api/manual.ts';
import { bulkEdit, dismissSuggestion, joinTransactions, listCategories, setReversal } from '../api/mutations.ts';
import { createRule, deleteRule, previewRule } from '../api/rules.ts';
import { effectiveTransactions } from '../api/scope.ts';
import type { ChangeStatus, ChatChange, ChatMessage, IncomeItem, Store } from '../store/store.ts';
import { matchingRows, readFilter, RefBook, ToolError, type TxTarget } from './analyst-tools.ts';
import type { Rule } from '../api/rules-engine.ts';

/** Above this many transactions a change waits for the owner's tap. */
export const CONFIRM_ABOVE = 20;
/** A change that waits for a tap is forgotten after this long. */
export const PENDING_MINUTES = 30;
/** What `bulkEdit` takes in one call. */
const MAX_TARGETS = 500;

/** What a write tool gets besides the model's arguments. */
export interface ActionContext {
  refs: RefBook;
  /** The arguments were stored by this code (a pending change planned again), so they may hold the records that the model's handles stood for. */
  stored?: boolean;
}

export interface Plan {
  /** What changes, in words for the owner. */
  label: string;
  /** How many transactions (or rules, budgets, income items) it touches. */
  count: number;
  destructive: boolean;
  /** The old values can be put back exactly. */
  undoable: boolean;
  /** The arguments with the model's handles replaced by the records they stood for, to plan this change again later. */
  stored: Record<string, unknown>;
  /** Writes through the existing mutation functions. The caller runs it inside `store.transaction`. */
  apply: () => { before: unknown; after: unknown };
}

export type UndoOutcome = 'ok' | 'conflict';

export interface WriteTool {
  name: string;
  /** One line for the prompt, with the arguments. */
  help: string;
  plan: (store: Store, now: Date, args: Record<string, unknown>, ctx: ActionContext) => Plan;
  /** Puts the old values back, unless the data is no longer as the change left it. */
  undo: (store: Store, now: Date, change: ChatChange) => UndoOutcome;
}

// ---------- small helpers ----------

const money = (cents: number): string => formatBRL(cents).replace(/\u00a0/g, ' ');
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const folded = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const monthLabel = (month: string): string => `${month.slice(5)}/${month.slice(0, 4)}`;
/** Equal values, whatever the order of the keys. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : (value ?? null);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function text(args: Record<string, unknown>, key: string, max = 80): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ToolError(`${key} must be text`);
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

/** An amount typed in reais, as cents. */
function cents(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ToolError(`${key} must be a number of reais above zero`);
  return Math.round(value * 100);
}

const rebuild = (store: Store, now: Date): void => void runReconciliation(store, { now: () => now });

/** The category the owner meant, with the spelling the app uses. Only categories that exist are accepted, so a typo does not create one. */
function existingCategory(store: Store, name: string): string {
  const wanted = folded(name);
  const found = listCategories(store).find((c) => folded(c.name) === wanted);
  if (!found) throw new ToolError(`there is no category called "${name}"; use the categories tool for the names`);
  return found.name;
}

/** The group the owner meant, with the spelling the app uses. */
function existingGroup(store: Store, name: string): string {
  const wanted = folded(name);
  const found = [...new Set(categoryParents(store).values())].find((g) => folded(g) === wanted);
  if (!found) throw new ToolError(`there is no group called "${name}"`);
  return found;
}

function failed(result: { ok: boolean; error?: string }): void {
  if (!result.ok) throw new ToolError(result.error ?? 'the change was refused');
}

// ---------- transactions: choosing them, and reading what the owner chose on each ----------

interface Picked {
  id: string;
  category: string | null;
  state: string;
  amount: number;
}

interface RecordRef {
  sourceId: string;
  externalId: string;
}

/** The choices on one source record. A transaction typed in by hand is its own record (source "manual"). */
interface RecordState extends RecordRef {
  category: string | null;
  ignored: boolean;
}

const recordsOf = (store: Store, id: string): RecordRef[] =>
  isManualId(id) ? [{ sourceId: 'manual', externalId: id }] : store.listTransactionLinks(id).map((l) => ({ sourceId: l.sourceId, externalId: l.externalId }));

function readStates(store: Store, records: RecordRef[]): RecordState[] {
  const manuals = new Map(store.listManualTransactions().map((m) => [m.id, m]));
  return records.map((r) =>
    r.sourceId === 'manual' ? { ...r, category: manuals.get(manualNumber(r.externalId))?.category ?? null, ignored: false } : { ...r, ...store.recordChoice(r.sourceId, r.externalId) },
  );
}

/** One record that stands for a transaction, kept so the transaction can be found again after the ids are rebuilt. */
const targetOf = (store: Store, id: string): RecordRef => recordsOf(store, id)[0] ?? { sourceId: '', externalId: '' };

/** The canonical id a record belongs to now, or null when it is gone. */
function idOfRecord(store: Store, r: RecordRef): string | null {
  if (r.sourceId === 'manual') return isManualId(r.externalId) && store.listManualTransactions().some((m) => m.id === manualNumber(r.externalId)) ? r.externalId : null;
  return r.sourceId === '' ? null : store.transactionOfRecord(r.sourceId, r.externalId);
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ToolError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

const FILTER_KEYS = ['from', 'to', 'q', 'merchant', 'category', 'categories', 'min', 'max', 'accounts', 'recurrence'];
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A filter that picks the transactions to change is read strictly. `readFilter` leaves out a value it cannot use, which is fine
 * for reading but would widen a write: a blank search or a negative amount would match everything. Here every key that is
 * present must be usable, and at least one must narrow the choice. A null counts as absent.
 */
function checkWriteFilter(filter: Record<string, unknown>): void {
  const known = new Set([...FILTER_KEYS, 'kind']);
  const unknown = Object.keys(filter).filter((k) => !known.has(k) && filter[k] !== undefined && filter[k] !== null);
  if (unknown.length > 0) throw new ToolError(`filter has keys that are not known: ${unknown.join(', ')}; use only ${FILTER_KEYS.join(', ')}`);
  const present = (k: string): boolean => filter[k] !== undefined && filter[k] !== null;
  const wordList = (k: string): void => {
    const v = filter[k];
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || x.trim() === '')) throw new ToolError(`filter.${k} must be a list of texts, with at least one`);
  };
  let narrows = 0;
  for (const k of FILTER_KEYS.filter(present)) {
    const v = filter[k];
    if (k === 'from' || k === 'to') {
      if (typeof v !== 'string' || !DAY_TEXT.test(v)) throw new ToolError(`filter.${k} must look like 2026-10-28`);
    } else if (k === 'q' || k === 'merchant' || k === 'category') {
      if (typeof v !== 'string' || v.trim() === '') throw new ToolError(`filter.${k} must be text that is not blank`);
    } else if (k === 'categories' || k === 'accounts') wordList(k);
    else if (k === 'min' || k === 'max') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ToolError(`filter.${k} must be a number of reais, zero or more`);
      if (k === 'min' && v === 0) continue;
    } else if (v !== 'subscription' && v !== 'recurring' && v !== 'any') throw new ToolError('filter.recurrence must be subscription, recurring or any');
    narrows += 1;
  }
  if (narrows === 0) throw new ToolError(`filter needs at least one of: ${FILTER_KEYS.join(', ')}`);
}

/**
 * The transactions a write step points at. The model gives refs it saw in this run, or a filter that the code resolves; it can
 * never give an id. A pending change planned again after a tap uses the records stored with it.
 */
function pick(store: Store, now: Date, args: Record<string, unknown>, ctx: ActionContext, options: { ignoredOnly?: boolean } = {}): Picked[] {
  const effective = new Map(effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).map((t) => [t.id, t]));
  const ids: string[] = [];
  if (ctx.stored) {
    for (const target of Array.isArray(args.targets) ? (args.targets as RecordRef[]) : []) {
      const id = idOfRecord(store, target);
      if (id !== null) ids.push(id);
    }
  } else {
    const hasRefs = args.refs !== undefined;
    const hasFilter = args.filter !== undefined;
    if (hasRefs === hasFilter) throw new ToolError('send either refs (from the transactions tool in this run) or filter, one of the two');
    if (hasRefs) {
      if (!Array.isArray(args.refs) || args.refs.length === 0 || args.refs.some((r) => typeof r !== 'string')) throw new ToolError('refs must be a list of refs such as "t1"');
      for (const ref of args.refs as string[]) {
        const target = ctx.refs.get<TxTarget>(ref, 't');
        if (!target) throw new ToolError(`ref ${ref} was not shown in this run; ask for the transactions again to get refs`);
        // The id may have changed in a rebuild since the model saw it: the record finds it again.
        ids.push((target.sourceId === '' ? null : idOfRecord(store, target)) ?? target.id);
      }
    } else {
      const filterArgs = asObject(args.filter, 'filter');
      checkWriteFilter(filterArgs);
      const filter = readFilter(store, filterArgs, localDay(now.toISOString()), { defaultFrom: undefined, kind: 'all' });
      const extra = options.ignoredOnly ? { includeExcluded: true, states: ['ignored' as const], spendingOnly: false } : { spendingOnly: false };
      for (const row of matchingRows(store, now, filter, extra)) ids.push(row.id);
    }
  }
  const unique = [...new Set(ids)];
  if (unique.length > MAX_TARGETS) throw new ToolError(`at most ${MAX_TARGETS} transactions per change; narrow the filter`);
  const picked: Picked[] = [];
  for (const id of unique) {
    const t = effective.get(id);
    if (!t) throw new ToolError('a transaction is not there any more; ask for the transactions again');
    picked.push({ id, category: t.category, state: t.state, amount: t.amount });
  }
  if (picked.length === 0) throw new ToolError('no transaction matches');
  return picked;
}

/** Puts the choices of the records back, unless one of them is not as the change left it. Records that are gone are skipped. */
function undoRecords(store: Store, now: Date, before: RecordState[], after: RecordState[], fields: Array<'category' | 'ignored'>): UndoOutcome {
  const present = (r: RecordRef): boolean => idOfRecord(store, r) !== null;
  const current = readStates(store, after);
  for (let i = 0; i < after.length; i++) {
    if (present(after[i]!) && fields.some((f) => current[i]![f] !== after[i]![f])) return 'conflict';
  }
  const at = now.toISOString();
  const manuals = new Map(store.listManualTransactions().map((m) => [m.id, m]));
  let rebuilds = fields.includes('ignored');
  for (const b of before) {
    if (!present(b)) continue;
    if (b.sourceId === 'manual') {
      const row = manuals.get(manualNumber(b.externalId));
      if (row) store.saveManualTransaction({ ...row, category: b.category }, at);
      rebuilds = true;
    } else store.setRecordChoice(b.sourceId, b.externalId, Object.fromEntries(fields.map((f) => [f, b[f]])), at);
  }
  if (rebuilds) rebuild(store, now);
  return 'ok';
}

// ---------- the tools ----------

const FILTER_HELP = 'refs: ["t1", ...] (de transactions nesta pergunta) OU filter: {from?, to?, q?, merchant?, category?, min?, max?, accounts?: [..], recurrence?}';

const setCategory: WriteTool = {
  name: 'set_category',
  help: `set_category {${FILTER_HELP}, category} : muda a categoria das transações (a categoria precisa existir; Pagamento de fatura, Transferência entre minhas contas e Investimentos também definem o papel).`,
  plan(store, now, args, ctx) {
    const name = existingCategory(store, text(args, 'category', 60));
    const rows = pick(store, now, args, ctx).filter((t) => t.category !== name);
    if (rows.length === 0) throw new ToolError(`those transactions are already in "${name}"`);
    const ids = rows.map((t) => t.id);
    return {
      label: `Categoria de ${plural(rows.length, 'transação', 'transações')} para ${name}`,
      count: rows.length, destructive: false, undoable: true,
      stored: { category: name, targets: ids.map((id) => targetOf(store, id)) },
      apply: () => {
        const records = ids.flatMap((id) => recordsOf(store, id));
        const before = readStates(store, records);
        failed(bulkEdit(store, ids, { category: name }, now));
        return { before, after: readStates(store, records) };
      },
    };
  },
  undo: (store, now, change) => undoRecords(store, now, change.before as RecordState[], change.after as RecordState[], ['category']),
};

const setIgnored: WriteTool = {
  name: 'set_ignored',
  help: `set_ignored {${FILTER_HELP}, ignored: true|false} : deixa as transações fora de todos os totais (true) ou volta a contá-las (false).`,
  plan(store, now, args, ctx) {
    if (typeof args.ignored !== 'boolean') throw new ToolError('ignored must be true or false');
    const ignored = args.ignored;
    // A transaction typed in by hand is deleted, not ignored.
    const rows = pick(store, now, args, ctx, { ignoredOnly: !ignored }).filter((t) => !isManualId(t.id) && (t.state === 'ignored') !== ignored);
    if (rows.length === 0) throw new ToolError(ignored ? 'those transactions are already ignored, or were typed in by hand' : 'none of those transactions is ignored');
    const ids = rows.map((t) => t.id);
    return {
      label: `${ignored ? 'Ignorar' : 'Voltar a contar'} ${plural(rows.length, 'transação', 'transações')}`,
      count: rows.length, destructive: false, undoable: true,
      stored: { ignored, targets: ids.map((id) => targetOf(store, id)) },
      apply: () => {
        const records = ids.flatMap((id) => recordsOf(store, id));
        const before = readStates(store, records);
        failed(bulkEdit(store, ids, { ignored }, now));
        return { before, after: readStates(store, records) };
      },
    };
  },
  undo: (store, now, change) => undoRecords(store, now, change.before as RecordState[], change.after as RecordState[], ['ignored']),
};

const ruleName = (store: Store, base: string): string => {
  const taken = new Set(store.listRules().map((r) => r.name.toLowerCase()));
  let name = base.slice(0, 80);
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, 72)} (${n})`;
  return name;
};

const createRuleTool: WriteTool = {
  name: 'create_rule',
  help: 'create_rule {field: merchant|description, text, category, name?} : cria uma regra de categoria. merchant casa o estabelecimento inteiro (igual), description casa quem contém o texto na descrição.',
  plan(store, now, args) {
    const field = args.field === 'description' ? 'description' : args.field === 'merchant' ? 'merchant' : null;
    if (field === null) throw new ToolError('field must be merchant or description');
    const value = text(args, 'text', 120);
    const category = existingCategory(store, text(args, 'category', 60));
    const conditions = { match: 'all' as const, items: [{ field, operator: field === 'merchant' ? ('equals' as const) : ('contains' as const), value }] };
    const preview = previewRule(store, { conditions, actions: { category } });
    if (!preview.ok) throw new ToolError(preview.error);
    if (preview.value.matched === 0) throw new ToolError('no transaction matches that text, so the rule would do nothing');
    const name = ruleName(store, typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim().replace(/\s+/g, ' ') : `${field === 'merchant' ? 'Estabelecimento' : 'Descrição'}: ${value}`);
    return {
      label: `Criar a regra "${name}": ${field === 'merchant' ? 'estabelecimento' : 'descrição com'} ${value} vai para ${category} (muda ${plural(preview.value.willChange, 'transação', 'transações')})`,
      count: preview.value.willChange, destructive: false, undoable: true,
      stored: { field, text: value, category, name },
      apply: () => {
        const made = createRule(store, { name, conditions, actions: { category } }, now);
        if (!made.ok) throw new ToolError(made.error);
        return { before: null, after: made.value };
      },
    };
  },
  undo(store, now, change) {
    const made = change.after as Rule;
    const current = store.listRules().find((r) => r.id === made.id);
    if (!current || !same(current, made)) return 'conflict';
    failed(deleteRule(store, made.id) as { ok: boolean; error?: string });
    return 'ok';
  },
};

const deleteRuleTool: WriteTool = {
  name: 'delete_rule',
  help: 'delete_rule {name} : apaga uma regra de categoria pelo nome (veja rules). Apagar espera o toque do dono.',
  plan(store, now, args) {
    const wanted = folded(text(args, 'name', 80));
    const rule = store.listRules().find((r) => folded(r.name) === wanted);
    if (!rule) throw new ToolError(`there is no rule called "${String(args.name)}"; use the rules tool for the names`);
    return {
      label: `Apagar a regra "${rule.name}" (${rule.actions.category})`,
      count: 1, destructive: true, undoable: true,
      stored: { name: rule.name },
      apply: () => {
        failed(deleteRule(store, rule.id) as { ok: boolean; error?: string });
        return { before: rule, after: null };
      },
    };
  },
  undo(store, now, change) {
    const old = change.before as Rule;
    // The rule comes back with a new id: the old one is gone for good.
    if (store.listRules().some((r) => r.name.toLowerCase() === old.name.toLowerCase())) return 'conflict';
    const made = createRule(store, { name: old.name, priority: old.priority, active: old.active, conditions: old.conditions, actions: old.actions }, now);
    return made.ok ? 'ok' : 'conflict';
  },
};

interface ReversalState {
  records: RecordRef[];
  rows: ReturnType<Store['listReversalRows']>;
}

const reversalState = (store: Store, ids: string[]): ReversalState => {
  const records = ids.flatMap((id) => recordsOf(store, id));
  return { records, rows: store.listReversalRows(records) };
};

/** Puts the reversal choices of these records back to what they were. */
function undoReversal(store: Store, now: Date, change: ChatChange): UndoOutcome {
  const before = change.before as ReversalState;
  const after = change.after as ReversalState;
  const current = store.listReversalRows(after.records);
  if (!same(current, after.rows)) return 'conflict';
  const at = now.toISOString();
  store.transaction(() => {
    for (const row of current) store.setReversalRow(row, null, at);
    for (const row of before.rows) store.setReversalRow(row, row.linked, at);
  });
  return 'ok';
}

function oneTransaction(store: Store, ctx: ActionContext, args: Record<string, unknown>, key: string): { id: string; amount: number; reversal: boolean } {
  let id: string | null;
  if (ctx.stored) id = idOfRecord(store, asObject(args[`${key}Target`], `${key}Target`) as unknown as RecordRef);
  else {
    const ref = args[key];
    if (typeof ref !== 'string') throw new ToolError(`${key} must be a ref such as "t1"`);
    const target = ctx.refs.get<TxTarget>(ref, 't');
    if (!target) throw new ToolError(`ref ${ref} was not shown in this run; ask for the transactions again to get refs`);
    id = (target.sourceId === '' ? null : idOfRecord(store, target)) ?? target.id;
  }
  const t = id === null ? undefined : effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).find((x) => x.id === id);
  if (!t) throw new ToolError('a transaction is not there any more; ask for the transactions again');
  if (isManualId(t.id)) throw new ToolError('a transaction typed in by hand cannot be paired');
  return { id: t.id, amount: t.amount, reversal: t.reversal !== null };
}

const linkReversal: WriteTool = {
  name: 'link_reversal',
  help: 'link_reversal {charge: ref da compra, refund: ref do estorno} : diz que o crédito devolveu aquela compra.',
  plan(store, now, args, ctx) {
    const charge = oneTransaction(store, ctx, args, 'charge');
    const refund = oneTransaction(store, ctx, args, 'refund');
    if (charge.amount >= 0 || refund.amount <= 0) throw new ToolError('charge must be a purchase (money out) and refund a credit (money in)');
    return {
      label: `Vincular o estorno de ${money(refund.amount)} à compra de ${money(-charge.amount)}`,
      count: 1, destructive: false, undoable: true,
      stored: { chargeTarget: targetOf(store, charge.id), refundTarget: targetOf(store, refund.id) },
      apply: () => {
        const before = reversalState(store, [charge.id, refund.id]);
        failed(setReversal(store, charge.id, refund.id, now));
        return { before, after: { records: before.records, rows: store.listReversalRows(before.records) } };
      },
    };
  },
  undo: undoReversal,
};

const unlinkReversal: WriteTool = {
  name: 'unlink_reversal',
  help: 'unlink_reversal {tx: ref da compra ou do estorno} : diz que aquele par não é um estorno (o app não volta a sugerir).',
  plan(store, now, args, ctx) {
    const tx = oneTransaction(store, ctx, args, 'tx');
    if (!tx.reversal) throw new ToolError('that transaction has no refund linked to it');
    return {
      label: `Desfazer o vínculo de estorno de uma transação de ${money(Math.abs(tx.amount))}`,
      count: 1, destructive: false, undoable: true,
      stored: { txTarget: targetOf(store, tx.id) },
      apply: () => {
        const other = effectiveTransactions(store, { includeHidden: true, includeExcluded: true }).find((t) => t.id === tx.id)?.reversal?.otherId;
        const before = reversalState(store, other === undefined ? [tx.id] : [tx.id, other]);
        failed(setReversal(store, tx.id, null, now));
        return { before, after: { records: before.records, rows: store.listReversalRows(before.records) } };
      },
    };
  },
  undo: undoReversal,
};

interface JoinState {
  records: RecordRef[];
  pairs: string[];
}

const pairsOf = (store: Store, records: RecordRef[]): string[] => {
  const keys = new Set(records.map((r) => `${r.sourceId}|${r.externalId}`));
  return store
    .listManualMapping()
    .pairs.filter(([a, b]) => keys.has(`${a.sourceId}|${a.externalId}`) || keys.has(`${b.sourceId}|${b.externalId}`))
    .map(([a, b]) => `${a.sourceId}|${a.externalId}~${b.sourceId}|${b.externalId}`)
    .sort();
};

const resolveFinding: WriteTool = {
  name: 'resolve_finding',
  help: 'resolve_finding {finding: ref f1 de suggestions, action: join|dismiss} : junta as duas transações de um possível duplicado (join) ou diz que não são a mesma (dismiss). Descartar não tem volta e espera o toque do dono.',
  plan(store, now, args, ctx) {
    const action = args.action === 'join' ? 'join' : args.action === 'dismiss' ? 'dismiss' : null;
    if (action === null) throw new ToolError('action must be join or dismiss');
    let findingId: string | undefined;
    if (ctx.stored) findingId = typeof args.findingId === 'string' ? args.findingId : undefined;
    else {
      if (typeof args.finding !== 'string') throw new ToolError('finding must be a ref such as "f1"');
      findingId = ctx.refs.get<string>(args.finding, 'f');
      if (!findingId) throw new ToolError(`ref ${args.finding} was not shown in this run; use the suggestions tool again`);
    }
    const finding = store.listFindings().find((f) => f.id === findingId);
    if (!finding) throw new ToolError('that suggestion is not open any more');
    const other = typeof finding.details.otherTransactionId === 'string' ? finding.details.otherTransactionId : null;
    if (other === null) throw new ToolError('that suggestion has no second transaction');
    const amount = typeof finding.details.amount === 'number' ? ` de ${money(Math.abs(finding.details.amount))}` : '';
    const stored = { findingId: finding.id, action };
    if (action === 'dismiss') {
      return {
        label: `Descartar a sugestão de duplicata${amount}: não são a mesma transação`,
        count: 1, destructive: false, undoable: false, stored,
        apply: () => {
          failed(dismissSuggestion(store, finding.id, now));
          return { before: null, after: null };
        },
      };
    }
    const records = [...recordsOf(store, finding.transactionId), ...recordsOf(store, other)];
    if (pairsOf(store, records).length > 0) throw new ToolError('one of them was already joined by hand; undo that first');
    return {
      label: `Juntar duas transações que são a mesma${amount}`,
      count: 1, destructive: false, undoable: true, stored,
      apply: () => {
        failed(joinTransactions(store, finding.transactionId, other, now));
        return { before: { records, pairs: [] } satisfies JoinState, after: { records, pairs: pairsOf(store, records) } satisfies JoinState };
      },
    };
  },
  undo(store, now, change) {
    const after = change.after as JoinState;
    if (!same(pairsOf(store, after.records), after.pairs)) return 'conflict';
    const merged = after.records.map((r) => idOfRecord(store, r)).find((id): id is string => id !== null);
    if (merged !== undefined) store.removeManualLinks(merged);
    rebuild(store, now);
    return 'ok';
  },
};

type BudgetState = { scope: string; name: string; month: string; amount: number; recurring: boolean } | null;

const budgetRow = (store: Store, scope: string, name: string, month: string): BudgetState => {
  const row = store.listBudgets().find((b) => b.scope === scope && b.name === name && b.month === month);
  return row ? { scope, name, month, amount: row.amount, recurring: row.recurring } : null;
};

const setBudgetTool: WriteTool = {
  name: 'set_budget',
  help: 'set_budget {name, scope?: category|group (padrão category), month? (padrão o mês atual), amount: reais ou null para remover, recurring?: true|false (sem isso a linha mantém o que já tinha, e uma linha nova repete nos meses seguintes)} : cria ou muda uma linha de orçamento.',
  plan(store, now, args) {
    const scope = args.scope === 'group' ? 'group' : 'category';
    const typed = text(args, 'name', 60);
    // The name is stored as the app spells it: a group written without its accent would be saved under a name that is not a group.
    const name = scope === 'category' ? existingCategory(store, typed) : existingGroup(store, typed);
    const month = typeof args.month === 'string' && args.month !== '' ? args.month : localDay(now.toISOString()).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ToolError('month must look like 2026-10');
    const remove = args.amount === null;
    const amount = remove ? null : cents(args, 'amount');
    const current = budgetRow(store, scope, name, month);
    // What is not said stays as the screen shows it: the line keeps its repetition, and a new line repeats, as it does on Orçamentos.
    const recurring = typeof args.recurring === 'boolean' ? args.recurring : (resolveBudget(store.listBudgets(), scope, name, month)?.recurring ?? true);
    if (remove && current === null) throw new ToolError('there is no budget line to remove for that month');
    return {
      label: remove ? `Remover o orçamento de ${name} em ${monthLabel(month)}` : `Orçamento de ${name} em ${monthLabel(month)}: ${money(amount!)}${current ? ` (era ${money(current.amount)})` : ''}, ${recurring ? 'repete nos meses seguintes' : 'só neste mês'}`,
      count: 1, destructive: false, undoable: true,
      stored: { name, scope, month, amount: amount === null ? null : amount / 100, recurring },
      apply: () => {
        failed(setBudget(store, { scope, name, month, amount, recurring }, now));
        return { before: current, after: budgetRow(store, scope, name, month) };
      },
    };
  },
  undo(store, now, change) {
    const before = change.before as BudgetState;
    const after = change.after as BudgetState;
    const target = before ?? after;
    if (target === null) return 'ok';
    if (!same(budgetRow(store, target.scope, target.name, target.month), after)) return 'conflict';
    store.setBudget(target.scope as 'category' | 'group', target.name, target.month, before?.amount ?? null, before?.recurring ?? false, now.toISOString());
    return 'ok';
  },
};

const incomeInput = (i: Omit<IncomeItem, 'id'>): Record<string, unknown> => ({ name: i.name, amount: i.amount, dayOfMonth: i.dayOfMonth, nonBusinessRule: i.nonBusinessRule, fromMonth: i.fromMonth, untilMonth: i.untilMonth });
const incomeNamed = (store: Store, name: string): IncomeItem[] => store.listIncome().filter((i) => folded(i.name) === folded(name));
const dayArg = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);
const daysOf = (items: IncomeItem[]): string => items.map((i) => i.dayOfMonth).sort((a, b) => a - b).join(', ');

/**
 * The income entry a name points at. The Renda panel keeps one entry per payment day under one name, so a name alone is enough
 * only when a single entry has it; with several, the day says which one. A raise is stored as an ended entry and a current one
 * with the same name and day, so on a tie the one that has not ended wins.
 */
function incomeEntry(store: Store, name: string, day: number | null, now: Date): IncomeItem | undefined {
  const named = incomeNamed(store, name);
  if (day === null) {
    if (named.length > 1) throw new ToolError(`${named.length} income entries are called "${named[0]!.name}" (days ${daysOf(named)}); send dayOfMonth to say which one`);
    return named[0];
  }
  const onDay = named.filter((i) => i.dayOfMonth === day);
  if (onDay.length <= 1) return onDay[0];
  const month = localMonth(now.toISOString());
  const running = onDay.filter((i) => i.untilMonth === null || i.untilMonth >= month);
  if (running.length === 1) return running[0];
  throw new ToolError(`${onDay.length} income entries are called "${onDay[0]!.name}" on day ${day} (${onDay.map((i) => `${i.fromMonth ?? 'sempre'} a ${i.untilMonth ?? 'sem fim'}`).join('; ')}); change the one that is current on the Renda panel`);
}

const upsertIncome: WriteTool = {
  name: 'upsert_income',
  help: 'upsert_income {name, amount: reais, dayOfMonth: 1-31, currentDay?: dia atual da renda quando for mudar o dia, nonBusinessRule?: previous|next|keep, fromMonth?, untilMonth?} : cadastra uma renda mensal. Cada dia de pagamento é uma entrada: o mesmo nome em outro dia cria outra entrada; para mudar o valor de uma já cadastrada, repita o nome e o dia (o que não for dito fica como está).',
  plan(store, now, args) {
    const name = text(args, 'name', 60);
    const day = dayArg(args.dayOfMonth);
    const from = dayArg(args.currentDay);
    if (args.currentDay !== undefined && args.currentDay !== null && from === null) throw new ToolError('currentDay must be a whole number');
    // With currentDay the entry on that day moves to dayOfMonth; with only dayOfMonth, the entry on that day changes, or another one is added.
    const current = from !== null ? incomeEntry(store, name, from, now) : incomeEntry(store, name, day, now);
    if (from !== null && !current) throw new ToolError(`there is no income called "${name}" on day ${from}`);
    const input: Record<string, unknown> = { ...(current ? incomeInput(current) : {}), name: current?.name ?? name };
    if (args.amount !== undefined || !current) input.amount = cents(args, 'amount');
    if (args.dayOfMonth !== undefined || !current) input.dayOfMonth = args.dayOfMonth;
    for (const key of ['nonBusinessRule', 'fromMonth', 'untilMonth']) if (args[key] !== undefined) input[key] = args[key];
    return {
      label: current ? `Mudar a renda "${current.name}" para ${money(input.amount as number)} no dia ${String(input.dayOfMonth)} (era ${money(current.amount)} no dia ${current.dayOfMonth})` : `Cadastrar a renda "${name}" de ${money(input.amount as number)} no dia ${String(input.dayOfMonth)}`,
      count: 1, destructive: false, undoable: true,
      stored: { name, amount: input.amount === undefined ? undefined : (input.amount as number) / 100, dayOfMonth: input.dayOfMonth, currentDay: current?.dayOfMonth, nonBusinessRule: args.nonBusinessRule, fromMonth: args.fromMonth, untilMonth: args.untilMonth },
      apply: () => {
        const saved = saveIncome(store, current?.id ?? null, input, now);
        if (!saved.ok) throw new ToolError(saved.error);
        return { before: current ?? null, after: store.listIncome().find((i) => i.id === saved.value.id) ?? null };
      },
    };
  },
  undo(store, now, change) {
    const after = change.after as IncomeItem | null;
    const before = change.before as IncomeItem | null;
    if (after === null || !same(store.listIncome().find((i) => i.id === after.id), after)) return 'conflict';
    if (before === null) failed(deleteIncome(store, after.id) as { ok: boolean; error?: string });
    else failed(saveIncome(store, before.id, incomeInput(before), now) as { ok: boolean; error?: string });
    return 'ok';
  },
};

const deleteIncomeTool: WriteTool = {
  name: 'delete_income',
  help: 'delete_income {name, dayOfMonth? (obrigatório quando o mesmo nome tem mais de uma entrada)} : apaga uma renda cadastrada (veja income_items). Apagar espera o toque do dono.',
  plan(store, now, args) {
    const item = incomeEntry(store, text(args, 'name', 60), dayArg(args.dayOfMonth), now);
    if (!item) throw new ToolError('there is no registered income with that name (and day); use the income_items tool for the names');
    return {
      label: `Apagar a renda "${item.name}" de ${money(item.amount)} no dia ${item.dayOfMonth}`,
      count: 1, destructive: true, undoable: true,
      stored: { name: item.name, dayOfMonth: item.dayOfMonth },
      apply: () => {
        failed(deleteIncome(store, item.id) as { ok: boolean; error?: string });
        return { before: item, after: null };
      },
    };
  },
  undo(store, now, change) {
    const old = change.before as IncomeItem;
    if (incomeNamed(store, old.name).some((i) => i.dayOfMonth === old.dayOfMonth)) return 'conflict';
    const saved = saveIncome(store, null, incomeInput(old), now);
    return saved.ok ? 'ok' : 'conflict';
  },
};

export const WRITE_TOOLS: WriteTool[] = [setCategory, setIgnored, createRuleTool, deleteRuleTool, linkReversal, unlinkReversal, resolveFinding, setBudgetTool, upsertIncome, deleteIncomeTool];
export const writeToolByName = new Map(WRITE_TOOLS.map((t) => [t.name, t]));

// ---------- when the model may change data ----------

/** Forms that can only be a request, wherever they stand in the question: the formal imperative ("mude", "corrija"). */
const IMPERATIVE =
  'corrij(a|am)|mud(e|em)|tro(que|quem)|categoriz(e|em)|reclassifiqu(e|em)|classifiqu(e|em)|mar(que|quem)|ignor(e|em)|cri(e|em)|apagu(e|em)|remov(a|am)|exclu(a|am)|defin(a|am)|junt(e|em)|vincul(e|em)|desvincul(e|em)|apliqu(e|em)|desfa(ca|cam)|cadastr(e|em)|adicion(e|em)|atualiz(e|em)|descart(e|em)|alter(e|em)|coloqu(e|em)|mov(a|am)|inclu(a|am)|registr(e|em)|acrescent(e|em)|tir(e|em)|delet(e|em)';
/** The everyday imperative ("muda", "troca"). It is also the plain present ("a regra cria"), or a noun ("ajuste", "marca"), so it counts only where a clause begins. */
const COLLOQUIAL =
  'corrige|muda|troca|categoriza|reclassifica|classifica|marca|ignora|cria|apaga|remove|exclui|ajusta|ajuste|define|junta|vincula|desvincula|aplica|desfaz|cadastra|adiciona|atualiza|descarta|altera|coloca|move|inclui|registra|acrescenta|tira|passa|passe|deleta';
/** "mudar", "criar" ... : a plain infinitive is a request only after "pode", "quero" ..., or when it opens the question. */
const INFINITIVE =
  'corrigir|mudar|trocar|categorizar|reclassificar|classificar|marcar|ignorar|criar|apagar|remover|excluir|ajustar|definir|juntar|vincular|desvincular|aplicar|desfazer|cadastrar|adicionar|atualizar|descartar|alterar|colocar|mover|incluir|registrar|acrescentar|tirar|passar|deletar';

const CLAUSE_START = '(?:^|[.!?;,]\\s*|\\b(?:e|entao|agora|depois|tambem|ai|ok|certo|beleza|sim|favor|por favor)\\s+)';
const FRAME = '(?:pode|podem|poderia|poderiam|consegue|quero|queria|preciso|gostaria de|vamos|favor|por favor|da pra|da para|tem como|e possivel|bora)';

const IMPERATIVE_RE = new RegExp(`\\b(?:${IMPERATIVE})\\b`);
const COLLOQUIAL_RE = new RegExp(`${CLAUSE_START}(?:${COLLOQUIAL})\\b`);
const INFINITIVE_RE = new RegExp(`${CLAUSE_START}(?:${INFINITIVE})\\b|\\b${FRAME}\\b(?:\\W+\\w+){0,3}?\\W+(?:${INFINITIVE})\\b`);
/** A question about the data ("quais compras foram categorizadas?", "o que a regra faz?") is a read, whatever verbs it holds. */
const ASKS_ABOUT = /^(?:(?:e|mas|entao)\s+)?(?:qual|quais|quanto|quantos|quantas|quando|onde|quem|como|por que|porque|o que|que|ha|existe|existem|foi|foram|sera|esta|estao|sao|temos|houve|ja|tem(?! como))\b/;

/**
 * Whether the owner's question asks for a change (corrigir, trocar, ignorar, apagar, aplicar, desfazer ...), as a command and not
 * as a question about the data. Participles ("categorizadas") and past forms ("mudou") are never a request. The check reads
 * the owner's words only, so text inside a transaction description cannot unlock a write.
 */
export function asksForChange(question: string): boolean {
  const f = folded(question);
  if (ASKS_ABOUT.test(f)) return IMPERATIVE_RE.test(f);
  return IMPERATIVE_RE.test(f) || COLLOQUIAL_RE.test(f) || INFINITIVE_RE.test(f) || /\bpode sim\b|\bfaz(er)? isso\b/.test(f);
}

/** A short answer to the analyst ("Supermercado", "sim", "a primeira"): no question, a few words. */
const isShortReply = (question: string): boolean => {
  const f = folded(question);
  return f.length <= 60 && !f.includes('?') && !ASKS_ABOUT.test(f);
};

/**
 * Whether the write tools are on for this question: the owner asks for a change, or answers in a few words to a request for a
 * change (the analyst asked which category, or a change waits for a tap). A plain read question never turns them on, so a stale
 * pending change or a clarification does not widen what text inside a transaction can do.
 */
export function writesAllowed(history: Array<Pick<ChatMessage, 'role' | 'content'>>, question: string): boolean {
  if (asksForChange(question)) return true;
  if (!isShortReply(question)) return false;
  // A request for a change stays open while the analyst keeps asking what is missing and the owner keeps answering in a few words.
  let open = false;
  for (const m of history) open = m.role === 'user' ? asksForChange(m.content) || (open && isShortReply(m.content)) : open && m.content.trim().endsWith('?');
  return open;
}

// ---------- the change log: listing, expiring, undoing, confirming ----------

/** A change as the screen shows it. The values kept for undo stay in the database. */
export interface ChangeView {
  id: number;
  messageId: number | null;
  tool: string;
  label: string;
  count: number;
  status: ChangeStatus;
  destructive: boolean;
  undoable: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

export const changeView = (c: ChatChange): ChangeView => ({ id: c.id, messageId: c.messageId, tool: c.tool, label: c.label, count: c.count, status: c.status, destructive: c.destructive, undoable: c.undoable, createdAt: c.createdAt, resolvedAt: c.resolvedAt });

export type ChatMessageView = ChatMessage & { changes: ChangeView[] };

const pendingExpired = (c: ChatChange, now: Date): boolean => c.status === 'pending' && now.getTime() - Date.parse(c.createdAt) > PENDING_MINUTES * 60_000;

/** Marks the changes that waited too long for a tap. */
export function expirePending(store: Store, now: Date, conversationId: number): void {
  for (const c of store.listChatChanges(conversationId)) {
    if (pendingExpired(c, now)) store.updateChatChange(c.id, { status: 'expired', resolvedAt: now.toISOString() });
  }
}

/** The messages of a conversation, each with the changes it lists. */
export function messagesWithChanges(store: Store, now: Date, conversationId: number): ChatMessageView[] {
  expirePending(store, now, conversationId);
  const changes = store.listChatChanges(conversationId);
  return store.listChatMessages(conversationId).map((m) => ({ ...m, changes: changes.filter((c) => c.messageId === m.id).map(changeView) }));
}

export type ChangeResult = { ok: true; change: ChangeView } | { ok: false; status: number; error: string; message: string };

const refuse = (status: number, error: string, message: string): ChangeResult => ({ ok: false, status, error, message });

/** The owner taps Desfazer. The old values go back only when nothing touched the same data since. */
export function undoChange(store: Store, now: Date, id: number): ChangeResult {
  const change = store.getChatChange(id);
  if (!change) return refuse(404, 'not_found', 'Alteração não encontrada.');
  if (change.status !== 'applied') return refuse(409, 'not_applied', 'Esta alteração não está aplicada, então não há o que desfazer.');
  const tool = writeToolByName.get(change.tool);
  if (!change.undoable || !tool) return refuse(409, 'not_undoable', 'Esta alteração não pode ser desfeita com exatidão.');
  const at = now.toISOString();
  let outcome: UndoOutcome = 'conflict';
  try {
    store.transaction(() => {
      outcome = tool.undo(store, now, change);
      if (outcome === 'ok') store.updateChatChange(id, { status: 'undone', resolvedAt: at });
    });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    outcome = 'conflict';
  }
  if (outcome === 'conflict') {
    store.updateChatChange(id, { status: 'conflict', resolvedAt: at });
    return refuse(409, 'conflict', 'Algo mudou depois desta alteração, então ela não foi desfeita para não apagar o que você fez.');
  }
  return { ok: true, change: changeView(store.getChatChange(id)!) };
}

/** The owner taps Confirmar. The change is planned again on today's data and applied only if it did not grow. */
export function confirmChange(store: Store, now: Date, id: number): ChangeResult {
  const change = store.getChatChange(id);
  if (!change) return refuse(404, 'not_found', 'Alteração não encontrada.');
  if (change.status !== 'pending') return refuse(409, 'not_pending', 'Esta alteração não está esperando confirmação.');
  const at = now.toISOString();
  if (pendingExpired(change, now)) {
    store.updateChatChange(id, { status: 'expired', resolvedAt: at });
    return refuse(409, 'expired', `Passaram mais de ${PENDING_MINUTES} minutos, então o pedido expirou. Peça de novo no chat.`);
  }
  const tool = writeToolByName.get(change.tool);
  const changed = (): ChangeResult => {
    store.updateChatChange(id, { status: 'expired', resolvedAt: at });
    return refuse(409, 'data_changed', 'Os dados mudaram desde o pedido, então nada foi aplicado. Peça de novo no chat.');
  };
  if (!tool) return changed();
  let plan: Plan;
  try {
    plan = tool.plan(store, now, change.args as Record<string, unknown>, { refs: new RefBook(), stored: true });
  } catch (error) {
    if (error instanceof ToolError) return changed();
    throw error;
  }
  if (plan.count > change.count) return changed();
  try {
    store.transaction(() => {
      const result = plan.apply();
      store.updateChatChange(id, { status: 'applied', resolvedAt: at, label: plan.label, count: plan.count, before: result.before, after: result.after });
    });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return changed();
  }
  return { ok: true, change: changeView(store.getChatChange(id)!) };
}

/** The owner taps Cancelar. */
export function declineChange(store: Store, now: Date, id: number): ChangeResult {
  const change = store.getChatChange(id);
  if (!change) return refuse(404, 'not_found', 'Alteração não encontrada.');
  if (change.status !== 'pending') return refuse(409, 'not_pending', 'Esta alteração não está esperando confirmação.');
  store.updateChatChange(id, { status: 'declined', resolvedAt: now.toISOString() });
  return { ok: true, change: changeView(store.getChatChange(id)!) };
}
