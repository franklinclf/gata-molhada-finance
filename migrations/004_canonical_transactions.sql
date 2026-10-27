-- Canonical transactions and reconciliation findings, derived from the source_* tables.
-- transactions.account_id points at accounts.id but has no foreign key: both tables are
-- rebuilt together by the reconciliation, and accounts can be rebuilt on their own.

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT NOT NULL,
  description_raw TEXT,
  status TEXT NOT NULL,
  installment_number INTEGER,
  installment_total INTEGER,
  category TEXT,
  state TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0,
  built_at TEXT NOT NULL
);

CREATE INDEX idx_transactions_account ON transactions (account_id, occurred_at);

CREATE TABLE transaction_links (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  match_pass INTEGER NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE INDEX idx_transaction_links_transaction ON transaction_links (transaction_id);

-- A finding keeps its id while the same problem persists, so a rerun updates it instead of duplicating it.
CREATE TABLE reconciliation_findings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  account_id TEXT,
  transaction_id TEXT,
  summary TEXT NOT NULL,
  details TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT
);
