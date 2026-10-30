-- What the owner says about one transaction that a source gets wrong: whether it is pending or posted, and which
-- card bill it belongs to (the due month, YYYY-MM). Keyed by source record like the other overrides, so it survives
-- rebuilds. A null column means "no opinion".
CREATE TABLE transaction_overrides (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  status TEXT CHECK (status IS NULL OR status IN ('pending', 'posted')),
  cycle_key TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);
