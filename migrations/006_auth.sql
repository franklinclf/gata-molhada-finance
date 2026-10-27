-- Single-user login. The password hash, the TOTP secret and the recovery code hashes come from the environment,
-- so only what changes at run time is stored here.

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Recovery codes that were already used (hash of the code).
CREATE TABLE auth_used_recovery (
  code_hash TEXT PRIMARY KEY,
  used_at TEXT NOT NULL
);

-- Key/value state, for example the last accepted TOTP counter (blocks reuse of a code).
CREATE TABLE auth_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
