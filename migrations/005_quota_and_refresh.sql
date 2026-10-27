-- Every distinct "last synced" time a source reports for an institution is one bank read.
-- Both sources read the same banks, so the monthly bank limit is shared between them.

ALTER TABLE freshness ADD COLUMN quota_exhausted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE quota_events (
  source_id TEXT NOT NULL REFERENCES sources(id),
  institution_key TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  month TEXT NOT NULL,
  PRIMARY KEY (source_id, institution_key, last_updated_at)
);

CREATE INDEX idx_quota_events_month ON quota_events (month, institution_key);

CREATE TABLE refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  requested_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
