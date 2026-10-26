import type { AccountKind, SourceAccount, SourceBill, SourceTransaction } from '../../core/types.ts';
import { SourceFormatError } from '../../core/http.ts';
import { toCents } from '../../core/money.ts';
import { toCashFlow, toStatus } from '../cash-flow.ts';
import { asRecord, optDay, optNumber, optString, reqIsoInstant, reqNumber, reqString, UnsupportedAccountError } from '../shape.ts';

function kindOf(type: string, subtype: string, path: string): AccountKind {
  if (type === 'BANK' && subtype === 'CHECKING_ACCOUNT') return 'checking';
  if (type === 'BANK' && subtype === 'SAVINGS_ACCOUNT') return 'savings';
  if (type === 'CREDIT' && subtype === 'CREDIT_CARD') return 'credit_card';
  throw new UnsupportedAccountError(`${path}: unsupported account type ${type}/${subtype}`);
}

/** `institution` is the label the user gave the item, since MeuPluggy items hide the real bank name. */
export function normalizeAccount(raw: unknown, institution: string): SourceAccount {
  const path = 'pluggy.account';
  const r = asRecord(raw, path);
  const kind = kindOf(reqString(r, 'type', path), reqString(r, 'subtype', path), path);
  const credit = r.creditData === null || r.creditData === undefined ? null : asRecord(r.creditData, `${path}.creditData`);
  const limit = credit ? optNumber(credit, 'creditLimit') : null;
  const available = credit ? optNumber(credit, 'availableCreditLimit') : null;
  const minimum = credit ? optNumber(credit, 'minimumPayment') : null;

  return {
    externalId: reqString(r, 'id', path),
    externalItemId: optString(r, 'itemId'),
    institution,
    kind,
    name: reqString(r, 'name', path),
    last4: kind === 'credit_card' ? optString(r, 'number') : null,
    balance: toCents(reqNumber(r, 'balance', path)),
    creditLimit: limit === null ? null : toCents(limit),
    availableLimit: available === null ? null : toCents(available),
    minimumPayment: minimum === null ? null : toCents(minimum),
    dueDate: credit ? optDay(credit, 'balanceDueDate') : null,
  };
}

export function normalizeTransaction(raw: unknown, kind: AccountKind): SourceTransaction {
  const path = 'pluggy.transaction';
  const r = asRecord(raw, path);
  const rawStatus = reqString(r, 'status', path);
  const status = toStatus(rawStatus);
  if (status === null) throw new SourceFormatError(`${path}.status: unsupported value ${rawStatus}`);

  let installment: SourceTransaction['installment'] = null;
  if (r.creditCardMetadata !== null && r.creditCardMetadata !== undefined) {
    const meta = asRecord(r.creditCardMetadata, `${path}.creditCardMetadata`);
    const number = optNumber(meta, 'installmentNumber');
    const total = optNumber(meta, 'totalInstallments');
    if (number !== null && total !== null) installment = { number, total };
  }

  return {
    externalId: reqString(r, 'id', path),
    accountExternalId: reqString(r, 'accountId', path),
    occurredAt: reqIsoInstant(r, 'date', path),
    amount: toCashFlow(kind, reqNumber(r, 'amount', path)),
    description: reqString(r, 'description', path),
    descriptionRaw: optString(r, 'descriptionRaw'),
    status,
    installment,
    category: optString(r, 'category'),
  };
}

export function normalizeBill(raw: unknown, accountExternalId: string): SourceBill {
  const path = 'pluggy.bill';
  const r = asRecord(raw, path);
  const minimum = optNumber(r, 'minimumPaymentAmount');
  const dueDate = optDay(r, 'dueDate');
  if (dueDate === null) throw new SourceFormatError(`${path}.dueDate: expected a date`);
  return {
    externalId: reqString(r, 'id', path),
    accountExternalId,
    dueDate,
    closingDate: optDay(r, 'billClosingDate'),
    total: toCents(reqNumber(r, 'totalAmount', path)),
    minimumPayment: minimum === null ? null : toCents(minimum),
  };
}
