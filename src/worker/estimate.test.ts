import { describe, expect, it } from "vitest";
import { fetchEstimate } from "./estimate.ts";
import type { HfCanonical } from "./sources.ts";

const hf: HfCanonical = {
	kind: "hf",
	canonical: "huggingface:Qwen/Qwen3-0.6B",
	url: "https://huggingface.co/Qwen/Qwen3-0.6B",
	artifactType: "model",
	locator: "Qwen/Qwen3-0.6B",
};

const datasetShaped: HfCanonical = {
	kind: "hf",
	canonical: "huggingface:saidutta69/fable-5-premium",
	url: "https://huggingface.co/saidutta69/fable-5-premium",
	artifactType: "model",
	locator: "saidutta69/fable-5-premium",
};

describe("fetchEstimate", () => {
	it("returns null when the Hub misses", async () => {
		const got = await fetchEstimate(hf, null, async () => new Response("no", { status: 404 }));
		expect(got).toBeNull();
	});

	it("pins the Hub request at the given revision", async () => {
		const urls: string[] = [];
		await fetchEstimate(hf, "abc123", async (input) => {
			urls.push(String(input));
			return new Response("no", { status: 404 });
		});
		expect(urls[0]).toContain("/models/Qwen/Qwen3-0.6B/revision/abc123");
		expect(urls[0]).toContain("blobs=true");
	});

	it("projects DIGEST_KEYS and does not invent sizes", async () => {
		const got = await fetchEstimate(hf, null, async () =>
			new Response(
				JSON.stringify({
					sha: "deadbeef",
					gated: false,
					siblings: [{ rfilename: "a.safetensors", size: 100 }, { rfilename: "b.bin", size: null }],
					safetensors: { total: 42, parameters: { BF16: 40, FP32: 2 } },
					cardData: { license: "apache-2.0" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
		);
		expect(got?.parsed.canonical).toBe("huggingface:Qwen/Qwen3-0.6B");
		expect(got?.digest).toMatchObject({
			artifact_type: "model",
			revision: "deadbeef",
			revision_ref: "main",
			payload_bytes: 100,
			file_count: 2,
			license: "apache-2.0",
			gated: false,
			parameters: 42,
			dominant_dtype: "BF16",
			unknown_size_count: 1,
		});
		expect(got?.digest.as_of).toMatch(/\+00:00$/);
	});

	it("retargets a model-shaped dataset-only id", async () => {
		const urls: string[] = [];
		const got = await fetchEstimate(datasetShaped, null, async (input) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("/models/")) {
				return new Response(JSON.stringify({ error: "Invalid username or password." }), { status: 401 });
			}
			return new Response(
				JSON.stringify({
					sha: "abc",
					gated: false,
					siblings: [{ rfilename: "train.parquet", size: 2340 }],
					cardData: { license: "mit" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		});
		expect(urls.some((u) => u.includes("/models/saidutta69/fable-5-premium"))).toBe(true);
		expect(urls.some((u) => u.includes("/datasets/saidutta69/fable-5-premium"))).toBe(true);
		expect(got?.parsed.canonical).toBe("huggingface:datasets/saidutta69/fable-5-premium");
		expect(got?.parsed.artifactType).toBe("dataset");
		expect(got?.digest.artifact_type).toBe("dataset");
		expect(got?.digest.payload_bytes).toBe(2340);
	});

	it("does not probe datasets when the model exists", async () => {
		const urls: string[] = [];
		await fetchEstimate(hf, null, async (input) => {
			urls.push(String(input));
			return new Response(JSON.stringify({ sha: "x", siblings: [{ rfilename: "a", size: 1 }] }), {
				headers: { "Content-Type": "application/json" },
			});
		});
		expect(urls).toHaveLength(1);
		expect(urls[0]).toContain("/models/");
	});
});
