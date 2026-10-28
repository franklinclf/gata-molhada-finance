import type { AccountKind, SourceAccount, SourceBill, SourceTransaction } from '../../core/types.ts';
import { SourceFormatError } from '../../core/http.ts';
import { toCents } from '../../core/money.ts';
import { partiesFrom, partyFrom, type Party } from '../../core/parties.ts';
import { toCashFlow, toStatus } from '../cash-flow.ts';
import {
  asArray,
  asRecord,
  optDay,
  optNumber,
  optString,
  reqIsoInstant,
  reqNumber,
  reqString,
  UnsupportedAccountError,
} from '../shape.ts';

export interface CardCredit {
  creditLimit: number | null;
  availableLimit: number | null;
  minimumPayment: number | null;
  dueDate: string | null;
}

export function kindOf(type: string, subtype: string, path: string): AccountKind {
  if (type === 'BANK' && subtype === 'CHECKING_ACCOUNT') return 'checking';
  if (type === 'BANK' && (subtype === 'SAVINGS_ACCOUNT' || subtype === 'SAVINGS')) return 'savings';
  if (type === 'CREDIT' && subtype === 'CREDIT_CARD') return 'credit_card';
  throw new UnsupportedAccountError(`${path}: unsupported account type ${type}/${subtype}`);
}

/**
 * Pierre's account list has no card limits, so they come from the credit data that
 * rides on every card transaction. The newest transaction of each account wins.
 */
export function extractCardCredit(rawTransactions: unknown[]): Map<string, CardCredit> {
  const newest = new Map<string, { date: string; credit: CardCredit }>();
  for (const raw of rawTransactions) {
    const r = asRecord(raw, 'pierre.transaction');
    if (r.account_credit_data === null || r.account_credit_data === undefined) continue;
    const data = asRecord(r.account_credit_data, 'pierre.transaction.account_credit_data');
    const accountId = reqString(r, 'account_id', 'pierre.transaction');
    const date = reqIsoInstant(r, 'date', 'pierre.transaction');
    const current = newest.get(accountId);
    if (current && current.date >= date) continue;
    newest.set(accountId, {
      date,
      credit: {
        creditLimit: optNumber(data, 'creditLimit'),
        availableLimit: optNumber(data, 'availableCreditLimit'),
        minimumPayment: optNumber(data, 'minimumPayment'),
        dueDate: optDay(data, 'balanceDueDate'),
      },
    });
  }
  return new Map([...newest].map(([accountId, value]) => [accountId, value.credit]));
}

const cents = (value: number | null) => (value === null ? null : toCents(value));

export function normalizeAccount(raw: unknown, credit: CardCredit | undefined): SourceAccount {
  const path = 'pierre.account';
  const r = asRecord(raw, path);
  const kind = kindOf(reqString(r, 'type', path), reqString(r, 'subtype', path), path);
  return {
    externalId: reqString(r, 'id', path),
    externalItemId: null,
    institution: optString(r, 'connectorName') ?? 'Manual',
    kind,
    name: reqString(r, 'name', path),
    last4: null,
    balance: toCents(reqNumber(r, 'balance', path)),
    creditLimit: kind === 'credit_card' ? cents(credit?.creditLimit ?? null) : null,
    availableLimit: kind === 'credit_card' ? cents(credit?.availableLimit ?? null) : null,
    minimumPayment: kind === 'credit_card' ? cents(credit?.minimumPayment ?? null) : null,
    dueDate: kind === 'credit_card' ? (credit?.dueDate ?? null) : null,
  };
}

function partyOf(side: unknown): Party | null {
  if (typeof side !== 'object' || side === null || Array.isArray(side)) return null;
  const record = side as Record<string, unknown>;
  const number = typeof record.documentNumber === 'object' && record.documentNumber !== null ? (record.documentNumber as Record<string, unknown>) : {};
  return partyFrom(optString(record, 'name'), typeof number.value === 'string' ? number.value : null, typeof number.type === 'string' ? number.type : null);
}

/** Pix, TED and boleto name both sides by document; card purchases carry the merchant code. */
export function partiesOf(r: Record<string, unknown>) {
  const data = typeof r.payment_data === 'object' && r.payment_data !== null ? (r.payment_data as Record<string, unknown>) : {};
  const card = typeof r.credit_card_data === 'object' && r.credit_card_data !== null ? (r.credit_card_data as Record<string, unknown>) : {};
  const mcc = card.payeeMCC;
  return partiesFrom({ operation: optString(r, 'operation_type'), mcc: typeof mcc === 'string' || typeof mcc === 'number' ? String(mcc) : null, payer: partyOf(data.payer), receiver: partyOf(data.receiver) });
}

export function normalizeTransaction(raw: unknown): SourceTransaction {
  const path = 'pierre.transaction';
  const r = asRecord(raw, path);
  const kind = kindOf(reqString(r, 'account_type', path), reqString(r, 'account_subtype', path), path);
  const rawStatus = reqString(r, 'status', path);
  const status = toStatus(rawStatus);
  if (status === null) throw new SourceFormatError(`${path}.status: unsupported value ${rawStatus}`);

  let installment: SourceTransaction['installment'] = null;
  if (r.credit_card_data !== null && r.credit_card_data !== undefined) {
    const meta = asRecord(r.credit_card_data, `${path}.credit_card_data`);
    const number = optNumber(meta, 'installmentNumber');
    const total = optNumber(meta, 'totalInstallments');
    if (number !== null && total !== null) installment = { number, total };
  }

  const parties = partiesOf(r);
  return {
    externalId: reqString(r, 'id', path),
    accountExternalId: reqString(r, 'account_id', path),
    occurredAt: reqIsoInstant(r, 'date', path),
    amount: toCashFlow(kind, reqNumber(r, 'amount', path)),
    description: reqString(r, 'description', path),
    descriptionRaw: optString(r, 'original_description'),
    status,
    installment,
    category: optString(r, 'category'),
    ...(parties ? { parties } : {}),
  };
}

export function normalizeBill(raw: unknown): SourceBill {
  const path = 'pierre.bill';
  const r = asRecord(raw, path);
  const dueDate = optDay(r, 'dueDate');
  if (dueDate === null) throw new SourceFormatError(`${path}.dueDate: expected a date`);
  const minimum = optNumber(r, 'minimumPaymentAmount');
  return {
    externalId: reqString(r, 'id', path),
    accountExternalId: reqString(r, 'accountId', path),
    dueDate,
    closingDate: optDay(r, 'billClosingDate'),
    total: toCents(reqNumber(r, 'totalAmount', path)),
    minimumPayment: cents(minimum),
  };
}

export function dataArray(body: unknown, path: string): unknown[] {
  return asArray(asRecord(body, path).data, `${path}.data`);
}
