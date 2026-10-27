import type { SourceAccount, SourceTransaction } from '../../src/core/types.ts';
import type { CanonicalAccount } from '../../src/core/canonical.ts';
import type { SourceView } from '../../src/reconcile/types.ts';
import type { TransactionSource } from '../../src/reconcile/transactions.ts';

export function account(overrides: Partial<SourceAccount> = {}): SourceAccount {
  return {
    externalId: 'acc-1',
    externalItemId: null,
    institution: 'Bank A',
    kind: 'checking',
    name: 'Conta Corrente',
    last4: null,
    balance: 100000,
    creditLimit: null,
    availableLimit: null,
    minimumPayment: null,
    dueDate: null,
    ...overrides,
  };
}

export function card(overrides: Partial<SourceAccount> = {}): SourceAccount {
  return account({
    externalId: 'card-1',
    kind: 'credit_card',
    name: 'Cartao Exemplo',
    last4: '1234',
    balance: 30000,
    creditLimit: 500000,
    availableLimit: 470000,
    ...overrides,
  });
}

export function tx(overrides: Partial<SourceTransaction> = {}): SourceTransaction {
  return {
    externalId: 'tx-1',
    accountExternalId: 'acc-1',
    occurredAt: '2026-10-20T12:00:00.000Z',
    amount: -1990,
    description: 'Coffee',
    descriptionRaw: 'COFFEE SHOP',
    status: 'posted',
    installment: null,
    category: null,
    ...overrides,
  };
}

/** Several transactions on distinct days, enough to make two accounts recognizably the same one. */
export function history(accountExternalId: string, idPrefix: string, count = 4): SourceTransaction[] {
  return Array.from({ length: count }, (_, i) =>
    tx({
      externalId: `${idPrefix}-${i}`,
      accountExternalId,
      occurredAt: `2026-10-${String(10 + i).padStart(2, '0')}T12:00:00.000Z`,
      amount: -(1000 + i * 111),
      descriptionRaw: `SHOP ${i}`,
    }),
  );
}

export function view(
  sourceId: string,
  priority: number,
  data: Partial<Pick<SourceView, 'accounts' | 'transactions' | 'freshness'>> = {},
): SourceView {
  return { sourceId, priority, accounts: [], transactions: [], freshness: [], ...data };
}

export function fresh(sourceId: string, institution: string, lastUpdatedAt: string) {
  return { sourceId, institution, lastUpdatedAt, observedAt: lastUpdatedAt };
}


export function canonical(overrides: Partial<CanonicalAccount> = {}): CanonicalAccount {
  return {
    id: 'acc_test',
    institution: 'Bank A',
    kind: 'checking',
    name: 'Conta Corrente',
    last4: null,
    balance: 0,
    balanceSourceId: 'pierre',
    balanceAsOf: null,
    creditLimit: null,
    availableLimit: null,
    minimumPayment: null,
    dueDate: null,
    limitGroupId: null,
    refs: [
      { sourceId: 'pierre', externalId: 'p1', role: 'member' },
      { sourceId: 'pluggy', externalId: 'g1', role: 'member' },
    ],
    ...overrides,
  };
}

export function txSource(
  sourceId: string,
  priority: number,
  transactions: TransactionSource['transactions'] = [],
  freshness: TransactionSource['freshness'] = [],
): TransactionSource {
  return { sourceId, priority, transactions, freshness };
}
