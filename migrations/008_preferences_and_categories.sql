-- User choices that survive a rebuild of the canonical data.
-- Accounts are keyed by canonical account id; category overrides by source record, because canonical
-- transaction ids are rebuilt on each reconciliation while source records keep their identity.

CREATE TABLE account_prefs (
  account_id TEXT PRIMARY KEY,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Categories the user created (the ones that come from the sources are read from the transactions).
CREATE TABLE custom_categories (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- One transaction recategorized by hand. Written for every source record of the transaction.
CREATE TABLE category_overrides (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  category TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

-- "Always put this description in this category". match_key is the normalized description.
CREATE TABLE category_rules (
  match_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
