-- What the owner corrected on a detected expense in the list of repeating bills: the name shown, the expected amount (cents) and the
-- day of the month. The key is the same as in recurring_marks. A null column keeps what the app detected.
CREATE TABLE recurring_overrides (
  key TEXT PRIMARY KEY,
  name TEXT,
  amount INTEGER CHECK (amount IS NULL OR amount > 0),
  day_of_month INTEGER CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 31)),
  updated_at TEXT NOT NULL
);
