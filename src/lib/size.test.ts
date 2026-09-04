import { describe, expect, it } from "vitest";
import { modelFacts, scopedSize, sizeExplanation, variantSize, type GgufVariant } from "./size.ts";

const GiB = 1024 ** 3;
const variant: GgufVariant = { name: "model-Q4_K_M", precision: "Q4_K_M", file_count: 2, size_bytes: 120 * GiB, complete: true, include: ["/part1.gguf", "/part2.gguf"] };

describe("size scope", () => {
	it("requires explicit scope and visibly marks incomplete amounts", () => {
		expect(scopedSize({ payload_bytes: 2355 * GiB, size_basis: "repository" })).toBe("2.3 TiB repository total");
		expect(scopedSize({ payload_bytes: 120 * GiB, size_basis: "selection" })).toBe("120 GiB selection");
		expect(scopedSize({ payload_bytes: 120 * GiB, size_basis: "archive", unknown_size_count: 2 })).toBe("≥ 120 GiB archive · partial");
		expect(scopedSize({ payload_bytes: null, size_basis: "repository" })).toBe("unpriced");
		expect(scopedSize({ payload_bytes: 120 * GiB, size_basis: null })).toBe("unpriced");
		expect(sizeExplanation({ payload_bytes: GiB, size_basis: "archive", unknown_size_count: 1 })).toContain("1 file has unknown sizes");
		expect(sizeExplanation({ payload_bytes: GiB, size_basis: "archive" })).toContain("prints without proven recovery");
		expect(sizeExplanation({ payload_bytes: GiB, size_basis: "archive" })).toContain("byte duplicates within this bundle");
	});
	it("describes GGUF file sizes separately from an archive or repository", () => {
		expect(variantSize(variant)).toBe("120 GiB GGUF files");
		expect(variantSize({ ...variant, complete: false })).toBe("≥ 120 GiB GGUF files · partial");
		expect(variantSize({ ...variant, size_bytes: null })).toBe("size unknown");
	});
});

describe("model facts", () => {
	it("shows precision without parameters and trusts a measured ratio for a selected weight set", () => {
		expect(modelFacts({ payload_bytes: GiB, parameters: null, precision: "Q4_K_M" })).toEqual(["Q4_K_M"]);
		expect(modelFacts({ payload_bytes: GiB, parameters: 229e9, precision: "GGUF", bytes_per_param: null, gguf_variants: [variant, { ...variant, name: "model-Q8_0" }] })).toEqual(["229.00B", "GGUF"]);
		expect(modelFacts({ payload_bytes: GiB, size_basis: "selection", parameters: 229e9, precision: "Q4_K_M", bytes_per_param: 0.56, gguf_variants: [variant, { ...variant, name: "model-Q8_0" }] })).toEqual(["229.00B", "Q4_K_M", "0.56 B/param"]);
		expect(modelFacts({ payload_bytes: GiB, parameters: 229e9, precision: "Q4_K_M", bytes_per_param: 0.56, gguf_variants: [variant] })).toEqual(["229.00B", "Q4_K_M", "0.56 B/param"]);
	});
});
