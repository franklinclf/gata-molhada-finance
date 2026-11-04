import type { Cents } from '../core/money.ts';
import { localDay } from '../core/time.ts';
import { dayNumber } from '../core/dates.ts';
import { normalizeName } from '../core/names.ts';
import type { EffectiveTransaction } from './scope.ts';
import { ruleKey } from './scope.ts';

/** A purchase and the money that came back for it, shown as one entry. Both sides carry the same fact. */
export interface Reversal {
  /** `charge` is the original purchase (money out), `refund` is the credit that returned the money. */
  side: 'charge' | 'refund';
  otherId: string;
  /** The day of the other side. */
  otherDay: string;
  /** What was given back, always positive. */
  amount: Cents;
  /** Less came back than was paid. */
  partial: boolean;
  /** The owner linked them by hand. False when the app paired them. */
  byUser: boolean;
}

export interface ReversalLink {
  chargeId: string;
  refundId: string;
  linked: boolean;
}

/** Words that mean a credit is money returned. */
const EXPLICIT = /estorn|devolu|reembols|cancel|refund|chargeback/i;
/** A credit that says "estorno" can come long after the purchase; one that says nothing must come right away (a held amount released). */
const EXPLICIT_DAYS = 120;
const PARTIAL_DAYS = 60;
const IMPLICIT_DAYS = 7;

const words = (text: string): Set<string> => new Set(normalizeName(text).split(' ').filter((w) => w.length >= 4));

/**
 * Pairs each refund with the purchase it returned. The owner's links come first. The rest is automatic and careful: a
 * credit that says it is a reversal ("estorno", "devolução", "cancelamento") takes the latest purchase of the same
 * account for exactly that amount, or (for less) one that shares a word with it. A credit that says nothing is paired only with a
 * purchase of the same account, the same text and the same amount in the days before, which is how a held amount is released.
 * Transfers between people and anything with a role (card payments, own transfers, investments) are never paired by guess.
 */
export function pairReversals(rows: EffectiveTransaction[], links: ReversalLink[]): Map<string, Reversal> {
  const byId = new Map(rows.map((t) => [t.id, t]));
  const out = new Map<string, Reversal>();
  const forbidden = new Set<string>();
  const pair = (charge: EffectiveTransaction, refund: EffectiveTransaction, byUser: boolean) => {
    const amount = Math.min(-charge.amount, refund.amount);
    const partial = refund.amount < -charge.amount;
    out.set(charge.id, { side: 'charge', otherId: refund.id, otherDay: localDay(refund.occurredAt), amount, partial, byUser });
    out.set(refund.id, { side: 'refund', otherId: charge.id, otherDay: localDay(charge.occurredAt), amount, partial, byUser });
  };

  for (const l of links) {
    if (!l.linked) {
      forbidden.add(`${l.chargeId}|${l.refundId}`);
      continue;
    }
    const charge = byId.get(l.chargeId);
    const refund = byId.get(l.refundId);
    if (charge && refund && charge.amount < 0 && refund.amount > 0 && !out.has(charge.id) && !out.has(refund.id)) pair(charge, refund, true);
  }

  const free = (t: EffectiveTransaction) => !out.has(t.id) && !t.excluded && t.role === null;
  const credits = rows.filter((t) => t.amount > 0 && free(t)).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const debitsOf = new Map<string, EffectiveTransaction[]>();
  for (const t of rows) if (t.amount < 0 && t.role === null && !t.excluded) debitsOf.set(t.accountId, [...(debitsOf.get(t.accountId) ?? []), t]);

  const find = (credit: EffectiveTransaction, accept: (d: EffectiveTransaction, daysBefore: number) => boolean): EffectiveTransaction | null => {
    const creditDay = dayNumber(localDay(credit.occurredAt));
    const options = (debitsOf.get(credit.accountId) ?? [])
      .filter((d) => !out.has(d.id) && !forbidden.has(`${d.id}|${credit.id}`))
      .map((d) => ({ d, before: creditDay - dayNumber(localDay(d.occurredAt)) }))
      .filter((o) => o.before >= 0 && accept(o.d, o.before))
      .sort((a, b) => a.before - b.before || b.d.occurredAt.localeCompare(a.d.occurredAt));
    return options[0]?.d ?? null;
  };

  const personal = (t: EffectiveTransaction) => /^(pix|ted)$/i.test(t.operation ?? '');
  // 1. Credits that say they are a reversal, for the exact amount.
  for (const credit of credits) {
    if (out.has(credit.id) || !EXPLICIT.test(`${credit.description} ${credit.sourceLabels.join(' ')}`)) continue;
    const match = find(credit, (d, before) => before <= EXPLICIT_DAYS && -d.amount === credit.amount);
    if (match) pair(match, credit, false);
  }
  // 2. Credits that say nothing, for the same text and amount a few days before (a hold released). Never a transfer between people.
  for (const credit of credits) {
    if (out.has(credit.id) || personal(credit)) continue;
    const key = ruleKey(credit.description);
    if (key === '') continue;
    const match = find(credit, (d, before) => before <= IMPLICIT_DAYS && -d.amount === credit.amount && ruleKey(d.description) === key && !personal(d));
    if (match) pair(match, credit, false);
  }
  // 3. Credits that say they are a reversal, for less than the purchase: partial refund of a purchase that shares a word with it.
  for (const credit of credits) {
    if (out.has(credit.id) || !EXPLICIT.test(`${credit.description} ${credit.sourceLabels.join(' ')}`)) continue;
    const wanted = words(credit.description);
    const match = find(credit, (d, before) => before <= PARTIAL_DAYS && -d.amount > credit.amount && [...words(d.description)].some((w) => wanted.has(w)));
    if (match) pair(match, credit, false);
  }
  return out;
}
