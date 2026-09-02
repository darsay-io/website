/**
 * Lineage: family, generation, member, variants, formats, size — read from a
 * work's name. A port of the CLI's `darsay.lineage` (same grammar, same
 * fixture table in `lineage-fixtures.json`), so a board and the CLI agree
 * on every family without a server round trip. Everything here is a fact
 * about the *name* and is labeled so wherever it is shown.
 *
 * Parent edges (finetune, adapter, merge, quantized, trained-on) are not
 * read from names; they arrive in the digest as upstream declared them.
 */

export type Lineage = {
	family: string | null;
	generation: string | null;
	member: string | null;
	variants: string[];
	formats: string[];
	sizeTotal: number | null;
	sizeActive: number | null;
};

export const READ_FROM = "name";

const GENERATION_RE = /^(?<prefix>[A-Za-z]{0,2})(?<number>\d+(?:\.\d+)*)(?<tail>[A-Za-z]?)$/;
const GLUED_RE = /^(?<letters>[A-Za-z]+)(?<number>\d+(?:\.\d+)*)(?<tail>[A-Za-z]?)$/;
const SIZE_RE = /^(?<n>\d+(?:\.\d+)?)(?<unit>[KkMmBbTt])$/;
const ACTIVE_RE = /^[Aa](?<n>\d+(?:\.\d+)?)(?<unit>[MmBbTt])$/;
const EXPERTS_RE = /^(?<experts>\d+)[xX](?<n>\d+(?:\.\d+)?)(?<unit>[MmBbTt])$/;
const UNIT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
const SIZE_UNITS = new Set(["k", "m", "b", "t"]);

const VARIANTS: Array<[string, RegExp]> = [
	["instruct", /^(instruct|it|sft)$/i],
	["chat", /^chat$/i],
	["thinking", /^(thinking|reasoning|reasoner|think)$/i],
	["abliterated", /^(abliterat\w*|obliterat\w*|heretic|ablated)$/i],
	["uncensored", /^uncensored$/i],
	["distill", /^distill\w*$/i],
];
const BASE_CAPITAL = /^Base$/;
const BASE_AFTER_SIZE = /^(base|pt)$/i;
const TIER_WORDS = new Set(["nano", "micro", "tiny", "mini", "small", "base", "medium", "large", "xl", "xxl"]);
const FORMATS: Array<[string, RegExp]> = [
	["gguf", /^gguf$/i],
	["fp8", /^fp8$/i],
	["nvfp4", /^nvfp4$/i],
	["mxfp4", /^mxfp4$/i],
	["fp4", /^fp4$/i],
	["awq", /^awq$/i],
	["gptq", /^gptq$/i],
	["int4", /^(int4|4bit|4-bit|w4a16)$/i],
	["int8", /^(int8|8bit|8-bit|w8a8|w8a16)$/i],
	["bnb", /^(bnb|bitsandbytes)$/i],
	["mlx", /^mlx$/i],
	["exl2", /^exl2$/i],
	["exl3", /^exl3$/i],
	["onnx", /^onnx$/i],
	["safetensors", /^safetensors$/i],
];

function count(n: string, unit: string): number {
	return Number(n) * UNIT[unit.toLowerCase()];
}

function isAlpha(token: string): boolean {
	return /^[A-Za-z]+$/.test(token);
}

function variantOf(token: string, afterSize: boolean): string | null {
	if (BASE_CAPITAL.test(token) || (afterSize && BASE_AFTER_SIZE.test(token))) return "base";
	for (const [name, re] of VARIANTS) if (re.test(token)) return name;
	return null;
}

function formatOf(token: string): string | null {
	for (const [name, re] of FORMATS) if (re.test(token)) return name;
	return null;
}

function isGeneration(token: string): boolean {
	const m = GENERATION_RE.exec(token);
	if (!m?.groups) return false;
	if (m.groups.tail && SIZE_UNITS.has(m.groups.tail.toLowerCase())) return false;
	if (m.groups.prefix.toLowerCase() === "a" && !m.groups.tail) return false;
	return true;
}

