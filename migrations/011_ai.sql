-- What the AI proposed for a description. The key is the normalized description, the same key category rules use.
-- A "high" confidence answer is applied by itself (status applied); anything less waits as a suggestion for the user.
-- The user's own rules and per-transaction choices always win over this table.

CREATE TABLE ai_categories (
  match_key TEXT PRIMARY KEY,
  sample TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  taxonomy TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

-- Every model call that cost money, to keep to a monthly budget and to show what was spent.
CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  items INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  at TEXT NOT NULL,
  month TEXT NOT NULL
);
