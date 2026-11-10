/**
 * Card statements the owner uploads as PDF files. The file is read here (src/pdf, no dependency), shown as a preview that
 * writes nothing, and applied as records of the source 'pdf': one source account per physical card (tied to the card of
 * another source the owner picks), one transaction per line and one bill per statement. Reconciliation then joins each
 * line with the Pluggy record of the same charge, so what Pluggy lacks is added and what both have counts once.
 *
 * Only the parsed lines and the file hash are kept. The file, its name, and the name, CPF and address printed on it are not.
 */
import { createHash } from 'node:crypto';
import type { CanonicalAccount } from '../core/canonical.ts';
import { dayNumber } from '../core/dates.ts';
import { normalizeName } from '../core/names.ts';
import { PDF_SOURCE } from '../core/sources.ts';
import { DATA_START, localDay, startOfLocalDay } from '../core/time.ts';
import type { SourceAccount, SourceBill, SourceTransaction } from '../core/types.ts';
import { PdfError, readPdf } from '../pdf/reader.ts';
import { isAccountStatement, parseAccountStatement, type ParsedAccountStatement } from '../pdf/account-statement.ts';
import { parseStatement, StatementError, type ParsedStatement, type StatementLine } from '../pdf/statement.ts';
import type { AccountPin } from '../reconcile/accounts.ts';
import { manualId, planReconciliation, runReconciliation, type SourceOverride } from '../reconcile/run.ts';
import type { BillImport, ManualTransaction, Store } from '../store/store.ts';
import { applyAccountStatement, previewAccountStatement, type AccountApplyResult, type AccountPreview } from './account-import.ts';
import { billGapOf, type BillGap } from './bill-check.ts';

/** Largest file the upload route reads. A text statement is well under 1 MB; the image-only exports are 20 MB and more. */
export const MAX_BILL_FILE_BYTES = 6 * 1024 * 1024;
/** Body of the AI reading route: a page as base64 JPEG of at most 1.5 MB, and a little JSON around it. */
export const MAX_VISION_BODY_BYTES = 1.5 * 1024 * 1024 + 4096;
const PREVIEW_LINES = 400;
/** A parsed statement is kept in memory this long after the upload, so applying it does not send the file again. */
const HOLD_MS = 30 * 60_000;
const HOLD_MAX = 10;
/** A typed-in transaction this close to a statement line, with the same amount, is probably the same charge. */
const MANUAL_DAYS = 3;

export type ImportResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; message: string };

const fail = (status: number, error: string, message: string): ImportResult<never> => ({ ok: false, status, error, message });

export type LineMatch = 'already_there' | 'new' | 'possible_duplicate' | 'outside';

export interface PreviewLine {
  day: string;
  description: string;
  amount: number;
  installment: { number: number; total: number } | null;
  foreign: { currency: string; amount: number } | null;
  kind: StatementLine['kind'];
  cardFinal: string;
  /** already_there: another source has this charge and the two become one. new: only the statement has it. possible_duplicate: something close (a typed-in transaction, a pair the app asks about, or a charge of another amount on the same day) may be the same charge. outside: dated before the app's data. */
  match: LineMatch;
  /** The canonical transaction (or typed-in one, `man_<id>`) it matches or may duplicate. */
  matchId: string | null;
  note: string | null;
}

export interface BillPreview {
  readable: true;
  statementKind: 'card';
  fileHash: string;
  issuer: ParsedStatement['issuer'];
  product: string;
  dueDate: string;
  closingDate: string | null;
  total: number;
  tieOut: ParsedStatement['tieOut'];
  warnings: string[];
  /** The cards on the statement (last 4 digits) with their lines and the app card each one goes to. `bill` marks the one that gets the bill total. */
  cards: Array<{ final: string; lines: number; bill: boolean; targetId: string | null }>;
  /** Credit cards to choose from. */
  accounts: Array<{ id: string; institution: string; name: string; last4: string | null }>;
  /** Lines that would be stored (payments of the previous bill are not). */
  lineCount: number;
  skipped: { payments: number; inAnalysis: number };
  counts: Record<LineMatch, number>;
  lines: PreviewLine[];
  /** Typed-in transactions on the chosen cards that the statement seems to bring too. Applying can remove them. */
  manualCandidates: Array<{ id: string; accountId: string; day: string; amount: number; description: string }>;
  /** The same bill as another source has it, when it does: that one keeps deciding the bill's total and dates. */
  otherBill: { total: number; closingDate: string | null } | null;
  /** Conferir's gap for this bill on the card that gets it, before applying. */
  gap: BillGap | null;
  /** The same statement applied before: applying again replaces it. */
  previous: { id: number; appliedAt: string; sameFile: boolean } | null;
  /** Every card has a target, so the statement can be applied. */
  ready: boolean;
}

