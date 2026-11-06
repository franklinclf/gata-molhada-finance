-- Fixed income the owner registers (a monthly salary, say), used by the forecast to say what is left after the card bills.
CREATE TABLE income_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  from_month TEXT,
  until_month TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
