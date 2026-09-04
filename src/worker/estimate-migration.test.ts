import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("estimate scope migration", () => {
	it("invalidates cached facts and retries, retaining addresses, curation, and claims", () => {
		const db = new DatabaseSync(":memory:");
		try {
			for (const name of ["0001_init.sql", "0002_claims.sql", "0003_agents.sql"]) db.exec(readFileSync(`migrations/${name}`, "utf8"));
			db.prepare("INSERT INTO boards(id, catalog_id, created, updated, revision) VALUES('a', 'summer', 'now', 'now', 5)").run();
			db.prepare("INSERT INTO entries(board_id, source, include_key, added, desire, status, holders, note, payload_bytes, estimate_json, claim_json) VALUES('a','huggingface:a/b','[]','now',9,'have','SSD','keep',123,'{}','{\"client\":\"collector\"}')").run();
			db.prepare("INSERT INTO idempotency VALUES('a','request','fingerprint',200,'{\"payload_bytes\":123}','now')").run();
			db.exec(readFileSync("migrations/0004_estimate_scope.sql", "utf8"));
			expect(db.prepare("SELECT revision FROM boards WHERE id='a'").get()).toMatchObject({ revision: 6 });
			expect(db.prepare("SELECT * FROM entries").get()).toMatchObject({ source: "huggingface:a/b", desire: 9, status: "have", holders: "SSD", note: "keep", payload_bytes: null, estimate_json: null, claim_json: '{"client":"collector"}' });
			expect(db.prepare("SELECT * FROM idempotency").all()).toEqual([]);
		} finally { db.close(); }
	});
});
