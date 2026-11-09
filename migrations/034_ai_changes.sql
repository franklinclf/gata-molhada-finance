-- What the analyst changed in the owner's data, or asked to change and is waiting for a tap. One row per write tool call.
-- before_json and after_json hold the exact values read around the change (keyed by source record, not by canonical
-- transaction id, because those ids are rebuilt), so "Desfazer" can put the old values back and refuse when the data moved on.

CREATE TABLE ai_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id),
  -- Null until the assistant answer of the turn is saved.
  message_id INTEGER REFERENCES chat_messages(id),
  tool TEXT NOT NULL,
  label TEXT NOT NULL,
  count INTEGER NOT NULL,
  -- The arguments as the code resolved them (records instead of the short handles the model used), so a pending change can be planned again.
  args_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('applied', 'undone', 'pending', 'declined', 'expired', 'conflict')),
  destructive INTEGER NOT NULL DEFAULT 0,
  undoable INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_ai_changes_conversation ON ai_changes (conversation_id, id);
