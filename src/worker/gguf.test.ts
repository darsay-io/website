import { describe, expect, it } from "vitest";
import { ggufVariants, modelWeightBytes } from "./gguf.ts";
import { matchesInclude, selectSubset } from "./subset.ts";
import fixture from "./glm-5.3-flash-gguf.json";

describe("GGUF inventory", () => {
	it("groups the published GLM-5.3-Flash pack into 12 whole model variants", () => {
		// Copied from the CLI's tests/fixtures/glm-5.3-flash-gguf.json;
		// every byte count was published at this pinned upstream revision.
		expect(fixture.revision).toBe("2975ab414d30340466d8c51533c6e91f0cca64c1");
		expect(fixture.files).toHaveLength(87);
		expect(fixture.files.reduce((n, f) => n + f.size, 0)).toBe(2_545_636_747_545);
		const variants = ggufVariants(fixture.files);
		expect(variants).toHaveLength(12);
		expect(variants.every((v) => v.complete)).toBe(true);
		expect(variants.find((v) => v.precision === "BF16")).toMatchObject({ size_bytes: 641_641_064_192, file_count: 14 });
		expect(variants.find((v) => v.precision === "UD-Q4_K_XL")).toMatchObject({ size_bytes: 199_707_321_347 });
		for (const v of variants) {
			const hits = fixture.files.filter((f) => matchesInclude(f.path, v.include));
			expect(hits).toHaveLength(v.file_count);
			expect(hits.reduce((n, f) => n + f.size, 0)).toBe(v.size_bytes);
		}
		expect(modelWeightBytes(fixture.files.filter((f) => f.path.endsWith(".gguf")))).toBeNull();
	});

	it("never mistakes companion projectors, missing shards, or unknown sizes for one model", () => {
		const a = { path: "Q4/model-Q4_K_M-00001-of-00002.gguf", size: 10 };
		const b = { path: "Q4/model-Q4_K_M-00002-of-00002.gguf", size: 20 };
		const projector = { path: "nested/mmproj-F16.gguf", size: 5 };
		expect(ggufVariants([a, b, projector])).toEqual([{ name: "Q4/model-Q4_K_M", precision: "Q4_K_M", file_count: 2, size_bytes: 30, complete: true, include: ["/Q4/model-Q4_K_M-*-of-00002.gguf"] }]);
		expect(modelWeightBytes([a, b, projector])).toBe(30);
		expect(modelWeightBytes([projector])).toBeNull();
		expect(modelWeightBytes([a, b, { path: "model.safetensors", size: 40 }])).toBeNull();
		expect(ggufVariants([a])[0].complete).toBe(false);
		expect(modelWeightBytes([a])).toBeNull();
		expect(ggufVariants([a, a, b])[0].complete).toBe(false);
		expect(modelWeightBytes([a, { ...b, size: null }])).toBeNull();
		expect(ggufVariants([{ path: "model-00000-of-00000.gguf", size: 0 }])[0].complete).toBe(false);
	});

	it("keeps a standalone filename separate from a similarly named shard group", () => {
		const variants = ggufVariants([
			{ path: "model-of-00002.gguf", size: 100 },
			{ path: "model-00001-of-00002.gguf", size: 10 },
			{ path: "model-00002-of-00002.gguf", size: 20 },
		]);
		expect(variants).toHaveLength(2);
		expect(variants.map((v) => [v.name, v.size_bytes, v.complete])).toEqual([["model", 30, true], ["model-of-00002", 100, true]]);
	});

	it("uses literal selectors when a shard glob would include another file", () => {
		const files = [
			{ path: "a[1]/model-Q4-00001-of-00001.gguf", size: 10 },
			{ path: "a[1]/model-Q4-extra-of-00001.gguf", size: 20 },
		];
		for (const v of ggufVariants(files)) {
			expect(files.filter((f) => matchesInclude(f.path, v.include))).toHaveLength(1);
		}
	});
});

describe("include selection", () => {
	it("shares CLI anchoring, basename fallback, character classes, and sidecars", () => {
		expect(matchesInclude("nested/model.gguf", ["model.gguf"])).toBe(true);
		expect(matchesInclude("nested/model.gguf", ["/model.gguf"])).toBe(false);
		expect(matchesInclude("nested/model.gguf", ["/nested/*.gguf"])).toBe(true);
		expect(matchesInclude("model-Q4.gguf", ["model-Q[3-5].gguf"])).toBe(true);
		expect(matchesInclude("model-Q4.gguf", ["model-Q[!4].gguf"])).toBe(false);
		const files = [
			{ path: "Q4/model.gguf", size: 10 }, { path: "Q8/model.gguf", size: 20 },
			{ path: "config.json", size: 1 }, { path: "LICENSE", size: 2 }, { path: "nested/modeling_custom.py", size: 3 },
			{ path: "photo.png", size: 100 },
		];
		expect(selectSubset(files, ["/Q4/model.gguf"])?.map((f) => f.path)).toEqual(["Q4/model.gguf", "config.json", "LICENSE", "nested/modeling_custom.py"]);
		expect(selectSubset(files, ["*Q2*"])).toBeNull();
	});
});
