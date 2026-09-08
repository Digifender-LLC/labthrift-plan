CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE labs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'My lab',
  inventory_json TEXT NOT NULL DEFAULT '[]',
  checklist_json TEXT NOT NULL DEFAULT '{}',
  closet_json TEXT NOT NULL DEFAULT '{}',
  hosts_json TEXT NOT NULL DEFAULT '[]',
  bom_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  username TEXT,
  user_id TEXT,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_passkeys_user ON passkeys(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_challenges_exp ON webauthn_challenges(expires_at);