export interface ImageOnly {
  readable: false;
  fileHash: string;
  reason: 'no_text';
  message: string;
  images: Array<{ page: number; width: number; height: number; colorSpace: string; filter: string }>;
}

export interface ApplyResult {
  importId: number;
  lines: number;
  removedManual: number;
  /** Conferir's gap before and after, per card that changed. */
  gaps: Array<{ accountId: string; cycleKey: string; before: BillGap | null; after: BillGap | null }>;
}

export interface BillImportView {
  id: number;
  issuer: string;
  dueDate: string;
  closingDate: string | null;
  total: number;
  cardFinals: string[];
  lineCount: number;
  method: BillImport['method'];
  status: BillImport['status'];
  appliedAt: string;
  resolvedAt: string | null;
  removedManual: number;
}

// --- reading -------------------------------------------------------------------------------------------------------

const PDF_MESSAGES: Record<PdfError['code'], string> = {
  not_pdf: 'O arquivo não é um PDF.',
  encrypted: 'O PDF está protegido por senha. Salve uma cópia sem senha e envie de novo.',
  unsupported: 'O PDF usa um formato interno que o leitor do app não entende.',
  too_large: 'O PDF passa do limite de páginas ou de conteúdo que o app lê.',
  damaged: 'O PDF está danificado: nenhuma página pôde ser lida.',
};

type AnyStatement = ParsedStatement | ParsedAccountStatement;
const isAccount = (s: AnyStatement): s is ParsedAccountStatement => s.issuer === '99pay';

interface Held {
  statement: AnyStatement;
  at: number;
}

const HELD = new WeakMap<Store, Map<string, Held>>();

function holdings(store: Store, now: Date): Map<string, Held> {
  const map = HELD.get(store) ?? new Map<string, Held>();
  HELD.set(store, map);
  for (const [hash, held] of map) if (now.getTime() - held.at > HOLD_MS) map.delete(hash);
  return map;
}

function hold(store: Store, hash: string, statement: AnyStatement, now: Date): void {
  const map = holdings(store, now);
  map.delete(hash);
  while (map.size >= HOLD_MAX) map.delete(map.keys().next().value as string);
  map.set(hash, { statement, at: now.getTime() });
}

const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

