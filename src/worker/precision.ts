/**
 * Precision: the release precision of a work's weights, and bytes per
 * parameter — a port of the CLI's `darsay.precision`. The one number that
 * explains every size is bytes per parameter; the label names the precision
 * a repo was published at (`BF16`, `FP8`, `MXFP4`, `AWQ INT4`, `Q4_K_M`)
 * from `config.json`'s `quantization_config` (wherever a multimodal config
 * nests it), the dominant safetensors dtype, or — when GGUF is all a repo
 * ships — the quant level in a file name. Nothing here opens a weight file,
 * and a label nothing establishes is null.
 */

export const FULL_FIDELITY = new Set(["F64", "F32", "F16", "BF16"]);

const NOMINAL_BITS: Record<string, number> = {
	F64: 64,
	F32: 32,
	F16: 16,
	BF16: 16,
	FP8: 8,
	INT8: 8,
	I8: 8,
	U8: 8,
	MXFP4: 4,
	NVFP4: 4,
	FP4: 4,
	INT4: 4,
	NF4: 4,
	INT3: 3,
	INT2: 2,
};
const DTYPE_LABELS: Record<string, string> = {
	FLOAT64: "F64",
	FLOAT32: "F32",
	FLOAT16: "F16",
	BFLOAT16: "BF16",
	F8_E4M3: "FP8",
	F8_E5M2: "FP8",
	F8_E4M3FN: "FP8",
	F8_E8M0: "FP8",
};
const GGUF_LEVEL_RE = /(?:^|[-._])(?<level>(?:UD-)?(?:I?Q\d(?:_[A-Za-z0-9]+)*|F16|BF16|F32|MXFP4(?:_MOE)?|TQ\d(?:_\d)?))(?=[-._]|$)/i;
const GGUF_BITS_RE = /^(?:UD-)?I?Q(?<bits>\d)/i;

export type Precision = {
	label: string | null;
	method: string | null;
	detail: string | null;
	bits: number | null;
	quantized: boolean | null;
};

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function bitsOf(weights: Dict): number | null {
	for (const key of ["num_bits", "bits", "w_bit", "wbits"]) {
		const v = weights[key];
		if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
	}
	return null;
}

/** The `quantization_config`, top level or nested one level down (`text_config`). */
export function quantizationConfigOf(config: unknown): Dict | null {
	if (!isDict(config)) return null;
	if (isDict(config.quantization_config)) return config.quantization_config;
	for (const value of Object.values(config)) {
		if (isDict(value) && isDict(value.quantization_config)) return value.quantization_config;
	}
	return null;
}

/** `torch_dtype` (or the newer `dtype`), top level or one level down. */
export function torchDtypeOf(config: unknown): string | null {
	if (!isDict(config)) return null;
	for (const key of ["torch_dtype", "dtype"]) if (typeof config[key] === "string") return config[key] as string;
	for (const value of Object.values(config)) {
		if (!isDict(value)) continue;
		for (const key of ["torch_dtype", "dtype"]) if (typeof value[key] === "string") return value[key] as string;
	}
	return null;
}

export function precisionFromConfig(config: unknown): Omit<Precision, "quantized"> | null {
	const qc = quantizationConfigOf(config);
	if (qc) {
		const method = String(qc.quant_method ?? "unspecified").toLowerCase();
		const fmt = String(qc.format ?? "").toLowerCase();
		let bits = bitsOf(qc);
		let groupSize: unknown = null;
		let weightsType: unknown = null;
		if (isDict(qc.config_groups)) {
			for (const group of Object.values(qc.config_groups)) {
				if (!isDict(group)) continue;
				const weights = group.weights;
				if (isDict(weights)) {
					bits = bits ?? bitsOf(weights);
					groupSize = groupSize ?? weights.group_size ?? null;
					weightsType = weightsType ?? weights.type ?? null;
					break;
				}
			}
		}
		groupSize = groupSize ?? qc.group_size ?? qc.q_group_size ?? null;
		let label: string;
		if (method === "fp8" || (fmt.startsWith("float-quantized") && bits === 8)) {
			label = "FP8";
			bits = bits ?? 8;
		} else if (method === "compressed-tensors") {
			if (fmt.includes("mxfp4")) label = "MXFP4";
			else if (fmt.includes("nvfp4")) label = "NVFP4";
			else if (weightsType === "float" && bits === 4) label = "FP4";
			else if (weightsType === "float" && bits === 8) label = "FP8";
			else if (bits) label = `INT${bits}`;
			else label = "COMPRESSED";
		} else if (method === "awq") {
			label = `AWQ INT${bits ?? 4}`;
			bits = bits ?? 4;
		} else if (method === "gptq") {
			label = `GPTQ INT${bits ?? 4}`;
			bits = bits ?? 4;
		} else if (method === "bitsandbytes") {
			if (qc.load_in_4bit || qc.bnb_4bit_quant_type) {
				label = String(qc.bnb_4bit_quant_type ?? "nf4").toUpperCase();
				bits = 4;
			} else {
				label = "INT8";
				bits = 8;
			}
		} else if (method === "mxfp4" || method === "nvfp4" || method === "fp4") {
			label = method.toUpperCase();
			bits = 4;
		} else if (method === "int4" || method === "int8") {
			label = method.toUpperCase();
			bits = Number(method.slice(3));
		} else {
			label = method.toUpperCase() + (bits ? ` ${bits}-bit` : "");
		}
		const detail = [method, ...(fmt ? [fmt] : []), ...(bits ? [`${bits}-bit`] : []), ...(groupSize ? [`group ${groupSize}`] : [])].join(" · ");
		return { label, method, detail, bits };
	}
	if (isDict(config) && isDict(config.quantization) && bitsOf(config.quantization)) {
		const bits = bitsOf(config.quantization)!;
		const group = config.quantization.group_size;
		return { label: `MLX ${bits}-bit`, method: "mlx", detail: `mlx · ${bits}-bit${group ? ` · group ${group}` : ""}`, bits };
	}
	return null;
}

