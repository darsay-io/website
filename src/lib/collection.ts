/** Collection choices, not preservation verdicts. Mirrored by darsay.collection. */
import guide from "./collection-guide.json";
import type { GgufVariant } from "./size.ts";
import { matchesInclude, selectSubset } from "../worker/subset.ts";
import type { SizedFile } from "../worker/hints.ts";

export const COLLECTION_GUIDE = guide;
export type Intent = keyof typeof guide.intents;
export type Publication = {
	source: string;
	revision: string;
	files: SizedFile[];
	variants: GgufVariant[];
	companions: GgufVariant[];
};
export type CollectionChoice = { source: string; revision: string; include: string[] | null };

/** The room keeps `/*` as its whole-publication marker; a saved row carries no selectors for it. */
export function choiceInclude(include: string[]): string[] | null {
	return include.includes("/*") ? null : [...include];
}

export function bitFamily(precision: string | null): number | null {
	const match = /(?:^|[-_])I?Q([1-8])(?:_|$)/.exec((precision ?? "").toUpperCase());
	return match ? Number(match[1]) : null;
}

export function encodingFamily(precision: string | null): keyof typeof guide.families {
	if (["BF16", "F16", "F32", "F64"].includes((precision ?? "").toUpperCase())) return "float";
	const bits = bitFamily(precision);
	return bits === null ? "unknown" : bits <= 3 ? "compact" : bits <= 5 ? "middle" : "wide";
}

export function startingSelection(variants: GgufVariant[], intent: Intent): string[] {
	if (intent === "whole") return ["/*"];
	const selected: string[] = [];
	for (const bits of intent === "compare" ? [4, 8] : [4]) {
		const options = variants.filter((v) => v.complete && v.size_bytes !== null && bitFamily(v.precision) === bits);
		options.sort((a, b) => a.size_bytes! - b.size_bytes! || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		if (options[0]) selected.push(...options[0].include);
	}
	return [...new Set(selected)].sort();
}

export function selectionTotals(files: SizedFile[], include: string[]) {
	const selected = include.length ? selectSubset(files, include) ?? [] : [];
	return {
		bytes: selected.reduce((sum, f) => sum + (f.size ?? 0), 0),
		files: selected.length,
		unknown: selected.filter((f) => f.size === null).length,
	};
}

export function variantSelected(variant: GgufVariant, include: string[]): boolean {
	return include.includes("/*") || variant.include.every((p) => include.includes(p));
}

/** Switching away from whole publication is an explicit selection of complete groups. */
export function toggleVariant(publication: Publication, include: string[], variant: GgufVariant): string[] {
	const groups = [...publication.variants, ...publication.companions];
	const chosen = groups.filter((v) => v.complete && variantSelected(v, include) && v !== variant);
	if (!variantSelected(variant, include) && variant.complete) chosen.push(variant);
	return [...new Set(chosen.flatMap((v) => v.include))].sort();
}

export function collectionBreakdown(publication: Publication, include: string[]) {
	const groups = [...publication.variants, ...publication.companions];
	const selected = publication.files.filter((f) => matchesInclude(f.path, include));
	const groupIncludes = groups.flatMap((v) => v.include);
	const modelFiles = selected.filter((f) => matchesInclude(f.path, groupIncludes)).length;
	const total = selectionTotals(publication.files, include);
	return { ...total, supporting: total.files - modelFiles };
}

export function collectionSize(bytes: number | null): string {
	if (bytes === null) return "Size unknown";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
	return `${value.toFixed(1)} ${units[unit]}`;
}
