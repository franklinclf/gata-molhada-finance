-- The user's word on a card bill: settled (a leftover that was never charged) or still owed. Keyed by the canonical
-- card id and the due month of the bill.

CREATE TABLE cycle_overrides (
  account_id TEXT NOT NULL,
  cycle_key TEXT NOT NULL,
  settled INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, cycle_key)
);
