import { describe, expect, it } from "vitest";
import { artifactTypeFromSource, canonicalizeSource } from "./sources.ts";
import fixtures from "./source-fixtures.json";

describe("canonicalizeSource", () => {
	for (const row of fixtures as Array<{
		input: string;
		ok: boolean;
		canonical?: string;
		error?: string;
		website?: "opaque" | "home" | "400";
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
});
