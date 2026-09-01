import { describe, expect, it } from "vitest";
import { PRIMER } from "./primer.ts";
import { oneCopyBytes, rowNote, type RowFacts } from "./rownote.ts";

const GiB = 1024 ** 3;

function row(over: Partial<RowFacts> = {}): RowFacts {
	return {
		source: "huggingface:OBLITERATUS/Qwen3.8-27B-OBLITERATED",
		status: "have",
		payload_bytes: 239_690_421_475,
		desire: 6,
		revision: null,
		include: null,
		artifact_type: "model",
		gated: false,
		parameters: 27_781_427_952,
		dominant_dtype: "BF16",
		hints: ["large", "quant", "redundant"],
		policy: null,
		holders: "darsay 2",
		claim: null,
		...over,
	};
}

describe("rowNote", () => {
	it("does the CLI's redundancy arithmetic for the row", () => {
		expect(oneCopyBytes(row())).toBe(27_781_427_952 * 2);
		const note = rowNote("dtype", row())!;
		expect(note).toContain("`27.78B` × 2 bytes (`BF16`) ≈ **52 GiB** for one copy");
		expect(note).toContain("priced at **223 GiB** — 4.3×, well over one copy");
		expect(rowNote("redundant", row({ payload_bytes: 55_586_114_863 }))).toContain("1.0×, about one copy");
		expect(rowNote("dtype", row({ dominant_dtype: "FP4" }))).toBeNull();
		expect(rowNote("dtype", row({ parameters: null }))).toBeNull();
		expect(rowNote("dtype", row({ payload_bytes: null }))).toContain("no size yet");
		expect(rowNote("dtype", row({ policy: "masters" }))).toContain("priced masters-first at");
	});

	it("plans a large download in evenings and link hours, in GiB", () => {
		const note = rowNote("large", row({ payload_bytes: 704 * GiB }))!;
		expect(note).toContain("**704 GiB**: 71 evenings at `--max-gb 10`");
		expect(note).toContain("about 8 hours of link time at 25 MiB/s");
		expect(note).toContain("In halves, 355 GiB to each disk");
		expect(rowNote("large", row({ payload_bytes: 15 * GiB }))).toContain("under the 20 GiB line");
		expect(rowNote("large", row({ payload_bytes: 1454 * GiB }))).toContain("17 hours of link time");
		expect(rowNote("large", row({ payload_bytes: null }))).toContain("No size on record");
	});

	it("reads MoE numbers, names, and the pin", () => {
		expect(rowNote("moe", row({ source: "huggingface:Qwen/Qwen3-Coder-480B-A35B-Instruct", payload_bytes: 895 * GiB }))).toBe(
			"480B total — all **895 GiB** come home. 35B active — once loaded it runs like a 35B dense model.",
		);
		expect(rowNote("moe", row())).toBeNull();
		expect(rowNote("abliterated", row())).toContain("Read from the name.");
		expect(rowNote("pin", row())).toContain("Unpinned");
		expect(rowNote("pin", row({ revision: "c1899de289a0f1e2d3c4b5a6" }))).toContain("Pinned to `c1899de289a0`");
		expect(rowNote("pin", row({ revision: "v1.2" }))).toContain("Pinned to `v1.2`");
		expect(rowNote("bundle", row())).toBe(
			"Lands as `~/darsay/obliteratus--qwen3.8-27b-obliterated/<rev>/` — `model/` frozen, `manifest.json` beside it.",
		);
	});

	it("tells a quant row what it might be, and a gated row where to go", () => {
		expect(rowNote("quant", row({ dominant_dtype: "F8_E4M3", hints: ["quant"] }))).toContain("if one does, this is a satellite");
		expect(rowNote("quant", row({ hints: [] }))).toContain("full fidelity");
		expect(rowNote("gated", row({ gated: true }))).toContain("the row's link");
	});

	it("reports the ledger columns and claims", () => {
		expect(rowNote("desire", row())).toBe("Desire **6**; marked **have** by darsay 2.");
		expect(rowNote("desire", row({ desire: null, status: "want" }))).toContain("only when nothing rated is left");
		expect(rowNote("claims", row())).toContain("No client has claimed");
		expect(rowNote("claims", row({ claim: { client: "darsay1", state: "archiving", percent: 1 } }))).toBe(
			"Claimed by `darsay1`, fetching at 1%. Other collectors' `--next` skips it while the claim is live.",
		);
	});

	it("never leaves a backtick open, for any card and a bare row", () => {
		const bare = row({ parameters: null, dominant_dtype: null, payload_bytes: null, hints: [], source: "test:acme/toy" });
		for (const c of PRIMER) {
			for (const r of [row(), bare]) {
				const note = rowNote(c.key, r);
				if (note === null) continue;
				expect((note.match(/`/g) ?? []).length % 2, `${c.key}: ${note}`).toBe(0);
				expect((note.match(/\*\*/g) ?? []).length % 2, `${c.key}: ${note}`).toBe(0);
				expect(note).not.toMatch(/\bGB\b/);
			}
		}
	});
});
