-- Conversations with the analyst. The question is saved before the model is called, so it survives a crash.

CREATE TABLE chat_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  -- JSON list of the tools the answer used: name, arguments and a short result summary.
  steps TEXT,
  model TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_chat_messages_conversation ON chat_messages (conversation_id, id);
