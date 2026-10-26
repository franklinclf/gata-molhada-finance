-- Normalized records as each source reports them. The canonical, reconciled
-- model is built on top of these tables, so nothing here is merged across sources.

CREATE TABLE source_accounts (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  external_item_id TEXT,
  institution TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  last4 TEXT,
  balance INTEGER NOT NULL,
  credit_limit INTEGER,
  available_limit INTEGER,
  minimum_payment INTEGER,
  due_date TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE TABLE source_transactions (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  account_external_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT NOT NULL,
  description_raw TEXT,
  status TEXT NOT NULL,
  installment_number INTEGER,
  installment_total INTEGER,
  category TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE INDEX idx_source_transactions_account
  ON source_transactions (source_id, account_external_id, occurred_at);

CREATE TABLE source_bills (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  account_external_id TEXT NOT NULL,
  due_date TEXT NOT NULL,
  closing_date TEXT,
  total INTEGER NOT NULL,
  minimum_payment INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);
