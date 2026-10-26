-- Canonical accounts: one row per real-world account, built from the source_* tables.
-- These rows are derived data, rebuilt by the account reconciliation.

CREATE TABLE limit_groups (
  id TEXT PRIMARY KEY,
  institution TEXT NOT NULL,
  credit_limit INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  institution TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  last4 TEXT,
  balance INTEGER NOT NULL,
  balance_source_id TEXT,
  balance_as_of TEXT,
  credit_limit INTEGER,
  available_limit INTEGER,
  minimum_payment INTEGER,
  due_date TEXT,
  limit_group_id TEXT REFERENCES limit_groups(id),
  built_at TEXT NOT NULL
);

CREATE TABLE account_source_refs (
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

CREATE INDEX idx_account_source_refs_account ON account_source_refs (account_id);
