-- Transactions the owner types in because no source reports them (a charge on a card the bank does not send, a cash payment).
-- They are added to the canonical transactions after the sources are matched, and never touched by a sync.

CREATE TABLE manual_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount != 0),
  description TEXT NOT NULL,
  category TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_manual_transactions_account ON manual_transactions (account_id, day);
