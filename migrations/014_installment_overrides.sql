-- The user's word on which installment a card charge is ("3 of 3"), for charges the sources deliver without that
-- information. Keyed by source record so it survives rebuilds.

CREATE TABLE installment_overrides (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  total INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);
