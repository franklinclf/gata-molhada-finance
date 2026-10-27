-- App settings shared by every device, for example the dashboard layout. Values are JSON text.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
