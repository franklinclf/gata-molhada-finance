-- Rules that set a category from conditions on a transaction (text, amount, date, account, merchant code ...).
-- Lower priority runs first and the first rule that gives a category wins. Conditions and actions are JSON.

CREATE TABLE rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  priority INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  conditions TEXT NOT NULL,
  actions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
