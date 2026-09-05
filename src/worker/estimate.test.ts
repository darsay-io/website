import { describe, expect, it } from "vitest";
import { fetchEstimate, fetchGitHubEstimate, lfsPatterns, matchesLfsPattern } from "./estimate.ts";
import type { GitHubCanonical, HfCanonical } from "./sources.ts";
import fixture from "./glm-5.3-flash-gguf.json";

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
	it("distinguishes the GLM repository from one selected quant and reads GGUF facts", async () => {
		const parsed: HfCanonical = { kind: "hf", canonical: `huggingface:${fixture.source}`, locator: fixture.source, artifactType: "model", url: `https://huggingface.co/${fixture.source}` };
		const fetcher = async () => new Response(JSON.stringify({
			sha: fixture.revision,
			gguf: { total: fixture.parameters, architecture: fixture.architecture },
			siblings: fixture.files.map((f) => ({ rfilename: f.path, size: f.size })),
		}));
		const whole = (await fetchEstimate(parsed, null, null, fetcher))!.digest;
		expect(whole).toMatchObject({ payload_bytes: 2_545_636_747_545, repository_bytes: 2_545_636_747_545, parameters: 320_759_404_382, parameters_source: "gguf", architecture: "glm5next", size_basis: "repository", bytes_per_param: null, classification: null });
		expect(whole.gguf_variants).toHaveLength(12);
		const quant = whole.gguf_variants.find((v) => v.precision === "UD-Q4_K_XL")!;
		const selected = (await fetchEstimate(parsed, null, quant.include, fetcher))!.digest;
		expect(selected).toMatchObject({ size_basis: "selection", repository_bytes: whole.payload_bytes, precision: "UD-Q4_K_XL", bytes_per_param: 0.623 });
		expect(selected.payload_bytes).toBeGreaterThan(quant.size_bytes!);
		expect(selected.payload_bytes).toBeLessThan(quant.size_bytes! + 100_000_000);
		expect(selected.gguf_variants).toEqual(whole.gguf_variants);
		expect(selected.hints).toContain("subset");
	});

	it("leaves unmatched includes unpriced and partial sizes explicitly incomplete", async () => {
		const fetcher = async () => new Response(JSON.stringify({ sha: "abc", gguf: { total: 10 }, siblings: [
			{ rfilename: "model-Q4.gguf", size: 100 }, { rfilename: "model-Q8.gguf", size: null },
			{ rfilename: "config.json", size: 5 },
		] }));
		expect(await fetchEstimate(hf, null, ["*Q2*"], fetcher)).toBeNull();
		expect((await fetchEstimate(hf, null, null, fetcher))?.digest).toMatchObject({ unknown_size_count: 1, payload_bytes: 105, repository_bytes: null, bytes_per_param: null });
	});

	it("returns null when the Hub misses", async () => {
		const got = await fetchEstimate(hf, null, null, async () => new Response("no", { status: 404 }));
		expect(got).toBeNull();
	});

	it("pins the Hub request at the given revision", async () => {
		const urls: string[] = [];
		await fetchEstimate(hf, "abc123", null, async (input) => {
			urls.push(String(input));
			return new Response("no", { status: 404 });
		});
		expect(urls[0]).toContain("/models/Qwen/Qwen3-0.6B/revision/abc123");
		expect(urls[0]).toContain("blobs=true");
	});

	it("projects DIGEST_KEYS and does not invent sizes", async () => {
		const got = await fetchEstimate(hf, null, null, async (input) => {
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
			bytes_per_param: null,
			architecture: null,
			parents: null,
			size_basis: "repository",
			repository_bytes: null,
			parameters_source: "safetensors",
		});
		expect(got?.digest.as_of).toMatch(/\+00:00$/);
	});

	it("reads config.json for the precision and architecture, and tags for parents", async () => {
		const urls: string[] = [];
		const got = await fetchEstimate(hf, null, null, async (input) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("/resolve/f831ab66/config.json")) {
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
		expect(urls.some((u) => u.endsWith("/resolve/f831ab66/config.json"))).toBe(true);
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
		const got = await fetchEstimate(datasetShaped, null, null, async (input) => {
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
		await fetchEstimate(hf, null, null, async (input) => {
			urls.push(String(input));
			return new Response(JSON.stringify({ sha: "x", siblings: [{ rfilename: "a", size: 1 }] }), {
				headers: { "Content-Type": "application/json" },
			});
		});
		expect(urls).toHaveLength(1);
		expect(urls[0]).toContain("/models/");
	});
});

describe("fetchGitHubEstimate", () => {
	const gh: GitHubCanonical = { kind: "github", canonical: "github:MiaAI-Lab/Recipe", url: "https://github.com/MiaAI-Lab/Recipe", artifactType: "code", locator: "MiaAI-Lab/Recipe" };
	const sha = "203834ca88000c8192112e396b80d886b522caa0";
	const tree = [
		{ path: "README.md", type: "blob", size: 100 },
		{ path: ".gitattributes", type: "blob", size: 40 },
		{ path: "weights.bin", type: "blob", size: 130 },
		{ path: "files/patch.py", type: "blob", size: 2000 },
		{ path: "vendor/x", type: "commit" },
	];
	function fake(repo: Record<string, unknown> = {}, truncated = false) {
		const auth: Array<string | null> = [];
		const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			auth.push(new Headers(init?.headers).get("Authorization"));
			if (url === "https://api.github.com/repos/MiaAI-Lab/Recipe") return new Response(JSON.stringify({ license: { key: "agpl-3.0" }, fork: true, parent: { full_name: "lancelind/qwen3.8-Flash-DGX" }, private: false, ...repo }));
			if (url === "https://api.github.com/repos/MiaAI-Lab/Recipe/commits/HEAD") return new Response(JSON.stringify({ sha }));
			if (url === "https://api.github.com/repos/MiaAI-Lab/Recipe/commits/v1") return new Response(JSON.stringify({ sha: "1".repeat(40) }));
			if (url.startsWith("https://api.github.com/repos/MiaAI-Lab/Recipe/git/trees/")) return new Response(JSON.stringify({ tree, truncated }));
			if (url.startsWith("https://raw.githubusercontent.com/MiaAI-Lab/Recipe/")) return new Response("*.bin filter=lfs diff=lfs merge=lfs -text\n");
			return new Response("no", { status: 404 });
		};
		return { fetcher, auth };
	}

	it("prices the tree at HEAD, leaves LFS pointers unknown, and records the fork edge", async () => {
		const hit = (await fetchGitHubEstimate(gh, null, null, fake().fetcher))!;
		expect(hit.digest).toMatchObject({
			artifact_type: "code",
			revision: sha,
			revision_ref: "HEAD",
			payload_bytes: 2140,
			file_count: 4,
			unknown_size_count: 1,
			repository_bytes: null,
			size_basis: "repository",
			license: "agpl-3.0",
			gated: false,
			parameters: null,
			precision: null,
			gguf_variants: [],
			parents: [{ source: "github:lancelind/qwen3.8-Flash-DGX", relation: "fork" }],
		});
		expect(hit.files.find((f) => f.path === "weights.bin")!.size).toBeNull();
		expect(hit.files.some((f) => f.path === "vendor/x")).toBe(false);
		expect(hit.parsed).toBe(gh);
	});

	it("pins a named revision, carries the token, and prices a selection", async () => {
		const f = fake({ fork: false });
		const hit = (await fetchGitHubEstimate(gh, "v1", ["*.py"], f.fetcher, "ghp_x"))!;
		expect(hit.digest.revision).toBe("1".repeat(40));
		expect(hit.digest.revision_ref).toBe("v1");
		expect(hit.digest.parents).toBeNull();
		expect(hit.digest).toMatchObject({ size_basis: "selection", payload_bytes: 2100, file_count: 2, unknown_size_count: 0 });
		expect(hit.digest.hints).toContain("subset");
		expect(f.auth.every((a) => a === "Bearer ghp_x")).toBe(true);
	});

	it("leaves a truncated tree and a missing repository unpriced", async () => {
		expect(await fetchGitHubEstimate(gh, null, null, fake({}, true).fetcher)).toBeNull();
		expect(await fetchGitHubEstimate(gh, null, null, async () => new Response("no", { status: 404 }))).toBeNull();
	});

	it("reads gitattributes the way the CLI does", () => {
		expect(lfsPatterns("# c\n*.bin filter=lfs diff=lfs merge=lfs -text\n*.md text\nmodels/*.pt filter=lfs\n")).toEqual(["*.bin", "models/*.pt"]);
		expect(matchesLfsPattern("deep/dir/w.bin", "*.bin")).toBe(true);
		expect(matchesLfsPattern("models/w.pt", "models/*.pt")).toBe(true);
		expect(matchesLfsPattern("other/w.pt", "models/*.pt")).toBe(false);
		expect(matchesLfsPattern("w.pt", "/w.pt")).toBe(true);
		expect(matchesLfsPattern("sub/w.pt", "/w.pt")).toBe(false);
	});
});
