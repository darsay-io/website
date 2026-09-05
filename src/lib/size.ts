/** What a byte count measures, shared by the ledger, recipes, and field guide. */
import { humanBytesPerParam } from "../worker/precision.ts";

export type SizeBasis = "repository" | "selection" | "archive";
export type GgufVariant = {
	name: string;
	precision: string | null;
	file_count: number;
	size_bytes: number | null;
	complete: boolean;
	include: string[];
};
export type SizeFacts = {
	payload_bytes: number | null;
	size_basis?: SizeBasis | null;
	repository_bytes?: number | null;
	unknown_size_count?: number | null;
	parameters?: number | null;
	parameters_source?: "safetensors" | "gguf" | null;
	precision?: string | null;
	dominant_dtype?: string | null;
	bytes_per_param?: number | null;
	gguf_variants?: GgufVariant[];
	classification?: {
		verdicts: Record<string, { sets: number; files: number; bytes: number }>;
		skipped_bytes: number;
		unclassified_count: number;
	} | null;
};

export const SIZE_LABELS: Record<SizeBasis, string> = {
	repository: "repository total",
	selection: "selection",
	archive: "archive",
};

export function humanSize(n: number | null | undefined): string {
	if (n === null || n === undefined) return "—";
	if (n < 1024) return `${n} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Mirrors the CLI's human_params: 2.45T, 27.78B, 596.0M. */
export function humanParams(n: number): string {
	if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	return String(n);
}

export function scopedSize(row: SizeFacts): string {
	const p = scopedSizeParts(row);
	return p.basis ? `${p.amount} ${p.basis}` : p.amount;
}

/** The same price split for a column: the amount on one line, what it covers beneath. */
export function scopedSizeParts(row: SizeFacts): { amount: string; basis: string | null } {
	if (row.payload_bytes === null || !row.size_basis) return { amount: "unpriced", basis: null };
	const partial = (row.unknown_size_count ?? 0) > 0;
	return {
		amount: `${partial ? "≥ " : ""}${humanSize(row.payload_bytes)}`,
		basis: `${SIZE_LABELS[row.size_basis]}${partial ? " · partial" : ""}`,
	};
}

export function variantSize(variant: GgufVariant): string {
	if (variant.size_bytes === null) return "size unknown";
	return `${variant.complete ? "" : "≥ "}${humanSize(variant.size_bytes)} GGUF files${variant.complete ? "" : " · partial"}`;
}

export function modelFacts(row: SizeFacts): string[] {
	const parts: string[] = [];
	if (row.parameters) parts.push(humanParams(row.parameters));
	const precision = row.precision ?? row.dominant_dtype;
	if (precision) parts.push(precision);
	// Producers emit this only for one complete model weight set. The variants
	// inventory always describes the whole repo, even when this row selects one.
	if (typeof row.bytes_per_param === "number") {
		parts.push(humanBytesPerParam(row.bytes_per_param));
	}
	return parts;
}

export function sizeExplanation(row: SizeFacts): string {
	const basis = row.size_basis;
	if (!basis || row.payload_bytes === null) return "No size estimate is available.";
	const lead = basis === "repository"
		? "Every published file at this revision, including alternative weight sets. Classification has not determined the archive size."
		: basis === "selection"
			? "Files selected by this row's include patterns, plus support files."
			: "The classified archive retains negatives, prints without proven recovery, support files, and unresolved weights. Only verified byte duplicates within this bundle are automatically omitted.";
	const unknown = row.unknown_size_count ?? 0;
	return lead + (unknown ? ` ${unknown} file${unknown === 1 ? " has" : "s have"} unknown sizes; the amount is a lower bound.` : "");
}