/** Reads an uploaded file and answers its preview, or why it cannot be read. Nothing is written. */
export function readBillFile(store: Store, bytes: Uint8Array, now: Date): ImportResult<BillPreview | AccountPreview | ImageOnly> {
  if (bytes.length === 0) return fail(400, 'bad_request', 'O arquivo está vazio.');
  if (bytes.length > MAX_BILL_FILE_BYTES) return fail(413, 'payload_too_large', 'O arquivo passa de 6 MB.');
  const fileHash = sha(bytes);
  let statement: AnyStatement;
  try {
    const doc = readPdf(bytes, { maxBytes: MAX_BILL_FILE_BYTES });
    try {
      statement = isAccountStatement(doc) ? parseAccountStatement(doc) : parseStatement(doc);
    } catch (error) {
      if (error instanceof StatementError && error.code === 'no_text') {
        return { ok: true, value: { readable: false, fileHash, reason: 'no_text', message: 'O PDF não tem texto: é uma imagem da fatura. Só a leitura pela IA conseguiria ler as compras.', images: doc.images.slice(0, 10).map((i) => ({ page: i.page, width: i.width, height: i.height, colorSpace: i.colorSpace, filter: i.filter })) } };
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof PdfError) return fail(422, 'unreadable_pdf', PDF_MESSAGES[error.code]);
    if (error instanceof StatementError) return fail(422, error.code, error.code === 'unknown_layout' ? 'Este PDF não parece uma fatura Bradescard, Bradesco, Nubank ou Itaú, nem um extrato 99Pay.' : `Não foi possível ler o arquivo: ${error.message}.`);
    return fail(422, 'unreadable_pdf', 'Não foi possível ler este PDF.');
  }
  hold(store, fileHash, statement, now);
  if (isAccount(statement)) return previewAccountStatement(store, fileHash, statement, {}, now);
  return previewOf(store, fileHash, statement, { byFinal: {} }, now);
}

/** The preview of a statement uploaded in the last 30 minutes, for other cards than the suggested ones. */
export function previewBillFile(store: Store, input: Record<string, unknown>, now: Date): ImportResult<BillPreview | AccountPreview> {
  const statement = heldStatement(store, input.fileHash, now);
  if (!statement.ok) return statement;
  if (isAccount(statement.value)) {
    if (input.accountId !== undefined && input.accountId !== null && typeof input.accountId !== 'string') return fail(400, 'bad_request', 'accountId precisa ser o id de uma conta.');
    return previewAccountStatement(store, input.fileHash as string, statement.value, typeof input.accountId === 'string' ? { accountId: input.accountId } : {}, now);
  }
  const choice = choiceOf(input);
  if (!choice.ok) return choice;
  return previewOf(store, input.fileHash as string, statement.value, choice.value, now);
}

function heldStatement(store: Store, fileHash: unknown, now: Date): ImportResult<AnyStatement> {
  if (typeof fileHash !== 'string' || !/^[0-9a-f]{64}$/.test(fileHash)) return fail(400, 'bad_request', 'fileHash é obrigatório.');
  const held = holdings(store, now).get(fileHash);
  return held ? { ok: true, value: held.statement } : fail(410, 'expired', 'A leitura deste arquivo expirou. Envie o PDF de novo.');
}

interface Choice {
  /** Card for every final the owner did not pick one for. */
  accountId?: string;
  byFinal: Record<string, string>;
}

function choiceOf(input: Record<string, unknown>): ImportResult<Choice> {
  const accountId = input.accountId;
  if (accountId !== undefined && accountId !== null && typeof accountId !== 'string') return fail(400, 'bad_request', 'accountId precisa ser o id de um cartão.');
  const targets = input.targets ?? {};
  if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) return fail(400, 'bad_request', 'targets precisa ser { final: id do cartão }.');
  const byFinal: Record<string, string> = {};
  for (const [final, id] of Object.entries(targets)) {
    if (!/^\d{4}$/.test(final) || typeof id !== 'string') return fail(400, 'bad_request', 'targets precisa ser { final: id do cartão }.');
    byFinal[final] = id;
  }
  return { ok: true, value: { ...(typeof accountId === 'string' ? { accountId } : {}), byFinal } };
}

// --- records -------------------------------------------------------------------------------------------------------

const ISSUER_LABEL: Record<ParsedStatement['issuer'], string> = { bradescard: 'Bradescard', bradesco: 'Bradesco', nubank: 'Nubank', itau: 'Itaú' };

const pdfAccountId = (issuer: string, final: string): string => `pdf_${issuer}_${final}`;

/** The card a line belongs to: its section, or the card the bill is issued to (fees and lines outside any section). */
function finalsOf(s: ParsedStatement): { lineFinal: (l: StatementLine) => string | null; billFinal: string | null } {
  const fallback = s.headerCardFinal ?? s.cardFinals[0] ?? null;
  return { lineFinal: (l) => l.cardFinal ?? fallback, billFinal: fallback };
}

const billIdOf = (s: ParsedStatement, billFinal: string): string => `pdfbill_${sha(`${s.issuer}|${billFinal}|${s.dueDate}`).slice(0, 24)}`;

/** The source account a card of the app stands for: its member from a source other than the PDF one when it has one. */
function targetRef(account: CanonicalAccount): { sourceId: string; externalId: string } | null {
  const members = account.refs.filter((r) => r.role === 'member');
  return members.find((r) => r.sourceId !== PDF_SOURCE) ?? members[0] ?? null;
}

interface Records {
  billId: string;
  accounts: SourceAccount[];
  transactions: SourceTransaction[];
  bill: SourceBill;
  pins: AccountPin[];
  /** Statement line index of each transaction, in order. */
  lineOf: number[];
}