/** `K2.5` → [2, 5]; `V3.2` → [3, 2]; null sorts first. */
export function generationSortKey(generation: string | null): number[] {
	if (!generation) return [-1];
	const m = GENERATION_RE.exec(generation);
	if (!m?.groups) return [-1];
	return m.groups.number.split(".").map((p) => Number(p));
}

export function compareGenerations(a: string | null, b: string | null): number {
	const ka = generationSortKey(a);
	const kb = generationSortKey(b);
	const n = Math.max(ka.length, kb.length);
	for (let i = 0; i < n; i++) {
		const x = ka[i] ?? -1;
		const y = kb[i] ?? -1;
		if (x !== y) return x - y;
	}
	return 0;
}

export function parseName(name: string): Lineage {
	let raw = (name ?? "").trim().replace(/^\/+|\/+$/g, "");
	if (raw.includes("/")) raw = raw.slice(raw.lastIndexOf("/") + 1);
	const tokens = raw.split(/[-_\s]+/).filter(Boolean);
	const empty: Lineage = { family: null, generation: null, member: null, variants: [], formats: [], sizeTotal: null, sizeActive: null };
	if (tokens.length === 0) return empty;

	const family: string[] = [];
	let generation: string | null = null;
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (isAlpha(token) && variantOf(token, false) === null && formatOf(token) === null) {
			if (family.length && TIER_WORDS.has(token)) break;
			family.push(token);
			i += 1;
			continue;
		}
		const glued = GLUED_RE.exec(token);
		if (glued?.groups && !SIZE_UNITS.has(glued.groups.tail.toLowerCase()) && !SIZE_RE.test(token)) {
			const letters = glued.groups.letters;
			if (letters.length <= 2 && family.length) {
				generation = token;
			} else {
				family.push(letters);
				generation = glued.groups.number + glued.groups.tail;
			}
			i += 1;
			break;
		}
		if (isGeneration(token) && !SIZE_RE.test(token)) {
			generation = token;
			i += 1;
			break;
		}
		break;
	}
	const rest = tokens.slice(i);

	const memberTokens: string[] = [];
	if (generation) {
		const m = GENERATION_RE.exec(generation);
		if (m?.groups && m.groups.tail && !SIZE_UNITS.has(m.groups.tail.toLowerCase())) {
			generation = m.groups.prefix + m.groups.number;
			memberTokens.push(m.groups.tail);
		}
	}

	const variants: string[] = [];
	const formats: string[] = [];
	let sizeTotal: number | null = null;
	let sizeActive: number | null = null;
	let afterSize = false;
	for (const token of rest) {
		const experts = EXPERTS_RE.exec(token);
		const size = SIZE_RE.exec(token);
		const active = ACTIVE_RE.exec(token);
		if (experts?.groups) {
			const per = count(experts.groups.n, experts.groups.unit);
			if (sizeTotal === null) {
				sizeTotal = per * Number(experts.groups.experts);
				sizeActive = per;
			}
			memberTokens.push(token);
			afterSize = true;
			continue;
		}
		if (size?.groups) {
			if (sizeTotal === null) sizeTotal = count(size.groups.n, size.groups.unit);
			memberTokens.push(token);
			afterSize = true;
			continue;
		}
		if (active?.groups) {
			if (sizeActive === null) sizeActive = count(active.groups.n, active.groups.unit);
			memberTokens.push(token);
			afterSize = true;
			continue;
		}
		const variant = variantOf(token, afterSize);
		if (variant) {
			if (!variants.includes(variant)) variants.push(variant);
			afterSize = false;
			continue;
		}
		const fmt = formatOf(token);
		if (fmt) {
			if (!formats.includes(fmt)) formats.push(fmt);
			afterSize = false;
			continue;
		}
		memberTokens.push(token);
		afterSize = false;
	}

	return {
		family: family.length ? family.join("-") : null,
		generation: generation || null,
		member: memberTokens.length ? memberTokens.join("-") : null,
		variants,
		formats,
		sizeTotal,
		sizeActive,
	};
}

