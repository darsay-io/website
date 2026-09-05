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
		size_basis: "repository",
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
		expect(note).toContain("shows **223 GiB repository total** — 4.3×, well over one copy");
		expect(rowNote("redundant", row({ payload_bytes: 55_586_114_863 }))).toContain("1.0×, about one copy");
		expect(rowNote("dtype", row({ dominant_dtype: "FP4" }))).toBeNull();
		expect(rowNote("dtype", row({ parameters: null }))).toBeNull();
		expect(rowNote("dtype", row({ payload_bytes: null }))).toContain("no size yet");
		expect(rowNote("dtype", row({ size_basis: "archive" }))).toContain("223 GiB archive");
		// The CLI's measured figure wins over the dtype arithmetic.
		expect(rowNote("dtype", row({ precision: "MXFP4", bytes_per_param: 0.562, parameters: 2_779_931_837_184 }))).toBe(
			"`2.78T` at `MXFP4`, **0.56 B/param** measured: about half a byte per weight — a 4-bit release — **223 GiB repository total** on the row.",
		);
		expect(rowNote("dtype", row({ source: "https://www.qwencloud.com/models/qwen3.8-max-0902", closed: true }))).toContain("closed work");
	});

	it("plans a large download in evenings and link hours, in GiB", () => {
		const note = rowNote("large", row({ payload_bytes: 704 * GiB }))!;
		expect(note).toContain("**704 GiB repository total**: 71 evenings at `--max-gb 10`");
		expect(note).toContain("about 8 hours of link time at 25 MiB/s");
		expect(note).toContain("In halves, 355 GiB to each disk");
		expect(rowNote("large", row({ payload_bytes: 15 * GiB }))).toContain("under the 20 GiB line");
		expect(rowNote("large", row({ payload_bytes: 1454 * GiB }))).toContain("17 hours of link time");
		expect(rowNote("large", row({ payload_bytes: null }))).toContain("No size on record");
	});

	it("reads MoE numbers, names, and the pin", () => {
		expect(rowNote("moe", row({ source: "huggingface:Qwen/Qwen3-Coder-480B-A35B-Instruct", payload_bytes: 895 * GiB }))).toBe(
			"480B total parameters, 35B active per token. The row shows **895 GiB repository total**; disk usage depends on the selected weight sets and their precision.",
		);
		expect(rowNote("moe", row())).toBeNull();
		expect(rowNote("abliterated", row())).toContain("Read from the name.");
		expect(rowNote("family", row())).toBe(
			"**Qwen 3.8**, member `27B`, variant *abliterated* — read from the name, published by OBLITERATUS.",
		);
		expect(rowNote("family", row({ parents: [{ source: "huggingface:Qwen/Qwen3.8-27B", relation: "finetune" }] }))).toContain(
			"declares it a **finetune** of `huggingface:Qwen/Qwen3.8-27B`",
		);
		expect(rowNote("family", row({ source: "test:acme/toy" }))).toContain("**toy**");
		expect(rowNote("closed", row({ source: "https://www.qwencloud.com/models/qwen3.8-max-0902" }))).toContain("**qwen 3.8**");
		expect(rowNote("archive", row({ size_basis: "archive" }))).toContain("prints without proven recovery");
		expect(rowNote("pin", row())).toContain("Unpinned");
		expect(rowNote("pin", row({ revision: "c1899de289a0f1e2d3c4b5a6" }))).toContain("Pinned to `c1899de289a0`");
		expect(rowNote("pin", row({ revision: "v1.2" }))).toContain("Pinned to `v1.2`");
		expect(rowNote("bundle", row())).toBe(
			"Lands as `~/darsay/obliteratus--qwen3.8-27b-obliterated/<rev>/` — `model/` frozen, `manifest.json` beside it.",
		);
	});

	it("tells a quant row what it might be, and a gated row where to go", () => {
		expect(rowNote("quant", row({ dominant_dtype: "F8_E4M3", hints: ["quant"] }))).toContain("recovery evidence");
		expect(rowNote("quant", row({ hints: [] }))).toContain("not original training provenance");
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

	it("distinguishes unresolved weight sets from files and keeps selection separate from recovery", () => {
		const selected = row({ include: ["/weights.gguf"], size_basis: "selection", payload_bytes: 8 * GiB });
		expect(rowNote("subset", selected)).toContain("**8.0 GiB selection** measures those selected files");
		expect(rowNote("subset", selected)).not.toContain("before");
		expect(rowNote("subset", selected)).toContain("not a recovery verdict");
		const archive = row({ size_basis: "archive", classification: { verdicts: { unknown: { sets: 3, files: 14, bytes: GiB } }, unclassified_count: 3, skipped_bytes: GiB }, unknown_size_count: 2 });
		const note = rowNote("archive", archive)!;
		expect(note).toContain("≥ 223 GiB archive · partial");
		expect(note).toContain("3 unresolved weight sets (14 files) retained");
		expect(note).toContain("lower bound");
		expect(note).toContain("prints without proven recovery");
		const one = row({ size_basis: "archive", classification: { verdicts: { unknown: { sets: 1, files: 5, bytes: GiB } }, unclassified_count: 1, skipped_bytes: 0 } });
		expect(rowNote("archive", one)).toContain("1 unresolved weight set (5 files) retained");
	});

	it("does not infer recoverability from a precision, a parent, or an edited-model name", () => {
		expect(rowNote("quant", row({ hints: ["quant"], dominant_dtype: null }))).toContain("does not prove recovery");
		expect(rowNote("abliterated", row())).toContain("does not prove the edit is irreversible");
		expect(rowNote("family", row({ parents: [{ source: "huggingface:zai-org/GLM-5.3-Flash", relation: "quantized" }] }))).toContain("does not establish how to recover");
	});

	it("applies the workbench cards to the row's own numbers", () => {
		const variant = { name: "Q4_K_M/x", precision: "Q4_K_M", file_count: 2, size_bytes: 1, complete: true, include: ["/Q4_K_M/*"] };
		const r = row({ bytes_per_param: 2, precision: "BF16", size_basis: "archive", gguf_variants: [] });
		expect(rowNote("memory", r)).toContain("**52 GiB** of weights");
		expect(rowNote("memory", r)).toContain("tokens/s on an Apple Max-class machine");
		expect(rowNote("memory", row({ gguf_variants: [variant, variant] }))).toContain("prices 2 alternative variants together");
		expect(rowNote("training", r)).toContain("**27.78B** parameters trained Chinchilla-style on 556B tokens");
		expect(rowNote("training", row({ parameters: null }))).toContain("No parameter count on record");
		expect(rowNote("finetune", r)).toContain("QLoRA at four bits, about 15 GiB");
		expect(rowNote("posttrain", row({ source: "huggingface:Qwen/Qwen3-32B-Instruct" }))).toContain("**instruct**");
		expect(rowNote("posttrain", row({ source: "huggingface:Qwen/Qwen3-32B" }))).toContain("neither base nor instruct");
		expect(rowNote("runtime", row({ source: "huggingface:unsloth/GLM-5.3-Flash-GGUF", gguf_variants: [variant, variant] }))).toContain("needs `--weights`");
		expect(rowNote("runtime", row({ gguf_variants: [] }))).toContain("`--engine mlx`");
		expect(rowNote("runtime", row({ artifact_type: "dataset" }))).toContain("matches no engine");
		const classified = { verdicts: { negative: { sets: 11, files: 61, bytes: 1 }, unknown: { sets: 3, files: 9, bytes: 1 } }, skipped_bytes: 0, unclassified_count: 3 };
		expect(rowNote("convert", row({ classification: classified }))).toContain("11 negative sets, 3 unknown, 0 prints; nothing proven duplicate");
		expect(rowNote("convert", row({ classification: null }))).toContain("Not classified yet");
		expect(rowNote("workbench", r)).toContain("`darsay hydrate ");
		expect(rowNote("workbench", r)).toContain("/model/`");
		expect(rowNote("workbench", row({ artifact_type: "dataset" }))).toContain("/data/`");
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
