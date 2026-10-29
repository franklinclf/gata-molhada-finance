-- Savings goals. A goal follows an amount: typed by hand, the balance of one account, a manual asset, or the net worth.
-- `initial` is where the goal started, so progress is measured from there and not from zero.

CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  target INTEGER NOT NULL CHECK (target > 0),
  target_day TEXT,
  track TEXT NOT NULL CHECK (track IN ('manual', 'account', 'asset', 'networth')),
  track_ref TEXT,
  saved INTEGER NOT NULL DEFAULT 0,
  initial INTEGER NOT NULL DEFAULT 0,
  created_day TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
