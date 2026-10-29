-- Detected recurring items the owner said are not recurring (a supermarket that happens to charge the same amount each month).

CREATE TABLE recurring_ignored (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
