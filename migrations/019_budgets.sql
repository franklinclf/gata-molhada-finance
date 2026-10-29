-- Spending limits per category or per category group. One row per target and month. A row marked recurring applies to its
-- month and to the months after it, until a later row. A row that is not recurring applies to its month only.

CREATE TABLE budgets (
  scope TEXT NOT NULL CHECK (scope IN ('category', 'group')),
  name TEXT NOT NULL,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  recurring INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, name, month)
);
