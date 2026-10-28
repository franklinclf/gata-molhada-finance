import { createHash } from 'node:crypto';

/** One side of a payment. The document is kept as a hash (to tell people apart) and its last four digits (to show). */
export interface Party {
  name: string | null;
  hash: string | null;
  last4: string | null;
  /** CPF means a person and CNPJ a company. */
  kind: 'person' | 'company' | null;
}

/** What a source says about a transaction besides amount and text. Absent fields are null. */
export interface Parties {
  /** The kind of operation the source reports (PIX, TED, BOLETO ...). */
  operation: string | null;
  /** Merchant category code of a card purchase. */
  mcc: string | null;
  payer: Party | null;
  receiver: Party | null;
}

/** A party from a name and a document as written by the source ("123.456.789-00"). Null when there is neither. */
export function partyFrom(name: string | null, document: string | null, type: string | null = null): Party | null {
  const digits = (document ?? '').replace(/\D/g, '');
  if (name === null && digits.length < 11) return null;
  return {
    name,
    hash: digits.length >= 11 ? createHash('sha256').update(`gmf-document:${digits}`).digest('hex').slice(0, 24) : null,
    last4: digits.length >= 11 ? digits.slice(-4) : null,
    kind: type === 'CNPJ' || digits.length === 14 ? 'company' : type === 'CPF' || digits.length === 11 ? 'person' : null,
  };
}

/** Parties from the fields a source sends, or undefined when it sent none (so records without them stay as they were). */
export function partiesFrom(input: { operation: string | null; mcc: string | null; payer: Party | null; receiver: Party | null }): Parties | undefined {
  return input.operation === null && input.mcc === null && input.payer === null && input.receiver === null ? undefined : input;
}
