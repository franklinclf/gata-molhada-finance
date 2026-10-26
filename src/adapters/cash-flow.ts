import type { Cents } from '../core/money.ts';
import { toCents } from '../core/money.ts';
import type { AccountKind } from '../core/types.ts';

/**
 * Converts a source amount to cash-flow sign: money leaving the user is negative.
 * Bank accounts already use that sign. Credit cards report purchases as positive
 * and payments as negative, so they are flipped.
 */
export function toCashFlow(kind: AccountKind, amount: number): Cents {
  const cents = toCents(amount);
  if (kind !== 'credit_card') return cents;
  return cents === 0 ? 0 : -cents;
}

export function toStatus(value: string): 'pending' | 'posted' | null {
  if (value === 'POSTED') return 'posted';
  if (value === 'PENDING') return 'pending';
  return null;
}
