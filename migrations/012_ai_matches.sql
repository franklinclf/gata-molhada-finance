-- The model's opinion on each "may be the same transaction" suggestion, and what the app did about it.
-- action: joined (the app joined them by itself, the user can separate), dismissed (clearly different),
-- suggested (the user decides), undone (the user separated a join the app made; never joined again).

CREATE TABLE ai_matches (
  finding_id TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  confidence TEXT NOT NULL,
  action TEXT NOT NULL,
  model TEXT NOT NULL,
  sample_a TEXT NOT NULL,
  sample_b TEXT NOT NULL,
  source_a TEXT NOT NULL,
  external_a TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

ALTER TABLE manual_links ADD COLUMN made_by TEXT NOT NULL DEFAULT 'user';
