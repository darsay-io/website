-- A publication preview is a Hub fetch the board does not otherwise spend a
-- mutate on. It gets a daily budget of its own, counted like the others.
INSERT OR IGNORE INTO meta(key, value) VALUES
  ('previews_utc', '1970-01-01'),
  ('previews_n', '0');
