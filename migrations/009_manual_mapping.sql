-- Choices the user makes to fix what the automatic matching got wrong. Keyed by source record, because canonical
-- transaction ids are rebuilt on each reconciliation while source records keep their identity.

CREATE TABLE manual_links (
  source_a TEXT NOT NULL,
  external_a TEXT NOT NULL,
  source_b TEXT NOT NULL,
  external_b TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_a, external_a, source_b, external_b)
);

CREATE TABLE ignored_records (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  ignored_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);

-- Suggestions the user answered with "this is not the same transaction".
CREATE TABLE dismissed_findings (
  finding_id TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL
);
