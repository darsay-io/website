import { describe, expect, it } from "vitest";
import { artifactTypeFromSource, canonicalizeSource, isProviderSource, urlFromCanonical } from "./sources.ts";
import fixtures from "./source-fixtures.json";

describe("canonicalizeSource", () => {
	for (const row of fixtures as Array<{
		input: string;
		ok: boolean;
		canonical?: string;
		error?: string;
		website?: "opaque" | "home" | "github" | "400";
	}>) {
		it(JSON.stringify(row.input), () => {
			const got = canonicalizeSource(row.input);
			if (row.website === "opaque") {
				expect(got.kind).toBe("opaque");
				if (got.kind === "opaque") expect(got.canonical).toBe(row.input);
				return;
			}
			if (row.website === "home") {
				expect(got.kind).toBe("home");
				if (got.kind === "home") expect(got.canonical).toBe(row.canonical);
				return;
			}
			if (row.website === "github") {
				expect(got.kind).toBe("github");
				if (got.kind === "github") {
					expect(got.canonical).toBe(row.canonical);
					expect(got.artifactType).toBe("code");
					expect(got.url).toBe(`https://github.com/${got.locator}`);
				}
				return;
			}
			if (row.website === "400" || !row.ok) {
				expect(got.kind).toBe("error");
				return;
			}
			expect(got.kind).not.toBe("error");
			if (got.kind === "hf" || got.kind === "opaque") {
				expect(got.canonical).toBe(row.canonical);
			}
		});
	}

	it("preserves locator case", () => {
		const a = canonicalizeSource("huggingface:Qwen/Qwen3-0.6B");
		const b = canonicalizeSource("huggingface:qwen/qwen3-0.6B");
		expect(a.kind).toBe("hf");
		expect(b.kind).toBe("hf");
		if (a.kind === "hf" && b.kind === "hf") {
			expect(a.canonical).toBe("huggingface:Qwen/Qwen3-0.6B");
			expect(b.canonical).toBe("huggingface:qwen/qwen3-0.6B");
			expect(a.canonical).not.toBe(b.canonical);
		}
	});
});

describe("artifactTypeFromSource", () => {
	it("reads type from the Hub address grammar", () => {
		expect(artifactTypeFromSource("huggingface:Qwen/Qwen3-0.6B")).toBe("model");
		expect(artifactTypeFromSource("huggingface:datasets/saidutta69/fable-5-premium")).toBe("dataset");
		expect(artifactTypeFromSource("modelscope:qwen/Qwen-7B")).toBeNull();
	});

	it("reads code from the GitHub grammar", () => {
		expect(artifactTypeFromSource("github:MiaAI-Lab/Recipe")).toBe("code");
		expect(artifactTypeFromSource("https://github.com/MiaAI-Lab/Recipe")).toBe("code");
		expect(artifactTypeFromSource("https://www.qwencloud.com/models/qwen3.8-max-0902")).toBeNull();
	});
});

describe("a buried revision is refused with the fix", () => {
	it("names the repository and the revision", () => {
		const got = canonicalizeSource("https://github.com/MiaAI-Lab/Recipe/tree/v1.2");
		expect(got.kind).toBe("error");
		if (got.kind === "error") expect(got.error).toContain("github:MiaAI-Lab/Recipe, revision v1.2");
	});
});

describe("urlFromCanonical", () => {
	it("names the page for every provider, the home for a closed work, nothing for an opaque scheme", () => {
		expect(urlFromCanonical("huggingface:Qwen/Qwen3-0.6B")).toBe("https://huggingface.co/Qwen/Qwen3-0.6B");
		expect(urlFromCanonical("huggingface:datasets/a/b")).toBe("https://huggingface.co/datasets/a/b");
		expect(urlFromCanonical("github:MiaAI-Lab/Recipe")).toBe("https://github.com/MiaAI-Lab/Recipe");
		expect(urlFromCanonical("https://www.qwencloud.com/models/qwen3.8-max-0902")).toBe("https://www.qwencloud.com/models/qwen3.8-max-0902");
		expect(urlFromCanonical("modelscope:qwen/Qwen-7B")).toBeNull();
		expect(isProviderSource(canonicalizeSource("github:a/b"))).toBe(true);
		expect(isProviderSource(canonicalizeSource("modelscope:a/b"))).toBe(false);
	});
});
