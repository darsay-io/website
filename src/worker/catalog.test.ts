import { describe, expect, it } from "vitest";
import { CATALOG_TOP_KEYS, DIGEST_KEYS, entryToApi, exportCatalog } from "./catalog.ts";

describe("exportCatalog", () => {
	it("emits schema 1.0.0 without holders, status, or board id", () => {
		const cat = exportCatalog(
			{
				id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				catalog_id: "summer",
				title: "Summer 2026",
				curator: "Alex",
				note: "keep these",
				created: "2026-08-26T18:00:00+00:00",
				updated: "2026-08-26T18:10:00+00:00",
			},
			[
				{
					id: 42,
					source: "huggingface:Qwen/Qwen3-0.6B",
					revision: "",
					include_json: JSON.stringify(["*.gguf", "tokenizer*"]),
					desire: 9,
					note: "the small one",
					status: "have",
					holders: "Maya, USB in Berlin",
					added: "2026-08-26T18:04:11+00:00",
					payload_bytes: 100,
					estimate_json: JSON.stringify({
						as_of: "2026-08-26T18:04:11+00:00",
						artifact_type: "model",
						revision: "abc",
						revision_ref: "main",
						payload_bytes: 100,
						file_count: 3,
						license: "apache-2.0",
						gated: false,
						parameters: 1,
						dominant_dtype: "BF16",
						unknown_size_count: 0,
						extra: "drop me",
					}),
				},
			],
		);
		expect(Object.keys(cat).sort()).toEqual([...CATALOG_TOP_KEYS].sort());
		expect(JSON.stringify(cat)).not.toContain("holders");
		expect(JSON.stringify(cat)).not.toContain("aaaaaaaa");
		expect(JSON.stringify(cat)).not.toMatch(/"status"/);
		const entry = (cat.entries as Array<Record<string, unknown>>)[0];
		expect(entry.include).toEqual(["*.gguf", "tokenizer*"]);
		expect(entry.desire).toBe(9);
		const est = entry.estimate as Record<string, unknown>;
		for (const k of Object.keys(est)) expect(DIGEST_KEYS).toContain(k);
		expect(est.extra).toBeUndefined();
		expect("artifact_type" in entry).toBe(false);
	});
});

describe("entryToApi", () => {
	it("exposes artifact_type from the estimate, else the source grammar", () => {
		const base = {
			id: 1,
			source: "huggingface:datasets/acme/reviews",
			revision: "",
			include_json: null,
			desire: 3,
			note: null,
			status: "want",
			holders: "",
			added: "2026-08-26T18:04:11+00:00",
			payload_bytes: 10,
			estimate_json: null,
		};
		expect(entryToApi(base).artifact_type).toBe("dataset");
		expect(
			entryToApi({
				...base,
				source: "huggingface:acme/reviews",
				estimate_json: JSON.stringify({ artifact_type: "dataset" }),
			}).artifact_type,
		).toBe("dataset");
	});
});
