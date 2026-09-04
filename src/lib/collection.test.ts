import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { COLLECTION_GUIDE, bitFamily, encodingFamily, selectionTotals, startingSelection, toggleVariant, variantSelected, type Publication } from "./collection.ts";
import { ggufVariants, isProjector } from "../worker/gguf.ts";
import { selectSubset } from "../worker/subset.ts";
import fixture from "../worker/glm-5.3-flash-gguf.json";

const variants = ggufVariants(fixture.files);
const companions = ggufVariants(fixture.files, true).filter((v) => isProjector(v.name));
const publication: Publication = { ...fixture, variants, companions };

describe("the collection room", () => {
	it("keeps board and packaged CLI teaching copy in sync when the sibling checkout is present", () => {
		const canonical = new URL("../../../darsay/src/darsay/collection_guide.json", import.meta.url);
		if (existsSync(canonical)) expect(COLLECTION_GUIDE).toEqual(JSON.parse(readFileSync(canonical, "utf8")));
	});
	it("labels encoding families without treating precision as a quality score", () => {
		for (const [precision, bits, family] of [["UD-Q4_K_XL", 4, "middle"], ["IQ4_XS", 4, "middle"], ["Q8_0", 8, "wide"], ["Q2_K", 2, "compact"], ["BF16", null, "float"], ["new-format", null, "unknown"]] as const) {
			expect(bitFamily(precision)).toBe(bits);
			expect(encodingFamily(precision)).toBe(family);
		}
	});
	it("makes explicit smallest-known complete 4-bit and 4+8-bit starting points", () => {
		const single = startingSelection(variants, "single");
		const pair = startingSelection(variants, "compare");
		const one = variants.filter((v) => variantSelected(v, single));
		expect(one).toHaveLength(1);
		expect(one[0].precision).toBe("UD-IQ4_XS");
		expect(variants.filter((v) => variantSelected(v, pair)).map((v) => bitFamily(v.precision)).sort()).toEqual([4, 8]);
		expect(companions.some((v) => variantSelected(v, pair))).toBe(false);
		expect(startingSelection(variants, "whole")).toEqual(["/*"]);
	});
	it("does not guess a missing family or recommend incomplete/unknown-size groups", () => {
		const invalid = variants.map((v, i) => ({ ...v, complete: i % 2 === 0, size_bytes: i % 2 === 0 ? null : v.size_bytes }));
		expect(startingSelection(invalid, "single")).toEqual([]);
		expect(startingSelection(variants.filter((v) => bitFamily(v.precision) === 2), "compare")).toEqual([]);
	});
	it("counts every Q4 shard and shared support once across a comparison collection", () => {
		const q4 = variants.find((v) => v.precision === "UD-Q4_K_XL")!;
		const q8 = variants.find((v) => v.precision === "Q8_0")!;
		expect(selectionTotals(fixture.files, [])).toEqual({ bytes: 0, files: 0, unknown: 0 });
		expect(selectionTotals(fixture.files, q4.include)).toEqual({ bytes: 199_707_329_724, files: 7, unknown: 0 });
		const pair = selectionTotals(fixture.files, [...q4.include, ...q8.include]);
		expect(pair.bytes).toBe(q4.size_bytes! + q8.size_bytes! + 8377);
		expect(pair.files).toBe(q4.file_count + q8.file_count + 1);
		expect(selectionTotals(fixture.files, ["/*"])).toEqual({ bytes: 2_545_636_747_545, files: 87, unknown: 0 });
	});
	it("keeps projectors explicit and whole-to-subset changes honest", () => {
		const first = variants[0];
		const include = toggleVariant(publication, first.include, companions[0]);
		expect(variantSelected(companions[0], include)).toBe(true);
		expect(variantSelected(companions[1], include)).toBe(false);
		const subset = toggleVariant(publication, ["/*"], first);
		expect(subset).not.toContain("/*");
		expect(variantSelected(first, subset)).toBe(false);
		expect(variants.slice(1).every((v) => variantSelected(v, subset))).toBe(true);
		expect(selectSubset(fixture.files, subset)!.some((f) => f.path === "README.md")).toBe(true);
	});
	it("reports unknown sizes as a lower bound", () => {
		expect(selectionTotals([{ path: "a.gguf", size: null }, { path: "README.md", size: 7 }], ["/a.gguf"])).toEqual({ bytes: 7, files: 2, unknown: 1 });
	});
});
