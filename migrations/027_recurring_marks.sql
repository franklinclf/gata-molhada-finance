-- What the owner says a charge is: a subscription, or some other recurring one (rent, a utility, a fee). The key is the
-- same as a detected recurring item's (direction and merchant), so the word covers every charge of that merchant, even
-- before the app has seen enough of them to detect it. "Not recurring" stays in recurring_ignored.
CREATE TABLE recurring_marks (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (label IN ('subscription', 'recurring')),
  updated_at TEXT NOT NULL
);
