/** File-inventory GGUF variants, a port of the CLI's weight_variants.py. */
import type { SizedFile } from "./hints.ts";
import { ggufLevelOf } from "./precision.ts";
import { matchesInclude } from "./subset.ts";

export type GgufVariant = {
	name: string;
	precision: string | null;
	file_count: number;
	size_bytes: number | null;
	complete: boolean;
	include: string[];
};

export function isProjector(path: string): boolean {
	return /^mmproj(?:[-_.]|$)/i.test(path.slice(path.lastIndexOf("/") + 1));
}

function literalGlob(path: string): string {
	return path.replace(/[\[*?]/g, (c) => ({ "[": "[[]", "*": "[*]", "?": "[?]" })[c]!);
}

type Group = { name: string; items: SizedFile[]; shards: number[]; match: RegExpExecArray | null };

export function ggufVariants(files: SizedFile[], includeProjectors = false): GgufVariant[] {
	const groups = new Map<string, Group>();
	for (const item of files) {
		if (!item.path.toLowerCase().endsWith(".gguf")) continue;
		const match = /^(.*)-(\d+)-of-(\d+)(\.gguf)$/i.exec(item.path);
		const textKey = match ? `${match[1]}-of-${match[3]}${match[4]}` : item.path;
		const key = textKey + "\0" + (match ? "sharded" : "single");
		let group = groups.get(key);
		if (!group) {
			group = { name: match ? match[1] : textKey.slice(0, -5), items: [], shards: [], match };
			groups.set(key, group);
		}
		group.items.push(item);
		if (match) group.shards.push(Number(match[2]));
	}
	const out: GgufVariant[] = [];
	for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
		const items = group.items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		if (!includeProjectors && isProjector(items[0].path)) continue;
		const paths = new Set(items.map((f) => f.path));
		const match = group.match;
		const count = match ? Number(match[3]) : 1;
		const shards = group.shards.sort((a, b) => a - b);
		const complete = items.length === paths.size && (!match || (
			Number.isSafeInteger(count) && count > 0 && count === shards.length && shards.every((n, i) => n === i + 1)
		));
		let include = items.map((f) => "/" + literalGlob(f.path));
		if (match) {
			const pattern = "/" + literalGlob(match[1]) + "-*-of-" + literalGlob(match[3] + match[4]);
			const hits = new Set(files.filter((f) => matchesInclude(f.path, [pattern])).map((f) => f.path));
			if (hits.size === paths.size && [...hits].every((p) => paths.has(p))) include = [pattern];
		}
		out.push({
			name: group.name,
			precision: ggufLevelOf(items[0].path),
			file_count: items.length,
			size_bytes: items.every((f) => f.size !== null) ? items.reduce((n, f) => n + f.size!, 0) : null,
			complete,
			include,
		});
	}
	return out;
}

/** Only one complete model variant describes bytes per model parameter. */
export function modelWeightBytes(files: SizedFile[]): number | null {
	if (files.length && files.every((f) => f.path.toLowerCase().endsWith(".gguf"))) {
		const variants = ggufVariants(files);
		if (variants.length !== 1 || !variants[0].complete) return null;
		return variants[0].size_bytes;
	}
	if (!files.length || files.some((f) => f.size === null)) return null;
	if (files.some((f) => f.path.toLowerCase().endsWith(".gguf"))) return null;
	return files.reduce((n, f) => n + f.size!, 0);
}
