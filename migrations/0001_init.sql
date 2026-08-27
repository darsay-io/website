CREATE TABLE boards (
  id          TEXT PRIMARY KEY,
  catalog_id  TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  curator     TEXT,
  note        TEXT,
  created     TEXT NOT NULL,
  updated     TEXT NOT NULL
);

CREATE TABLE entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  revision      TEXT NOT NULL DEFAULT '',
  include_json  TEXT,
  include_key   TEXT NOT NULL,
  desire        INTEGER,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'want'
                  CHECK (status IN ('want', 'have')),
  holders       TEXT NOT NULL DEFAULT '',
  added         TEXT NOT NULL,
  payload_bytes INTEGER,
  estimate_json TEXT,
  UNIQUE (board_id, source, revision, include_key)
);

CREATE INDEX idx_entries_board ON entries(board_id);
CREATE INDEX idx_entries_board_desire ON entries(board_id, desire);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta(key, value) VALUES
  ('schema', '1'),
  ('creates_utc', '1970-01-01'),
  ('creates_n', '0'),
  ('mutates_utc', '1970-01-01'),
  ('mutates_n', '0'),
  ('lookups_utc', '1970-01-01'),
  ('lookups_n', '0');
