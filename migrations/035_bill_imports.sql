-- Card statements the owner uploaded as PDF files. The lines become records of the source 'pdf' (source_transactions,
-- source_accounts, source_bills); these tables keep what ties them to the rest. Only the parsed lines and the file hash
-- are kept: never the file, its name, or the name, CPF or address printed on it.

-- Which card of another source each PDF card account is, as the owner confirmed it. Reconciliation places the PDF account
-- in that card's cluster before any overlap scoring, because sibling cards of one bank can share days and amounts.
CREATE TABLE bill_import_accounts (
  pdf_account_external_id TEXT PRIMARY KEY,
  target_source_id TEXT NOT NULL,
  target_source_account_external_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per statement applied. Applying the same statement again replaces its records and marks the older row
-- 'replaced'; "Desfazer importação" removes the records and marks it 'undone'.
CREATE TABLE bill_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash TEXT NOT NULL,
  -- source_bills.external_id of the statement, which is also parties.billId on every line of it.
  bill_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  due_date TEXT NOT NULL,
  closing_date TEXT,
  total INTEGER NOT NULL,
  -- JSON list of the last 4 digits of the cards on the statement.
  card_finals TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'text' CHECK (method IN ('text', 'vision')),
  -- JSON list of the typed-in transactions the owner removed because the statement brings them, put back on undo.
  removed_manual TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'replaced', 'undone')),
  applied_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_bill_imports_bill ON bill_imports (bill_id, status);
CREATE INDEX idx_source_transactions_bill ON source_transactions (source_id, bill_id);
