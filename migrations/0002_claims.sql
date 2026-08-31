-- Board-side coordination: which client is fetching a row, and how far
-- along. Written by POST /api/boards/:id/entries/:eid/claim; never part
-- of the catalog.json export.
ALTER TABLE entries ADD COLUMN claim_json TEXT;
