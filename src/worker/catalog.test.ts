import { describe, expect, it } from "vitest";
import { CATALOG_TOP_KEYS, DIGEST_KEYS, entryToApi, exportCatalog, liveClaim, parseClaim } from "./catalog.ts";

describe("exportCatalog", () => {
	it("emits schema 2.0.0 without holders, status, claims, or board id", () => {
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
					claim_json: JSON.stringify({ client: "jeremy-mbp", state: "archiving" }),
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
						hints: ["large", "redundant"],
						policy: "negatives",
						precision: "BF16",
						bytes_per_param: 2.0,
						architecture: "qwen3",
						parents: [{ source: "huggingface:Qwen/Qwen3-0.6B-Base", relation: "finetune", declared_by: "tag" }],
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
		expect(est.hints).toEqual(["large", "redundant"]);
		expect(est.policy).toBe("negatives");
		expect(est.precision).toBe("BF16");
		expect(est.parents).toEqual([{ source: "huggingface:Qwen/Qwen3-0.6B-Base", relation: "finetune" }]);
		expect(JSON.stringify(cat)).not.toContain("claim");
		expect((cat as Record<string, unknown>).catalog_schema_version).toBe("2.0.0");
		expect("artifact_type" in entry).toBe(false);
	});
});

describe("sanitizeDigest", () => {
	it("projects DIGEST_KEYS, drops bad leaves, never invents", async () => {
		const { sanitizeDigest } = await import("./catalog.ts");
		expect(sanitizeDigest(null)).toBeNull();
		expect(sanitizeDigest([1])).toBeNull();
		expect(sanitizeDigest({})).toBeNull();
		const out = sanitizeDigest({
			payload_bytes: 55_586_114_863,
			hints: ["redundant", 7, "x".repeat(99)],
			policy: "negatives",
			parents: [{ source: "huggingface:Qwen/Qwen3.8-27B", relation: 7 }, { relation: "x" }, "junk"],
			bytes_per_param: 8.628,
			extra: "drop me",
			license: null,
		}) as Record<string, unknown>;
		expect(out.payload_bytes).toBe(55_586_114_863);
		expect(out.hints).toEqual(["redundant"]);
		expect(out.policy).toBe("negatives");
		expect(out.parents).toEqual([{ source: "huggingface:Qwen/Qwen3.8-27B", relation: null }]);
		expect(out.bytes_per_param).toBe(8.628);
		expect(out.license).toBeNull();
		expect("extra" in out).toBe(false);
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
			claim_json: null,
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

	it("exposes gated, parameters, and dominant_dtype from the digest, null when unknown", () => {
		const base = {
			id: 1,
			source: "huggingface:meta-llama/Llama-3.1-8B",
			revision: "",
			include_json: null,
			desire: 3,
			note: null,
			status: "want",
			holders: "",
			added: "2026-08-26T18:04:11+00:00",
			payload_bytes: 10,
			estimate_json: null,
			claim_json: JSON.stringify({
				client: "usb-carrier",
				state: "paused",
				percent: 40,
				updated: new Date().toISOString(),
			}),
		};
		const bare = entryToApi(base);
		expect(bare.gated).toBeNull();
		expect(bare.parameters).toBeNull();
		expect(bare.dominant_dtype).toBeNull();
		const rich = entryToApi({
			...base,
			estimate_json: JSON.stringify({
				artifact_type: "model",
				gated: true,
				parameters: 8_030_261_248,
				dominant_dtype: "BF16",
				as_of: "2026-08-26T18:04:11+00:00",
			}),
		});
		expect(rich.gated).toBe(true);
		expect(rich.parameters).toBe(8_030_261_248);
		expect(rich.dominant_dtype).toBe("BF16");
		expect(rich.precision).toBeNull();
		expect(rich.closed).toBe(false);
		expect(entryToApi({ ...base, source: "https://www.qwencloud.com/models/qwen3.8-max-0902" }).closed).toBe(true);
		expect(bare.claim?.client).toBe("usb-carrier");
		expect(bare.claim?.percent).toBe(40);
		// No stored hints: derived the way the CLI reads a 1.0.0 digest.
		expect(rich.hints).toEqual(["gated"]);
		expect(bare.hints).toEqual([]);
	});
});

describe("liveClaim", () => {
	const at = (updated: string) =>
		parseClaim(JSON.stringify({ client: "usb-carrier", state: "paused", updated }));
	const now = Date.parse("2026-09-01T12:00:00Z");

	it("keeps a fresh claim, expires one past the TTL, drops undated ones", () => {
		expect(liveClaim(at("2026-09-01T11:00:00Z"), now)).not.toBeNull();
		expect(liveClaim(at("2026-08-30T11:00:00Z"), now)).toBeNull();
		expect(liveClaim(at(""), now)).toBeNull();
		expect(liveClaim(null, now)).toBeNull();
	});

	it("entryToApi stops rendering an expired claim as in flight", () => {
		const row = {
			id: 9,
			source: "huggingface:MiniMaxAI/MiniMax-H3",
			revision: "",
			include_json: null,
			desire: null,
			note: null,
			status: "have",
			holders: "darsay1",
			added: "2026-08-26T18:04:11+00:00",
			payload_bytes: null,
			estimate_json: null,
			claim_json: JSON.stringify({
				client: "usb-carrier",
				state: "paused",
				percent: 40,
				updated: "2026-08-01T00:00:00Z",
			}),
		};
		expect(entryToApi(row).claim).toBeNull();
	});
});
