// Synthetic payloads shaped like the Pluggy API responses. No real data.

export const pluggyBankAccount = {
  id: 'acc-bank-1',
  type: 'BANK',
  subtype: 'CHECKING_ACCOUNT',
  name: 'Conta Corrente',
  balance: 1523.45,
  currencyCode: 'BRL',
  itemId: 'item-1',
  number: '12345-6',
  marketingName: null,
  bankData: { transferNumber: '0001/12345-6', closingBalance: 1523.45 },
  creditData: null,
};

export const pluggyCardAccount = {
  id: 'acc-card-1',
  type: 'CREDIT',
  subtype: 'CREDIT_CARD',
  name: 'Cartao Exemplo',
  balance: 320.5,
  currencyCode: 'BRL',
  itemId: 'item-1',
  number: '1234',
  creditData: {
    creditLimit: 5000,
    availableCreditLimit: 4679.5,
    minimumPayment: 48.0825,
    balanceDueDate: '2026-11-10T00:00:00.000Z',
    balanceCloseDate: null,
  },
};

export const pluggyBankCredit = {
  id: 'tx-1',
  description: 'Pix recebido',
  descriptionRaw: 'Transferencia recebida',
  amount: 150,
  date: '2026-10-20T12:00:00.000Z',
  category: 'Transfer',
  status: 'POSTED',
  type: 'CREDIT',
  accountId: 'acc-bank-1',
  creditCardMetadata: null,
};

export const pluggyCardPurchase = {
  id: 'tx-2',
  description: 'Loja Exemplo 2/5',
  descriptionRaw: 'LOJA EXEMPLO 02/05',
  amount: 99.9,
  date: '2026-10-21T03:00:00.000Z',
  category: 'Shopping',
  status: 'PENDING',
  type: 'DEBIT',
  accountId: 'acc-card-1',
  creditCardMetadata: { installmentNumber: 2, totalInstallments: 5, cardNumber: '1234' },
};

export const pluggyCardPayment = {
  id: 'tx-3',
  description: 'Pagamento recebido',
  descriptionRaw: 'PAGAMENTO RECEBIDO',
  amount: -320,
  date: '2026-10-15T03:00:00.000Z',
  category: null,
  status: 'POSTED',
  type: 'CREDIT',
  accountId: 'acc-card-1',
  creditCardMetadata: null,
};

export const pluggyBill = {
  id: 'bill-1',
  dueDate: '2026-11-10T00:00:00.000Z',
  billClosingDate: '2026-11-03T00:00:00.000Z',
  totalAmount: 320.5,
  totalAmountCurrencyCode: 'BRL',
  minimumPaymentAmount: 48.08,
};

export const pluggyItem = {
  id: 'item-1',
  status: 'UPDATED',
  lastUpdatedAt: '2026-10-26T14:53:55.112Z',
};