/** The work's name from a source ref or a home URL: the last path segment. */
export function nameOfSource(source: string): string {
	let s = (source ?? "").trim();
	if (s.includes("://")) s = s.slice(s.indexOf("://") + 3);
	s = s.split("?", 1)[0].split("#", 1)[0].replace(/\/+$/, "");
	const colon = s.indexOf(":");
	if (colon > 0 && !s.slice(0, colon).includes("/")) s = s.slice(colon + 1);
	return s ? s.slice(s.lastIndexOf("/") + 1) : "";
}

export function lineageOf(source: string): Lineage {
	return parseName(nameOfSource(source));
}

/** Case-folded family, so `qwen3.8-max` and `Qwen3.8-27B` meet. */
export function familyKey(lin: Lineage): string | null {
	return lin.family ? lin.family.toLowerCase() : null;
}

/** `Qwen 3.8`, `Kimi K3`, or just the family. */
export function displayGeneration(family: string | null, generation: string | null): string {
	if (family && generation) return `${family} ${generation}`;
	return family || generation || "—";
}

/** The publisher (owner) of a provider ref; null for a home URL. */
export function publisherOf(source: string): string | null {
	let s = (source ?? "").trim();
	if (s.includes("://")) return null;
	const colon = s.indexOf(":");
	if (colon > 0) s = s.slice(colon + 1);
	if (s.startsWith("datasets/")) s = s.slice("datasets/".length);
	const parts = s.split("/");
	return parts.length >= 2 && parts[0] ? parts[0] : null;
}

export type FamilyGroup<T> = {
	family: string | null;
	key: string | null;
	homePublisher: string | null;
	count: number;
	generations: Array<{ generation: string | null; rows: Array<{ row: T; lineage: Lineage }> }>;
};

/**
 * Families → generations (oldest first) → members (smallest first), for the
 * lineage view. Rows with no family land in one trailing null group.
 */
export function groupByFamily<T extends { source: string }>(rows: T[]): FamilyGroup<T>[] {
	const families = new Map<string | null, { rows: Array<{ row: T; lineage: Lineage }>; publishers: Map<string, number>; spellings: Map<string, number> }>();
	for (const row of rows) {
		const lin = lineageOf(row.source);
		const key = familyKey(lin);
		let fam = families.get(key);
		if (!fam) {
			fam = { rows: [], publishers: new Map(), spellings: new Map() };
			families.set(key, fam);
		}
		fam.rows.push({ row, lineage: lin });
		const publisher = publisherOf(row.source);
		if (publisher) fam.publishers.set(publisher, (fam.publishers.get(publisher) ?? 0) + 1);
		if (lin.family) fam.spellings.set(lin.family, (fam.spellings.get(lin.family) ?? 0) + 1);
	}
	const out: FamilyGroup<T>[] = [];
	for (const [key, fam] of families) {
		const byGen = new Map<string | null, Array<{ row: T; lineage: Lineage }>>();
		for (const item of fam.rows) {
			const list = byGen.get(item.lineage.generation) ?? [];
			list.push(item);
			byGen.set(item.lineage.generation, list);
		}
		const generations = [...byGen.entries()]
			.sort((a, b) => compareGenerations(a[0], b[0]))
			.map(([generation, members]) => ({
				generation,
				rows: members.sort(
					(a, b) =>
						(a.lineage.sizeTotal ?? 0) - (b.lineage.sizeTotal ?? 0) ||
						(a.lineage.member ?? "").localeCompare(b.lineage.member ?? ""),
				),
			}));
		const mostOf = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
		out.push({
			family: mostOf(fam.spellings),
			key,
			homePublisher: mostOf(fam.publishers),
			count: fam.rows.length,
			generations,
		});
	}
	out.sort((a, b) => Number(a.key === null) - Number(b.key === null) || b.count - a.count || (a.key ?? "").localeCompare(b.key ?? ""));
	return out;
}

/** Family keys present on a board with their display names and counts, largest first. */
export function familiesOf<T extends { source: string }>(rows: T[]): Array<{ key: string; family: string; count: number }> {
	return groupByFamily(rows)
		.filter((f): f is FamilyGroup<T> & { key: string; family: string } => f.key !== null && f.family !== null)
		.map((f) => ({ key: f.key, family: f.family, count: f.count }));
}