function recordsOf(store: Store, s: ParsedStatement, targets: Map<string, CanonicalAccount>): Records {
  const { lineFinal, billFinal } = finalsOf(s);
  const billId = billIdOf(s, billFinal as string);
  const accounts: SourceAccount[] = [];
  const pins: AccountPin[] = [];
  for (const final of statementFinals(s)) {
    const target = targets.get(final);
    const ref = target ? targetRef(target) : null;
    const source = ref ? store.listSourceAccounts(ref.sourceId).find((a) => a.externalId === ref.externalId) : undefined;
    const externalId = pdfAccountId(s.issuer, final);
    // The copied institution, kind and name are what lets the clustering join the two even without the pin.
    accounts.push({ externalId, externalItemId: null, institution: source?.institution ?? ISSUER_LABEL[s.issuer], kind: 'credit_card', name: source?.name ?? (s.product || ISSUER_LABEL[s.issuer]), last4: final, balance: 0, creditLimit: null, availableLimit: null, minimumPayment: null, dueDate: null });
    if (ref && ref.sourceId !== PDF_SOURCE) pins.push({ sourceId: PDF_SOURCE, externalId, targetSourceId: ref.sourceId, targetExternalId: ref.externalId });
  }
  const seen = new Map<string, number>();
  const transactions: SourceTransaction[] = [];
  const lineOf: number[] = [];
  s.lines.forEach((line, index) => {
    if (line.kind === 'payment') return;
    const final = lineFinal(line) as string;
    const description = line.description.trim() || line.city || 'Lançamento da fatura';
    // Every field that tells two lines apart, and a counter for identical ones, so the same statement read again gives the same ids.
    const key = [s.issuer, final, s.dueDate, line.day, normalizeName(description), line.amount, line.installment ? `${line.installment.number}/${line.installment.total}` : ''].join('|');
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    transactions.push({
      externalId: `pdf_${sha(`${key}|${occurrence}`).slice(0, 24)}`,
      accountExternalId: pdfAccountId(s.issuer, final),
      occurredAt: startOfLocalDay(line.day),
      amount: line.amount,
      description,
      descriptionRaw: null,
      status: 'posted',
      installment: line.installment,
      category: null,
      parties: { operation: null, mcc: null, payer: null, receiver: null, foreign: line.foreign ? { currency: line.foreign.currency, amount: line.foreign.amount, converted: true } : null, billId, billForecast: null },
    });
    lineOf.push(index);
  });
  const bill: SourceBill = { externalId: billId, accountExternalId: pdfAccountId(s.issuer, billFinal as string), dueDate: s.dueDate, closingDate: s.closingDate, total: s.total, minimumPayment: null };
  return { billId, accounts, transactions, bill, pins, lineOf };
}

/** The cards that get records: the bill's card and every card with a line to store. */
function statementFinals(s: ParsedStatement): string[] {
  const { lineFinal, billFinal } = finalsOf(s);
  const finals = billFinal ? [billFinal] : [];
  for (const l of s.lines) {
    const f = lineFinal(l);
    if (l.kind !== 'payment' && f !== null && !finals.includes(f)) finals.push(f);
  }
  return finals;
}

/**
 * The card of the app each statement card goes to. The bill's card: the owner's pick, then a suggestion. Any other card
 * of the statement: the owner's pick, then a suggestion, then the bill's card (Pluggy can list a second card of the
 * statement under the first one). A suggestion is the card chosen last time, then the card with those last 4 digits.
 */
function resolveTargets(store: Store, s: ParsedStatement, choice: Choice): Map<string, CanonicalAccount> {
  const cards = store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card');
  const byId = new Map(cards.map((a) => [a.id, a]));
  const pins = new Map(store.listBillImportAccounts().map((p) => [p.pdfAccountExternalId, p]));
  const last4 = new Map<string, string | null>();
  for (const sourceId of new Set(cards.flatMap((a) => a.refs.map((r) => r.sourceId)))) for (const a of store.listSourceAccounts(sourceId)) last4.set(`${sourceId}|${a.externalId}`, a.last4);
  const suggest = (final: string): CanonicalAccount | undefined => {
    const pin = pins.get(pdfAccountId(s.issuer, final));
    const pinned = pin && cards.find((a) => a.refs.some((r) => r.sourceId === pin.targetSourceId && r.externalId === pin.targetExternalId));
    return pinned || (cards.find((a) => a.last4 === final) ?? cards.find((a) => a.refs.some((r) => r.sourceId !== PDF_SOURCE && last4.get(`${r.sourceId}|${r.externalId}`) === final)));
  };
  const pick = (id: string | undefined) => (id === undefined ? undefined : byId.get(id));
  const out = new Map<string, CanonicalAccount>();
  const billFinal = finalsOf(s).billFinal;
  const billTarget = billFinal === null ? undefined : (pick(choice.byFinal[billFinal]) ?? pick(choice.accountId) ?? suggest(billFinal));
  if (billFinal !== null && billTarget) out.set(billFinal, billTarget);
  for (const final of statementFinals(s)) {
    if (final === billFinal) continue;
    const target = pick(choice.byFinal[final]) ?? suggest(final) ?? billTarget;
    if (target) out.set(final, target);
  }
  return out;
}

