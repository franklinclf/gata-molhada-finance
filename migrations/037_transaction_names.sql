-- A name the owner gives a transaction ("Nome personalizado"), shown on screen instead of the standard one. The bank text stays
-- as it is, and it is what rules, the AI and the merchant grouping read. Keyed by source record like the other overrides, so it
-- survives rebuilds. For an installment purchase the name is written on the records of every installment seen, and the app shows
-- it on the whole series (the ones to come included) with the counter "2/5" added.
CREATE TABLE transaction_names (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);
