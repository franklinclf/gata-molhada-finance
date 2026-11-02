-- A category the owner renamed, or merged into another: every transaction that would show the old name shows the new one.
-- It works for built-in, custom and source categories alike, because the name is replaced at the end, after the owner's
-- choices, the rules, the source table and the AI have said what the category is.
CREATE TABLE category_aliases (
  from_name TEXT PRIMARY KEY,
  to_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
