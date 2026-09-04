import { describe, expect, it } from "vitest";
import {
	bytesPerParam,
	describeBytesPerParam,
	ggufLevelOf,
	humanBytesPerParam,
	precisionFacts,
	precisionFromConfig,
} from "./precision.ts";

const KIMI_K3 = {
	model_type: "kimi_k3",
	text_config: {
		dtype: "bfloat16",
		quantization_config: {
			config_groups: { group_0: { format: "mxfp4-pack-quantized", weights: { group_size: 32, num_bits: 4, type: "float" } } },
			format: "mxfp4-pack-quantized",
			quant_method: "compressed-tensors",
		},
	},
};

describe("precision (a port of the CLI's)", () => {
	it("names a native MXFP4 release from a nested quantization_config", () => {
		const got = precisionFacts({ config: KIMI_K3, dominantDtype: "U8", dominantFormat: "safetensors" });
		expect(got.label).toBe("MXFP4");
		expect(got.bits).toBe(4);
		expect(got.quantized).toBe(true);
		expect(got.detail).toContain("group 32");
	});
	it("names FP8, BF16, and the torch dtype when no header count exists", () => {
		expect(precisionFacts({ config: { quantization_config: { quant_method: "fp8" } }, dominantDtype: "F8_E4M3", dominantFormat: null }).label).toBe("FP8");
		const bf16 = precisionFacts({ config: { torch_dtype: "bfloat16" }, dominantDtype: "BF16", dominantFormat: null });
		expect([bf16.label, bf16.bits, bf16.quantized]).toEqual(["BF16", 16, false]);
		const plain = precisionFacts({ config: { text_config: { dtype: "bfloat16" } }, dominantDtype: null, dominantFormat: null });
		expect([plain.label, plain.quantized]).toEqual(["BF16", false]);
		expect(precisionFacts({ config: null, dominantDtype: "F8_E4M3", dominantFormat: null }).label).toBe("FP8");
	});
	it("labels awq, gptq, bitsandbytes, and mlx", () => {
		expect(precisionFromConfig({ quantization_config: { quant_method: "awq", bits: 4 } })?.label).toBe("AWQ INT4");
		expect(precisionFromConfig({ quantization_config: { quant_method: "gptq", bits: 8 } })?.label).toBe("GPTQ INT8");
		expect(precisionFromConfig({ quantization_config: { quant_method: "bitsandbytes", load_in_4bit: true, bnb_4bit_quant_type: "nf4" } })?.label).toBe("NF4");
		expect(precisionFromConfig({ quantization: { bits: 4, group_size: 64 } })?.label).toBe("MLX 4-bit");
		expect(precisionFromConfig({ torch_dtype: "bfloat16" })).toBeNull();
	});
	it("reads GGUF levels only when GGUF is all there is", () => {
		expect(ggufLevelOf("Qwen3.8-27B-Q4_K_M.gguf")).toBe("Q4_K_M");
		expect(ggufLevelOf("x/UD-Q4_K_XL-00001-of-00002.gguf")).toBe("UD-Q4_K_XL");
		expect(ggufLevelOf("weird.gguf")).toBeNull();
		const one = precisionFacts({ config: null, dominantDtype: null, dominantFormat: "gguf", weightPaths: ["m-Q4_K_M.gguf"] });
		expect([one.label, one.bits, one.quantized]).toEqual(["Q4_K_M", 4, true]);
		const pack = precisionFacts({ config: null, dominantDtype: null, dominantFormat: "gguf", weightPaths: ["a-Q4_K_M.gguf", "a-Q8_0.gguf"] });
		expect(pack.label).toBe("GGUF");
		const beside = precisionFacts({
			config: { torch_dtype: "bfloat16" },
			dominantDtype: "BF16",
			dominantFormat: "gguf",
			weightPaths: ["model-00001-of-00002.safetensors", "x-Q4_K_M.gguf"],
		});
		expect([beside.label, beside.quantized]).toEqual(["BF16", false]);
	});
	it("measures and describes bytes per parameter", () => {
		expect(bytesPerParam(4_892_361_000_000, 2_446_180_000_000)).toBe(2);
		expect(bytesPerParam(1_561_000_000_000, 2_779_931_837_184)).toBe(0.562);
		expect(bytesPerParam(null, 5)).toBeNull();
		expect(bytesPerParam(5, 0)).toBeNull();
		expect(describeBytesPerParam(2)).toBe("about one 16-bit weight copy");
		expect(describeBytesPerParam(0.56)).toMatch(/^about half a byte/);
		expect(describeBytesPerParam(8.6)).toBe("more than two bytes per weight — wider encodings or additional stored data");
		expect(describeBytesPerParam(null)).toBeNull();
		expect(humanBytesPerParam(0.562)).toBe("0.56 B/param");
		expect(humanBytesPerParam(null)).toBe("?");
	});
	it("returns all nulls when nothing is known", () => {
		expect(precisionFacts({ config: null, dominantDtype: null, dominantFormat: null })).toEqual({
			label: null,
			method: null,
			detail: null,
			bits: null,
			quantized: null,
		});
	});
});
