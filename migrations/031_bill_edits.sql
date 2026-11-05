-- What the owner says about one card bill, over what the issuer published and what the app derives: its total, its closing and
-- due dates, and whether it is paid. A null column means "no opinion". Keyed by the canonical card and the due month of the bill.
CREATE TABLE bill_edits (
  account_id TEXT NOT NULL,
  cycle_key TEXT NOT NULL,
  total INTEGER,
  closing_date TEXT,
  due_date TEXT,
  status TEXT CHECK (status IS NULL OR status IN ('paid', 'unpaid')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, cycle_key)
);
