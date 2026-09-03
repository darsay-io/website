-- The board, for programs. Every write bumps the board's revision (the
-- ETag agents send back as If-Match); every row remembers when it last
-- changed and whether it was dropped (a soft removal a program — or the
-- person who clicked — can undo). Keys are the board URL narrowed to a
-- few scopes; the audit trail is who did what, with before and after;
-- idempotency rows let a retried request answer the same way twice;
-- webhooks tell a listener the moment a row moves.
ALTER TABLE boards ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN updated TEXT;
ALTER TABLE entries ADD COLUMN dropped TEXT;

CREATE TABLE keys (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  scopes     TEXT NOT NULL,
  created    TEXT NOT NULL,
  last_used  TEXT
);
CREATE INDEX idx_keys_board ON keys(board_id);

CREATE TABLE audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  actor_json  TEXT NOT NULL,
  action      TEXT NOT NULL,
  entry_id    INTEGER,
  before_json TEXT,
  after_json  TEXT,
  revision    INTEGER NOT NULL
);
CREATE INDEX idx_audit_board ON audit(board_id, id);

CREATE TABLE idempotency (
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status      INTEGER NOT NULL,
  body        TEXT NOT NULL,
  created     TEXT NOT NULL,
  PRIMARY KEY (board_id, key)
);

CREATE TABLE webhooks (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  events      TEXT NOT NULL,
  secret      TEXT NOT NULL,
  created     TEXT NOT NULL,
  last_at     TEXT,
  last_status INTEGER
);
CREATE INDEX idx_webhooks_board ON webhooks(board_id);
