/**
 * Payment account statements (today the 99Pay "EXTRATO") the owner uploads as PDF. The lines become records of the
 * source 'pdf' on one account of the app that the owner picks (a checking account, pinned like cards are), with no bill.
 * Every record gets the id the statement prints, so the same row read again is the same record, and the usual
 * reconciliation joins each one with the record of the same movement that Pluggy has: equal amount and close time, one
 * to one, so a charge and its reversal of the same value stay two records and meet Pluggy's two.
 *
 * `parties.billId` carries the id of the import (account and period) on every record, which is how a re-import and an
 * undo find the records to delete. No source bill exists for it.
 */
import { createHash } from 'node:crypto';
import type { CanonicalAccount } from '../core/canonical.ts';
import { dayNumber } from '../core/dates.ts';
import { PDF_SOURCE } from '../core/sources.ts';
import { BRAZIL_OFFSET_MS, DATA_START } from '../core/time.ts';
import type { SourceAccount, SourceTransaction } from '../core/types.ts';
import type { AccountStatementLine, ParsedAccountStatement } from '../pdf/account-statement.ts';
import type { AccountPin } from '../reconcile/accounts.ts';
import { manualId, planReconciliation, runReconciliation, type SourceOverride } from '../reconcile/run.ts';
import type { ManualTransaction, Store } from '../store/store.ts';
import type { ImportResult, LineMatch } from './bill-import.ts';

const MANUAL_DAYS = 3;
const PREVIEW_LINES = 400;
/** The one account record the PDF source keeps for payment account statements. */
const ACCOUNT_EXTERNAL_ID = 'pdf_99pay_account';
const LABEL = '99Pay';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const fail = (status: number, error: string, message: string): ImportResult<never> => ({ ok: false, status, error, message });

export interface AccountPreviewLine {
  day: string;
  time: string;
  description: string;
  amount: number;
  match: LineMatch;
  matchId: string | null;
  note: string | null;
}

export interface AccountPreview {
  readable: true;
  statementKind: 'account';
  fileHash: string;
  issuer: ParsedAccountStatement['issuer'];
  from: string;
  to: string;
  /** Net of all the lines, in cents. */
  total: number;
  warnings: string[];
  accounts: Array<{ id: string; institution: string; name: string; last4: string | null }>;
  targetId: string | null;
  lineCount: number;
  counts: Record<LineMatch, number>;
  lines: AccountPreviewLine[];
  manualCandidates: Array<{ id: string; accountId: string; day: string; amount: number; description: string }>;
  previous: { id: number; appliedAt: string; sameFile: boolean } | null;
  ready: boolean;
}

export interface AccountApplyResult {
  importId: number;
  lines: number;
  removedManual: number;
  gaps: [];
}

const importKeyOf = (s: ParsedAccountStatement): string => `pdfacct_${sha(`${s.issuer}|${s.from}|${s.to}`).slice(0, 24)}`;

/** Brazil time (UTC-3) to the UTC instant. */
const instantOf = (day: string, time: string): string => new Date(Date.parse(`${day}T${time}Z`) + BRAZIL_OFFSET_MS).toISOString();

const memberRef = (account: CanonicalAccount): { sourceId: string; externalId: string } | null => {
  const members = account.refs.filter((r) => r.role === 'member');
  return members.find((r) => r.sourceId !== PDF_SOURCE) ?? members[0] ?? null;
};

function resolveTarget(store: Store, accountId: string | undefined): CanonicalAccount | undefined {
  const candidates = store.listCanonicalAccounts().filter((a) => a.kind !== 'credit_card');
  if (accountId !== undefined) return candidates.find((a) => a.id === accountId);
  const pin = store.listBillImportAccounts().find((p) => p.pdfAccountExternalId === ACCOUNT_EXTERNAL_ID);
  const pinned = pin && candidates.find((a) => a.refs.some((r) => r.sourceId === pin.targetSourceId && r.externalId === pin.targetExternalId));
  return pinned || candidates.find((a) => /\b99\b|99pay/i.test(`${a.institution} ${a.name}`));
}

interface Records {
  importKey: string;
  accounts: SourceAccount[];
  transactions: SourceTransaction[];
  pins: AccountPin[];
  lineOf: AccountStatementLine[];
}