// --- preview -------------------------------------------------------------------------------------------------------

function previewOf(store: Store, fileHash: string, s: ParsedStatement, choice: Choice, now: Date): ImportResult<BillPreview> {
  const { lineFinal, billFinal } = finalsOf(s);
  if (billFinal === null) return fail(422, 'incomplete', 'A fatura não diz de que cartão é (os 4 últimos dígitos).');
  const cardIds = new Set(store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card').map((a) => a.id));
  for (const id of [...Object.values(choice.byFinal), ...(choice.accountId ? [choice.accountId] : [])]) {
    if (!cardIds.has(id)) return fail(400, 'bad_request', 'O cartão escolhido não existe.');
  }
  const targets = resolveTargets(store, s, choice);
  const records = recordsOf(store, s, targets);
  const override: SourceOverride = { sourceId: PDF_SOURCE, dropBillId: records.billId, accounts: records.accounts, transactions: records.transactions, bills: [records.bill], pins: records.pins };
  const plan = planReconciliation(store, { now: () => now }, override);

  const txById = new Map(plan.transactions.transactions.map((t) => [t.id, t]));
  const linkOf = new Map(plan.transactions.links.filter((l) => l.sourceId === PDF_SOURCE).map((l) => [l.externalId, l.transactionId]));
  const linksByTx = new Map<string, Array<{ sourceId: string; externalId: string }>>();
  for (const l of plan.transactions.links) linksByTx.set(l.transactionId, [...(linksByTx.get(l.transactionId) ?? []), l]);
  // Possible matches the app would ask about after applying, by transaction.
  const pairOf = new Map<string, string>();
  for (const f of plan.transactions.findings) {
    const other = typeof f.details.otherTransactionId === 'string' ? f.details.otherTransactionId : null;
    if (!other) continue;
    pairOf.set(f.transactionId, other);
    pairOf.set(other, f.transactionId);
  }
  const statementMonth = statementMonths(store);
  const dueMonth = s.dueDate.slice(0, 7);
  const manual = store.listManualTransactions();
  const offered = new Set<number>();
  const manualCandidates: BillPreview['manualCandidates'] = [];
  const counts: Record<LineMatch, number> = { already_there: 0, new: 0, possible_duplicate: 0, outside: 0 };
  const lines: PreviewLine[] = [];

  records.transactions.forEach((record, k) => {
    const line = s.lines[records.lineOf[k] as number] as StatementLine;
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
      const sameDay = plan.transactions.transactions.find((o) => o.accountId === t.accountId && o.id !== t.id && !o.sourceIds.includes(PDF_SOURCE) && o.state !== 'ignored' && Math.sign(o.amount) === Math.sign(t.amount) && o.amount !== t.amount && localDay(o.occurredAt) === line.day && (linksByTx.get(o.id) ?? []).some((r) => statementMonth(r.sourceId, r.externalId) === dueMonth));
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
      } else if (sameDay) {
        match = 'possible_duplicate';
        matchId = sameDay.id;
        note = 'No mesmo dia, nesta fatura, há uma transação de outro valor: confira se é a mesma compra com o valor diferente.';
      } else match = 'new';
    }
    counts[match]++;
    if (lines.length < PREVIEW_LINES) {
      lines.push({ day: line.day, description: record.description, amount: line.amount, installment: line.installment, foreign: line.foreign ? { currency: line.foreign.currency, amount: line.foreign.amount } : null, kind: line.kind, cardFinal: lineFinal(line) as string, match, matchId, note });
    }
  });

  const billTarget = targets.get(billFinal);
  const otherBill = billTarget ? otherBillOf(store, billTarget, dueMonth) : null;
  const warnings = [...s.warnings];
  if (otherBill && otherBill.total !== s.total) warnings.push('O Meu Pluggy tem esta fatura com outro total; o app continua usando o total dele para conferir.');
  const previous = store.listBillImports().find((i) => i.billId === records.billId && i.status === 'applied');
  const finals = statementFinals(s);
  return {
    ok: true,
    value: {
      readable: true,
      statementKind: 'card',
      fileHash,
      issuer: s.issuer,
      product: s.product,
      dueDate: s.dueDate,
      closingDate: s.closingDate,
      total: s.total,
      tieOut: s.tieOut,
      warnings,
      cards: finals.map((final) => ({ final, lines: records.transactions.filter((t) => t.accountExternalId === pdfAccountId(s.issuer, final)).length, bill: final === billFinal, targetId: targets.get(final)?.id ?? null })),
      accounts: store.listCanonicalAccounts().filter((a) => a.kind === 'credit_card').map((a) => ({ id: a.id, institution: a.institution, name: a.name, last4: a.last4 })),
      lineCount: records.transactions.length,
      skipped: { payments: s.lines.filter((l) => l.kind === 'payment').length, inAnalysis: s.inAnalysis?.length ?? 0 },
      counts,
      lines,
      manualCandidates,
      otherBill,
      gap: billTarget ? billGapOf(store, now, billTarget.id, dueMonth) : null,
      previous: previous ? { id: previous.id, appliedAt: previous.appliedAt, sameFile: previous.fileHash === fileHash } : null,
      ready: finals.every((f) => targets.has(f)),
    },
  };
}

