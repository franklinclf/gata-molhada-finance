CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  capabilities TEXT NOT NULL DEFAULT '{}',
  added_at TEXT NOT NULL
);

CREATE TABLE raw_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  endpoint TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX idx_raw_snapshots_lookup ON raw_snapshots (source_id, endpoint, fetched_at DESC, id DESC);

CREATE TABLE freshness (
  source_id TEXT NOT NULL REFERENCES sources(id),
  institution TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (source_id, institution)
);
