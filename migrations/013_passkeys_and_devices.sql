-- Passkeys (WebAuthn) and trusted devices. Only the public half of a passkey is stored. A trusted device is a long-lived
-- token kept in a cookie; only its hash is stored, and it is replaced by a new one every time it is used.

CREATE TABLE auth_passkeys (
  credential_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE auth_devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  -- The token before the last rotation stays valid for a minute, so requests sent in parallel with the old cookie still work.
  prev_token_hash TEXT,
  rotated_at TEXT
);

-- How a session was started: password (password and code), passkey, or device (restored from a trusted-device cookie).
ALTER TABLE auth_sessions ADD COLUMN strength TEXT NOT NULL DEFAULT 'password';
ALTER TABLE auth_sessions ADD COLUMN device_id TEXT;
