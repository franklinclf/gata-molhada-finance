-- The group a category sits in ("Aluguel" inside "Casa"). A row overrides the built-in grouping; an empty parent means
-- "no group", which takes a built-in category out of its default group.

CREATE TABLE category_parents (
  category TEXT PRIMARY KEY,
  parent TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
