-- Estimates always state what their bytes cover. Reprice cached facts
-- from upstream; row addresses, curation, holders, and claims are retained.
UPDATE boards SET revision = revision + 1
WHERE id IN (SELECT board_id FROM entries WHERE estimate_json IS NOT NULL OR payload_bytes IS NOT NULL);
UPDATE entries SET estimate_json = NULL, payload_bytes = NULL;
-- A retry must not replay an obsolete row or catalog response.
DELETE FROM idempotency;