function recordsOf(store: Store, s: ParsedAccountStatement, target: CanonicalAccount): Records {
  const importKey = importKeyOf(s);
  const ref = memberRef(target);
  const source = ref ? store.listSourceAccounts(ref.sourceId).find((a) => a.externalId === ref.externalId) : undefined;
  const accounts: SourceAccount[] = [{ externalId: ACCOUNT_EXTERNAL_ID, externalItemId: null, institution: source?.institution ?? LABEL, kind: source?.kind ?? 'checking', name: source?.name ?? LABEL, last4: null, balance: 0, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null }];
  const pins: AccountPin[] = ref && ref.sourceId !== PDF_SOURCE ? [{ sourceId: PDF_SOURCE, externalId: ACCOUNT_EXTERNAL_ID, targetSourceId: ref.sourceId, targetExternalId: ref.externalId }] : [];
  const transactions = s.lines.map((line): SourceTransaction => ({
    externalId: `pdf_${sha(`${s.issuer}|${line.id}|${line.occurrence}`).slice(0, 24)}`,
    accountExternalId: ACCOUNT_EXTERNAL_ID,
    occurredAt: instantOf(line.day, line.time),
    amount: line.amount,
    description: line.type || 'Lançamento do extrato',
    descriptionRaw: null,
    status: 'posted',
    installment: null,
    category: null,
    parties: { operation: null, mcc: null, payer: null, receiver: null, foreign: null, billId: importKey, billForecast: null },
  }));
  return { importKey, accounts, transactions, pins, lineOf: s.lines };
}

export function previewAccountStatement(store: Store, fileHash: string, s: ParsedAccountStatement, input: { accountId?: string }, now: Date): ImportResult<AccountPreview> {
  const accounts = store.listCanonicalAccounts().filter((a) => a.kind !== 'credit_card');
  if (input.accountId !== undefined && !accounts.some((a) => a.id === input.accountId)) return fail(400, 'bad_request', 'A conta escolhida não existe.');
  const target = resolveTarget(store, input.accountId);
  const previous = store.listBillImports().find((i) => i.billId === importKeyOf(s) && i.status === 'applied');
  const view = (): AccountPreview['accounts'] => accounts.map((a) => ({ id: a.id, institution: a.institution, name: a.name, last4: a.last4 }));
  const total = s.lines.reduce((a, l) => a + l.amount, 0);
  const base = { readable: true as const, statementKind: 'account' as const, fileHash, issuer: s.issuer, from: s.from, to: s.to, total, warnings: [...s.warnings], accounts: view(), targetId: target?.id ?? null, lineCount: s.lines.length, previous: previous ? { id: previous.id, appliedAt: previous.appliedAt, sameFile: previous.fileHash === fileHash } : null };
  const counts: Record<LineMatch, number> = { already_there: 0, new: 0, possible_duplicate: 0, outside: 0 };
  if (!target) return { ok: true, value: { ...base, counts, lines: [], manualCandidates: [], ready: false } };

  const records = recordsOf(store, s, target);
  const override: SourceOverride = { sourceId: PDF_SOURCE, dropBillId: records.importKey, accounts: records.accounts, transactions: records.transactions, bills: [], pins: records.pins };
  const plan = planReconciliation(store, { now: () => now }, override);
  const txById = new Map(plan.transactions.transactions.map((t) => [t.id, t]));
  const linkOf = new Map(plan.transactions.links.filter((l) => l.sourceId === PDF_SOURCE).map((l) => [l.externalId, l.transactionId]));
  const pairOf = new Map<string, string>();
  for (const f of plan.transactions.findings) {
    const other = typeof f.details.otherTransactionId === 'string' ? f.details.otherTransactionId : null;
    if (!other) continue;
    pairOf.set(f.transactionId, other);
    pairOf.set(other, f.transactionId);
  }
  const manual = store.listManualTransactions();
  const offered = new Set<number>();
  const manualCandidates: AccountPreview['manualCandidates'] = [];
  const lines: AccountPreviewLine[] = [];
  records.transactions.forEach((record, k) => {
    const line = records.lineOf[k] as AccountStatementLine;
    const txId = linkOf.get(record.externalId);
    const t = txId ? txById.get(txId) : undefined;
    let match: LineMatch;
    let matchId: string | null = null;
    let note: string | null = null;
    if (!t) {
      match = 'outside';
      note = `Antes de ${DATA_START.split('-').reverse().join('/')}, fora dos dados do app.`;
    } else if (t.sourceIds.length > 1) {
      match = 'already_there';
      matchId = t.id;
    } else {
      const day = dayNumber(line.day);
      const typed = manual.find((m) => !offered.has(m.id) && m.accountId === t.accountId && m.amount === t.amount && Math.abs(dayNumber(m.day) - day) <= MANUAL_DAYS);
      if (typed) {
        offered.add(typed.id);
        match = 'possible_duplicate';
        matchId = manualId(typed.id);
        note = 'Você lançou à mão uma transação com o mesmo valor perto deste dia.';
        manualCandidates.push({ id: manualId(typed.id), accountId: typed.accountId, day: typed.day, amount: typed.amount, description: typed.description });
      } else if (pairOf.has(t.id)) {
        match = 'possible_duplicate';
        matchId = pairOf.get(t.id) as string;
        note = 'Há outra transação com o mesmo valor a poucos dias: o app vai perguntar se é a mesma.';
      } else match = 'new';
    }
    counts[match]++;
    if (lines.length < PREVIEW_LINES) lines.push({ day: line.day, time: line.time, description: record.description, amount: line.amount, match, matchId, note });
  });
  return { ok: true, value: { ...base, counts, lines, manualCandidates, ready: true } };
}