/** The due month of the statement a record of another source sits on (its bill, or the issuer's forecast). */
function statementMonths(store: Store): (sourceId: string, externalId: string) => string | null {
  const bills = new Map<string, string>();
  const records = new Map<string, SourceTransaction>();
  for (const sourceId of store.listSourceIds()) {
    if (sourceId === PDF_SOURCE) continue;
    for (const b of store.listSourceBills(sourceId)) bills.set(`${sourceId}|${b.externalId}`, b.dueDate.slice(0, 7));
    for (const t of store.listSourceTransactions(sourceId)) records.set(`${sourceId}|${t.externalId}`, t);
  }
  return (sourceId, externalId) => {
    const t = records.get(`${sourceId}|${externalId}`);
    if (!t) return null;
    return (t.parties?.billId ? bills.get(`${sourceId}|${t.parties.billId}`) : undefined) ?? t.parties?.billForecast ?? null;
  };
}

/** The bill another source gives for this card and due month. */
function otherBillOf(store: Store, account: CanonicalAccount, dueMonth: string): BillPreview['otherBill'] {
  for (const ref of account.refs) {
    if (ref.sourceId === PDF_SOURCE) continue;
    const bill = store.listSourceBills(ref.sourceId).find((b) => b.accountExternalId === ref.externalId && b.dueDate.slice(0, 7) === dueMonth);
    if (bill) return { total: bill.total, closingDate: bill.closingDate };
  }
  return null;
}

// --- apply and undo ------------------------------------------------------------------------------------------------

