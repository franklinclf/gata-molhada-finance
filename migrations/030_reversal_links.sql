-- What the owner says about a charge and its refund: that they are one reversed purchase (linked = 1), or that the app's guess
-- is wrong and they are not (linked = 0). Keyed by the source record of each side, like the other choices, so it survives rebuilds.
CREATE TABLE reversal_links (
  charge_source TEXT NOT NULL,
  charge_external TEXT NOT NULL,
  refund_source TEXT NOT NULL,
  refund_external TEXT NOT NULL,
  linked INTEGER NOT NULL CHECK (linked IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (charge_source, charge_external, refund_source, refund_external)
);