export function ggufLevelOf(path: string): string | null {
	let name = path.slice(path.lastIndexOf("/") + 1);
	if (name.toLowerCase().endsWith(".gguf")) name = name.slice(0, -5);
	const m = GGUF_LEVEL_RE.exec(name);
	return m?.groups ? m.groups.level.toUpperCase() : null;
}

export function ggufBits(level: string | null): number | null {
	if (!level) return null;
	const upper = level.toUpperCase();
	if (upper === "F16" || upper === "BF16") return 16;
	if (upper === "F32") return 32;
	if (upper.startsWith("MXFP4")) return 4;
	const m = GGUF_BITS_RE.exec(upper);
	return m?.groups ? Number(m.groups.bits) : null;
}

export type PrecisionInput = {
	config: unknown;
	dominantDtype: string | null | undefined;
	dominantFormat: string | null | undefined;
	weightPaths?: string[];
};

export function precisionFacts(i: PrecisionInput): Precision {
	const empty: Precision = { label: null, method: null, detail: null, bits: null, quantized: null };
	const paths = i.weightPaths ?? [];
	const onlyGguf = paths.length > 0 && paths.every((p) => p.toLowerCase().endsWith(".gguf"));
	const ggufShaped = typeof i.dominantFormat === "string" && i.dominantFormat.toLowerCase() === "gguf";
	if (onlyGguf || (ggufShaped && paths.length === 0)) {
		const levels = [...new Set(paths.map(ggufLevelOf).filter((l): l is string => l !== null))].sort();
		if (levels.length === 1) {
			const bits = ggufBits(levels[0]);
			return { label: levels[0], method: "gguf file name", detail: `GGUF · ${levels[0]}`, bits, quantized: bits !== null && bits < 16 };
		}
		if (levels.length > 1) {
			return {
				label: "GGUF",
				method: "gguf file names",
				detail: `GGUF pack · ${levels.length} quant levels (${levels[0]} … ${levels[levels.length - 1]})`,
				bits: null,
				quantized: true,
			};
		}
		return { ...empty, label: "GGUF", method: "file format", quantized: true };
	}
	const declared = precisionFromConfig(i.config);
	let dominant = i.dominantDtype ?? null;
	if (!dominant) dominant = torchDtypeOf(i.config);
	if (declared) return { ...declared, quantized: declared.bits === null || declared.bits < 16 };
	if (dominant) {
		const upper = dominant.toUpperCase();
		const label = DTYPE_LABELS[upper] ?? upper;
		return {
			label,
			method: "safetensors dtype",
			detail: label !== upper ? upper : null,
			bits: NOMINAL_BITS[label] ?? null,
			quantized: !FULL_FIDELITY.has(label),
		};
	}
	return empty;
}

/** Measured bytes per parameter, three decimals, or null. */
export function bytesPerParam(weightBytes: number | null | undefined, parameters: number | null | undefined): number | null {
	if (typeof weightBytes !== "number" || typeof parameters !== "number") return null;
	if (!Number.isFinite(weightBytes) || !Number.isFinite(parameters)) return null;
	if (weightBytes <= 0 || parameters <= 0) return null;
	return Math.round((weightBytes / parameters) * 1000) / 1000;
}

/** The sentence a collector needs beside the number. */
export function describeBytesPerParam(bpp: number | null | undefined): string | null {
	if (bpp === null || bpp === undefined) return null;
	if (bpp >= 3.5) return "well over one full-fidelity copy — the repo likely ships several weight sets";
	if (bpp >= 1.75) return "about one full-fidelity copy (16-bit)";
	if (bpp >= 0.85) return "about one byte per weight — an 8-bit release";
	if (bpp >= 0.4) return "about half a byte per weight — a 4-bit release";
	return "under half a byte per weight — 2- or 3-bit, or a subset of the weights";
}

export function humanBytesPerParam(bpp: number | null | undefined): string {
	if (bpp === null || bpp === undefined) return "?";
	return `${bpp.toFixed(2)} B/param`;
}
