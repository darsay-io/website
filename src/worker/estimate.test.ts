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
		const got = await fetchEstimate(hf, null, async (input) => {
			if (String(input).includes("/resolve/")) return new Response("no", { status: 404 });
			return new Response(
				JSON.stringify({
					sha: "deadbeef",
					gated: false,
					siblings: [{ rfilename: "a.safetensors", size: 100 }, { rfilename: "b.bin", size: null }],
					safetensors: { total: 42, parameters: { BF16: 40, FP32: 2 } },
					cardData: { license: "apache-2.0" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		});
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
			// No config.json in the repo: the dtype alone names the precision.
			precision: "BF16",
			bytes_per_param: 2.381,
			architecture: null,
			parents: null,
		});
		expect(got?.digest.as_of).toMatch(/\+00:00$/);
	});

	it("reads config.json for the precision and architecture, and tags for parents", async () => {
		const urls: string[] = [];
		const got = await fetchEstimate(hf, null, async (input) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("/resolve/main/config.json")) {
				return new Response(
					JSON.stringify({
						model_type: "kimi_k3",
						text_config: {
							quantization_config: {
								quant_method: "compressed-tensors",
								format: "mxfp4-pack-quantized",
								config_groups: { group_0: { weights: { num_bits: 4, type: "float", group_size: 32 } } },
							},
						},
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					sha: "f831ab66",
					siblings: [
						{ rfilename: "config.json", size: 7006 },
						{ rfilename: "model-00001-of-000096.safetensors", size: 15_722_000_000 },
					],
					safetensors: { total: 27_227_408_302, parameters: { U8: 27_227_408_302 } },
					cardData: { license: "other", base_model: "moonshotai/Kimi-K2-Base", datasets: ["acme/corpus"] },
					tags: ["base_model:finetune:moonshotai/Kimi-K2-Base", "compressed-tensors"],
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		});
		expect(urls.some((u) => u.endsWith("/resolve/main/config.json"))).toBe(true);
		expect(got?.digest.precision).toBe("MXFP4");
		expect(got?.digest.architecture).toBe("kimi_k3");
		expect(got?.digest.bytes_per_param).toBe(0.577);
		expect(got?.digest.parents).toEqual([
			{ source: "huggingface:moonshotai/Kimi-K2-Base", relation: "finetune" },
			{ source: "huggingface:datasets/acme/corpus", relation: "trained_on" },
		]);
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

	it("does not probe datasets when the model exists, nor config.json when the repo has none", async () => {
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
