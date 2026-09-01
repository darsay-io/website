import { describe, expect, it } from "vitest";
import {
	LARGE_PAYLOAD_BYTES,
	REDUNDANT_FACTOR,
	dominantFormat,
	entryHints,
	expectedWeightBytes,
	hintsFrom,
	isWeightFile,
} from "./hints.ts";

const GiB = 1024 ** 3;

describe("hintsFrom (port of darsay.catalog._hints)", () => {
	it("draws large at exactly 20 GiB and never for an unknown size", () => {
		const base = { gated: false, subset: false, dominantDtype: "BF16", dominantFormat: "safetensors" };
		expect(hintsFrom({ ...base, payloadBytes: LARGE_PAYLOAD_BYTES })).toEqual(["large"]);
		expect(hintsFrom({ ...base, payloadBytes: LARGE_PAYLOAD_BYTES - 1 })).toEqual([]);
		expect(hintsFrom({ ...base, payloadBytes: null })).toEqual([]);
	});

	it("marks quant from a non-full-fidelity dtype or a GGUF-dominant payload, never from a name", () => {
		const small = { payloadBytes: 1 * GiB, gated: false, subset: false };
		expect(hintsFrom({ ...small, dominantDtype: "F8_E4M3", dominantFormat: "safetensors" })).toEqual(["quant"]);
		expect(hintsFrom({ ...small, dominantDtype: "U8", dominantFormat: null })).toEqual(["quant"]);
		expect(hintsFrom({ ...small, dominantDtype: null, dominantFormat: "gguf" })).toEqual(["quant"]);
		expect(hintsFrom({ ...small, dominantDtype: "bf16", dominantFormat: "safetensors" })).toEqual([]);
		expect(hintsFrom({ ...small, dominantDtype: null, dominantFormat: null })).toEqual([]);
	});

	it("marks redundant at 1.75x one copy, and stays quiet when a width is unknown", () => {
		const bf16 = { BF16: 27_781_427_952 };
		const oneCopy = expectedWeightBytes(bf16)!;
		expect(oneCopy).toBe(27_781_427_952 * 2);
		const row = { payloadBytes: 1 * GiB, gated: false, subset: false, dominantDtype: "BF16", dominantFormat: "safetensors" };
		expect(hintsFrom({ ...row, weightsBytes: oneCopy * REDUNDANT_FACTOR, paramsByDtype: bf16 })).toEqual(["redundant"]);
		expect(hintsFrom({ ...row, weightsBytes: oneCopy * 1.7, paramsByDtype: bf16 })).toEqual([]);
		expect(expectedWeightBytes({ BF16: 10, FP4: 5 })).toBeNull();
		expect(expectedWeightBytes({})).toBeNull();
		expect(expectedWeightBytes(null)).toBeNull();
		expect(hintsFrom({ ...row, weightsBytes: 10 ** 12, paramsByDtype: { BF16: 10, FP4: 5 } })).toEqual([]);
	});

	it("sorts and includes gated and subset", () => {
		expect(
			hintsFrom({
				payloadBytes: 30 * GiB,
				gated: true,
				subset: true,
				dominantDtype: "U8",
				dominantFormat: "gguf",
			}),
		).toEqual(["gated", "large", "quant", "subset"]);
	});
});

describe("dominantFormat / isWeightFile", () => {
	it("picks the extension carrying most bytes, ties by count, in the CLI's order", () => {
		expect(
			dominantFormat([
				{ path: "model-00001-of-00002.safetensors", size: 10 },
				{ path: "model-00002-of-00002.safetensors", size: 10 },
				{ path: "gguf/Q4_K_M.gguf", size: 25 },
			]),
		).toBe("gguf");
		expect(
			dominantFormat([
				{ path: "a.safetensors", size: null },
				{ path: "b.safetensors", size: null },
				{ path: "c.gguf", size: null },
			]),
		).toBe("safetensors");
		expect(dominantFormat([])).toBeNull();
	});
	it("recognises the CLI's weight suffixes only", () => {
		expect(isWeightFile("model/x.SafeTensors")).toBe(true);
		expect(isWeightFile("q.gguf")).toBe(true);
		expect(isWeightFile("pytorch_model.bin")).toBe(true);
		expect(isWeightFile("config.json")).toBe(false);
		expect(isWeightFile("imatrix.dat")).toBe(false);
	});
});

describe("entryHints (port of derive_hints)", () => {
	it("prefers stored hints verbatim, dropping unknown words", () => {
		expect(entryHints({ payload_bytes: 1, hints: ["redundant", "large", "bogus"] }, null)).toEqual([
			"large",
			"redundant",
		]);
		expect(entryHints({ payload_bytes: 100 * GiB, hints: [] }, null)).toEqual([]);
	});
	it("derives large, gated, and dtype quant for a digest without hints", () => {
		expect(entryHints({ payload_bytes: 100 * GiB, gated: true, dominant_dtype: "F8_E4M3" }, null)).toEqual([
			"gated",
			"large",
			"quant",
		]);
		expect(entryHints({ payload_bytes: 1, gated: false, dominant_dtype: "BF16" }, null)).toEqual([]);
		expect(entryHints(null, null)).toEqual([]);
	});
	it("adds subset from the entry's include globs either way", () => {
		expect(entryHints({ payload_bytes: 1, hints: ["large"] }, ["*Q4_K_M*"])).toEqual(["large", "subset"]);
		expect(entryHints({ payload_bytes: 1 }, ["*.gguf"])).toEqual(["subset"]);
		expect(entryHints({ payload_bytes: 1, hints: ["subset"] }, ["*.gguf"])).toEqual(["subset"]);
	});
});
