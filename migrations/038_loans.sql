-- A personal loan the owner registered by hand, paid in monthly debits from a bank account. Pluggy returns no loan data, so the
-- schedule is computed from these fields and each installment is matched to a debit on the account. Amounts are in cents, days are
-- YYYY-MM-DD. interest_manual_id is the manual transaction that holds the interest (total - principal) on the day the cash came in.
CREATE TABLE loans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  principal INTEGER NOT NULL CHECK (principal > 0),
  total INTEGER NOT NULL CHECK (total >= principal),
  installments INTEGER NOT NULL CHECK (installments BETWEEN 1 AND 120),
  first_due TEXT NOT NULL,
  taken_on TEXT NOT NULL,
  interest_manual_id INTEGER,
  created_at TEXT NOT NULL
);