/** Stores a statement uploaded in the last 30 minutes, replacing an earlier copy of it, and rebuilds the canonical data. */
export function applyBillFile(store: Store, input: Record<string, unknown>, now: Date): ImportResult<ApplyResult | AccountApplyResult> {
  const held = heldStatement(store, input.fileHash, now);
  if (!held.ok) return held;
  const choice = choiceOf(input);
  if (!choice.ok) return choice;
  const remove = input.removeManual ?? [];
  if (!Array.isArray(remove) || remove.some((id) => typeof id !== 'string')) return fail(400, 'bad_request', 'removeManual precisa ser uma lista de ids.');
  if (isAccount(held.value)) {
    if (input.accountId !== undefined && input.accountId !== null && typeof input.accountId !== 'string') return fail(400, 'bad_request', 'accountId precisa ser o id de uma conta.');
    return applyAccountStatement(store, input.fileHash as string, held.value, { ...(typeof input.accountId === 'string' ? { accountId: input.accountId } : {}), removeManual: remove as string[] }, now);
  }
  const preview = previewOf(store, input.fileHash as string, held.value, choice.value, now);
  if (!preview.ok) return preview;
  if (!preview.value.ready) return fail(400, 'target_required', 'Escolha o cartão do app para cada cartão da fatura.');
  // Only typed-in transactions the preview offered can go, so a stale or forged id removes nothing.
  const offered = new Set(preview.value.manualCandidates.map((m) => m.id));
  if (remove.some((id) => !offered.has(id as string))) return fail(409, 'changed', 'A lista de transações digitadas mudou. Confira a prévia de novo.');

  const s = held.value;
  const targets = resolveTargets(store, s, choice.value);
  const records = recordsOf(store, s, targets);
  const dueMonth = s.dueDate.slice(0, 7);
  const touched = [...new Set([...targets.values()].map((a) => a.id))];
  const before = new Map(touched.map((id) => [id, billGapOf(store, now, id, dueMonth)]));
  const removed: ManualTransaction[] = store.listManualTransactions().filter((m) => remove.includes(manualId(m.id)));
  const stamp = now.toISOString();
  let importId = 0;
  store.transaction(() => {
    store.registerSource({ id: PDF_SOURCE, kind: 'manual-import', capabilities: {} }, stamp);
    const earlier = store.listBillImports().filter((i) => i.billId === records.billId && i.status === 'applied');
    store.deleteSourceBillRecords(PDF_SOURCE, records.billId);
    store.upsertSourceAccounts(PDF_SOURCE, records.accounts, stamp);
    for (const pin of records.pins) store.setBillImportAccount({ pdfAccountExternalId: pin.externalId, targetSourceId: pin.targetSourceId, targetExternalId: pin.targetExternalId }, stamp);
    store.upsertSourceTransactions(PDF_SOURCE, records.transactions, stamp);
    store.upsertSourceBills(PDF_SOURCE, [records.bill], stamp);
    store.deleteEmptySourceAccounts(PDF_SOURCE);
    for (const m of removed) store.deleteManualTransaction(m.id);
    for (const e of earlier) store.setBillImportStatus(e.id, 'replaced', stamp);
    // Undoing this import puts back what an earlier copy of the statement removed too.
    const kept = [...earlier.flatMap((e) => e.removedManual), ...removed.map((m) => ({ accountId: m.accountId, day: m.day, amount: m.amount, description: m.description, category: m.category, notes: m.notes }))];
    importId = store.addBillImport({ fileHash: input.fileHash as string, billId: records.billId, issuer: s.issuer, dueDate: s.dueDate, closingDate: s.closingDate, total: s.total, cardFinals: statementFinals(s), lineCount: records.transactions.length, method: 'text', removedManual: kept, appliedAt: stamp });
    runReconciliation(store, { now: () => now });
  });
  return { ok: true, value: { importId, lines: records.transactions.length, removedManual: removed.length, gaps: touched.map((id) => ({ accountId: id, cycleKey: dueMonth, before: before.get(id) ?? null, after: billGapOf(store, now, id, dueMonth) })) } };
}

/** "Desfazer importação": removes the statement's records and bill, puts back the typed-in transactions it replaced, and rebuilds. */
export function undoBillImport(store: Store, id: number, now: Date): ImportResult<{ removed: number; restoredManual: number }> {
  const row = store.listBillImports().find((i) => i.id === id);
  if (!row) return fail(404, 'not_found', 'Importação não encontrada.');
  if (row.status !== 'applied') return fail(409, 'not_applied', row.status === 'undone' ? 'Esta importação já foi desfeita.' : 'Esta importação foi substituída por outra da mesma fatura.');
  const stamp = now.toISOString();
  let removed = 0;
  store.transaction(() => {
    removed = store.deleteSourceBillRecords(PDF_SOURCE, row.billId).transactions;
    store.deleteEmptySourceAccounts(PDF_SOURCE);
    for (const m of row.removedManual) store.saveManualTransaction(m, stamp);
    store.setBillImportStatus(row.id, 'undone', stamp);
    runReconciliation(store, { now: () => now });
  });
  return { ok: true, value: { removed, restoredManual: row.removedManual.length } };
}

export function listBillImports(store: Store): BillImportView[] {
  return store.listBillImports().map((i) => ({ id: i.id, issuer: i.issuer, dueDate: i.dueDate, closingDate: i.closingDate, total: i.total, cardFinals: i.cardFinals, lineCount: i.lineCount, method: i.method, status: i.status, appliedAt: i.appliedAt, resolvedAt: i.resolvedAt, removedManual: i.removedManual.length }));
}