export function applyAccountStatement(store: Store, fileHash: string, s: ParsedAccountStatement, input: { accountId?: string; removeManual: string[] }, now: Date): ImportResult<AccountApplyResult> {
  const preview = previewAccountStatement(store, fileHash, s, input, now);
  if (!preview.ok) return preview;
  if (!preview.value.ready) return fail(400, 'target_required', 'Escolha a conta do app para este extrato.');
  const offered = new Set(preview.value.manualCandidates.map((m) => m.id));
  if (input.removeManual.some((id) => !offered.has(id))) return fail(409, 'changed', 'A lista de transações digitadas mudou. Confira a prévia de novo.');
  const target = resolveTarget(store, input.accountId) as CanonicalAccount;
  const records = recordsOf(store, s, target);
  const removed: ManualTransaction[] = store.listManualTransactions().filter((m) => input.removeManual.includes(manualId(m.id)));
  const stamp = now.toISOString();
  let importId = 0;
  store.transaction(() => {
    store.registerSource({ id: PDF_SOURCE, kind: 'manual-import', capabilities: {} }, stamp);
    const earlier = store.listBillImports().filter((i) => i.billId === records.importKey && i.status === 'applied');
    store.deleteSourceBillRecords(PDF_SOURCE, records.importKey);
    store.upsertSourceAccounts(PDF_SOURCE, records.accounts, stamp);
    for (const pin of records.pins) store.setBillImportAccount({ pdfAccountExternalId: pin.externalId, targetSourceId: pin.targetSourceId, targetExternalId: pin.targetExternalId }, stamp);
    store.upsertSourceTransactions(PDF_SOURCE, records.transactions, stamp);
    store.deleteEmptySourceAccounts(PDF_SOURCE);
    for (const m of removed) store.deleteManualTransaction(m.id);
    for (const e of earlier) store.setBillImportStatus(e.id, 'replaced', stamp);
    const kept = [...earlier.flatMap((e) => e.removedManual), ...removed.map((m) => ({ accountId: m.accountId, day: m.day, amount: m.amount, description: m.description, category: m.category, notes: m.notes }))];
    importId = store.addBillImport({ fileHash, billId: records.importKey, issuer: s.issuer, dueDate: s.to, closingDate: s.from, total: preview.value.total, cardFinals: [], lineCount: records.transactions.length, method: 'text', removedManual: kept, appliedAt: stamp });
    runReconciliation(store, { now: () => now });
  });
  return { ok: true, value: { importId, lines: records.transactions.length, removedManual: removed.length, gaps: [] } };
}
