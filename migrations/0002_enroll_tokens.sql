CREATE TABLE enroll_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX idx_enroll_user ON enroll_tokens(user_id);
CREATE INDEX idx_enroll_exp ON enroll_tokens(expires_at);
