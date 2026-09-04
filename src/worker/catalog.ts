import { lineageOf, READ_FROM } from "../lib/lineage.ts";
import { entryHints } from "./hints.ts";
import { artifactTypeFromSource, canonicalizeSource } from "./sources.ts";
import { CLAIM_TTL_MS } from "./validate.ts";
import type { GgufVariant } from "./gguf.ts";

export const CATALOG_TOP_KEYS = [
	"catalog_schema_version",
	"kind",
	"id",
	"title",
	"curator",
	"note",
	"created",
	"updated",
	"entries",
] as const;

export const DIGEST_KEYS = [
	"as_of",
	"artifact_type",
	"revision",
	"revision_ref",
	"payload_bytes",
	"file_count",
	"license",
	"gated",
	"parameters",
	"dominant_dtype",
	"unknown_size_count",
	"size_basis",
	"repository_bytes",
	"parameters_source",
	"classification",
	"gguf_variants",
	// The closed hint vocabulary.
	"hints",
	// Release precision, bytes per weight, architecture, and declared parents.
	"precision",
	"bytes_per_param",
	"architecture",
	"parents",
] as const;

export const CATALOG_SCHEMA_VERSION = "3.0.0";

export type ParentEdge = { source: string; relation: string | null };
export type SizeBasis = "repository" | "selection" | "archive";
export type ClassificationSummary = {
	verdicts: Record<string, { sets: number; files: number; bytes: number }>;
	skipped_bytes: number;
	unclassified_count: number;
};

export type EstimateDigest = {
	as_of: string;
	artifact_type: string;
	revision: string | null;
	revision_ref: string | null;
	payload_bytes: number | null;
	file_count: number | null;
	license: string | null;
	gated: boolean | null;
	parameters: number | null;
	dominant_dtype: string | null;
	unknown_size_count: number | null;
	size_basis: SizeBasis;
	repository_bytes: number | null;
	parameters_source: "safetensors" | "gguf" | null;
	classification: ClassificationSummary | null;
	gguf_variants: GgufVariant[];
	hints?: string[];
	precision?: string | null;
	bytes_per_param?: number | null;
	architecture?: string | null;
	parents?: ParentEdge[] | null;
};

export type Claim = {
	client: string;
	state: "archiving" | "paused" | "done";
	percent: number | null;
	banked_bytes: number | null;
	total_bytes: number | null;
	claimed_at: string;
	updated: string;
};

export type BoardRow = {
	id: string;
	catalog_id: string;
	title: string;
	curator: string | null;
	note: string | null;
	created: string;
	updated: string;
	/** Bumped by every write; the ETag agents send back as If-Match. */
	revision: number;
};

export type EntryRow = {
	id: number;
	board_id?: string;
	source: string;
	revision: string;
	include_json: string | null;
	include_key?: string;
	desire: number | null;
	note: string | null;
	status: string;
	holders: string;
	added: string;
	/** When a field last changed; null on rows written before the column existed. */
	updated: string | null;
	/** A soft removal, undoable; a dropped row leaves every list and the export. */
	dropped: string | null;
	payload_bytes: number | null;
	estimate_json: string | null;
	claim_json: string | null;
};

/** A row's address, structured: where the work lives and how it is named there. */
export type Address =
	| { kind: "model" | "dataset"; provider: "huggingface"; locator: string; url: string }
	| { kind: "closed"; provider: null; locator: string; url: string }
	| { kind: "opaque"; provider: string; locator: string; url: null };

export function addressOf(source: string): Address {
	const p = canonicalizeSource(source);
	if (p.kind === "hf") return { kind: p.artifactType, provider: "huggingface", locator: p.locator, url: p.url };
	if (p.kind === "home") return { kind: "closed", provider: null, locator: p.canonical, url: p.canonical };
	const i = source.indexOf(":");
	return {
		kind: "opaque",
		provider: i > 0 ? source.slice(0, i).toLowerCase() : "opaque",
		locator: i > 0 ? source.slice(i + 1) : source,
		url: null,
	};
}

export function parseIncludeJson(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as string[];
	} catch {
		return null;
	}
}

/**
 * The fields a person or a program decides on a row — what the audit trail
 * keeps as before and after. Digests and claims are facts, not decisions,
 * so they are left out.
 */
export function rowSnapshot(e: EntryRow) {
	return {
		source: e.source,
		revision: e.revision === "" ? null : e.revision,
		include: parseIncludeJson(e.include_json),
		desire: e.desire,
		note: e.note || null,
		status: e.status,
		holders: e.holders || "",
		dropped: e.dropped ?? null,
	};
}

export type RowSnapshot = ReturnType<typeof rowSnapshot>;

const MAX_DIGEST_STRING = 200;
const MAX_HINTS = 16;
const MAX_HINT = 40;
const MAX_PARENTS = 16;
const MAX_VARIANT_FILES = 256;
const MAX_FILE_PATH = 1024;

function nonnegativeInteger(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

export function cleanClassification(raw: unknown): ClassificationSummary | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	if (!nonnegativeInteger(obj.skipped_bytes) || !nonnegativeInteger(obj.unclassified_count)) return null;
	if (!obj.verdicts || typeof obj.verdicts !== "object" || Array.isArray(obj.verdicts)) return null;
	const verdicts: ClassificationSummary["verdicts"] = {};
	for (const [key, value] of Object.entries(obj.verdicts)) {
		if (!["negative", "print", "unknown"].includes(key)) continue;
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const v = value as Record<string, unknown>;
		if (!nonnegativeInteger(v.sets) || !nonnegativeInteger(v.files) || !nonnegativeInteger(v.bytes)) return null;
		verdicts[key] = { sets: v.sets, files: v.files, bytes: v.bytes };
	}
	return { verdicts, skipped_bytes: obj.skipped_bytes, unclassified_count: obj.unclassified_count };
}

export function cleanGgufVariants(raw: unknown): GgufVariant[] {
	if (!Array.isArray(raw)) return [];
	const out: GgufVariant[] = [];
	for (const value of raw) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const v = value as Record<string, unknown>;
		if (typeof v.name !== "string" || !v.name || v.name.length > MAX_FILE_PATH) continue;
		if (!(v.precision === null || (typeof v.precision === "string" && v.precision.length <= MAX_HINT))) continue;
		if (!nonnegativeInteger(v.file_count) || v.file_count === 0 || typeof v.complete !== "boolean") continue;
		if (!(v.size_bytes === null || nonnegativeInteger(v.size_bytes))) continue;
		if (!Array.isArray(v.include) || !v.include.length || v.include.length > MAX_VARIANT_FILES) continue;
		if (!v.include.every((g) => typeof g === "string" && g.startsWith("/") && g.length <= MAX_FILE_PATH)) continue;
		out.push({ name: v.name, precision: v.precision, file_count: v.file_count, size_bytes: v.size_bytes, complete: v.complete, include: v.include as string[] });
	}
	return out;
}

/** Parent edges from an untrusted digest: `{source, relation}` only. */
export function cleanParents(raw: unknown): ParentEdge[] | null {
	if (!Array.isArray(raw)) return null;
	const out: ParentEdge[] = [];
	for (const edge of raw.slice(0, MAX_PARENTS)) {
		if (edge === null || typeof edge !== "object" || Array.isArray(edge)) continue;
		const e = edge as Record<string, unknown>;
		if (typeof e.source !== "string" || !e.source || e.source.length > MAX_DIGEST_STRING) continue;
		const relation = typeof e.relation === "string" && e.relation.length <= MAX_HINT ? e.relation : null;
		out.push({ source: e.source, relation });
	}
	return out.length ? out : null;
}

/** A digest from an untrusted import: project DIGEST_KEYS, drop bad leaves. */
export function sanitizeDigest(raw: unknown): EstimateDigest | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	if (obj.size_basis !== "repository" && obj.size_basis !== "selection" && obj.size_basis !== "archive") return null;
	const out: Record<string, unknown> = {};
	for (const k of DIGEST_KEYS) {
		if (!(k in obj)) continue;
		const v = obj[k];
		if (v === null) {
			out[k] = null;
		} else if (k === "hints") {
			if (Array.isArray(v)) {
				out[k] = v
					.filter((h): h is string => typeof h === "string" && h.length > 0 && h.length <= MAX_HINT)
					.slice(0, MAX_HINTS);
			}
		} else if (k === "parents") {
			out[k] = cleanParents(v);
		} else if (k === "classification") {
			out[k] = cleanClassification(v);
		} else if (k === "gguf_variants") {
			out[k] = cleanGgufVariants(v);
		} else if (k === "size_basis") {
			if (v === "repository" || v === "selection" || v === "archive") out[k] = v;
		} else if (k === "parameters_source") {
			if (v === "safetensors" || v === "gguf") out[k] = v;
		} else if (["payload_bytes", "repository_bytes", "file_count", "parameters", "unknown_size_count"].includes(k)) {
			if (nonnegativeInteger(v)) out[k] = v;
		} else if (k === "bytes_per_param") {
			if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
		} else if (k === "gated") {
			if (typeof v === "boolean") out[k] = v;
		} else if (typeof v === "string" && v.length <= MAX_DIGEST_STRING) {
			out[k] = v;
		}
	}
	return Object.keys(out).length ? (out as EstimateDigest) : null;
}

export function parseClaim(raw: string | null): Claim | null {
	if (!raw) return null;
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		if (typeof obj.client !== "string" || !obj.client) return null;
		const state = obj.state === "paused" || obj.state === "done" ? obj.state : "archiving";
		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
		return {
			client: obj.client,
			state,
			percent: num(obj.percent),
			banked_bytes: num(obj.banked_bytes),
			total_bytes: num(obj.total_bytes),
			claimed_at: typeof obj.claimed_at === "string" ? obj.claimed_at : "",
			updated: typeof obj.updated === "string" ? obj.updated : "",
		};
	} catch {
		return null;
	}
}

function parseEstimate(raw: string | null): EstimateDigest | null {
	if (!raw) return null;
	try {
		return sanitizeDigest(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function exportCatalog(board: BoardRow, entries: EntryRow[]): Record<string, unknown> {
	return {
		catalog_schema_version: CATALOG_SCHEMA_VERSION,
		kind: "darsay.catalog",
		id: board.catalog_id,
		title: board.title || board.catalog_id,
		curator: board.curator || null,
		note: board.note || null,
		created: board.created,
		updated: board.updated,
		entries: entries.filter((e) => !e.dropped).map((e) => {
			const include = parseIncludeJson(e.include_json);
			return {
				source: e.source,
				revision: e.revision === "" ? null : e.revision,
				include,
				desire: e.desire,
				note: e.note || null,
				added: e.added,
				estimate: parseEstimate(e.estimate_json),
			};
		}),
	};
}

export function entryToApi(e: EntryRow) {
	const include = parseIncludeJson(e.include_json);
	const est = parseEstimate(e.estimate_json);
	const lin = lineageOf(e.source);
	return {
		id: e.id,
		source: e.source,
		revision: e.revision === "" ? null : e.revision,
		include,
		desire: e.desire,
		note: e.note || null,
		status: e.status,
		holders: e.holders || "",
		added: e.added,
		updated: e.updated ?? e.added,
		dropped: e.dropped ?? null,
		// The same address, structured: the provider, the name there, the page.
		address: addressOf(e.source),
		payload_bytes: e.payload_bytes,
		artifact_type: est?.artifact_type ?? artifactTypeFromSource(e.source),
		// Digest facts the board reads to pick recipes for a row. Same fetch as
		// the board itself; the catalog.json export is unchanged.
		gated: typeof est?.gated === "boolean" ? est.gated : null,
		parameters: typeof est?.parameters === "number" ? est.parameters : null,
		parameters_source: est?.parameters_source ?? null,
		size_basis: est?.size_basis ?? null,
		repository_bytes: typeof est?.repository_bytes === "number" ? est.repository_bytes : null,
		unknown_size_count: typeof est?.unknown_size_count === "number" ? est.unknown_size_count : null,
		classification: est?.classification ?? null,
		gguf_variants: est?.gguf_variants ?? [],
		dominant_dtype: typeof est?.dominant_dtype === "string" ? est.dominant_dtype : null,
		// Hints are measured facts; the selection comes from the row address.
		hints: entryHints(est, include),
		// The precision facts and lineage edges the CLI (or the worker's
		// add-time estimate) established; the board reads them on the row.
		precision: typeof est?.precision === "string" ? est.precision : null,
		bytes_per_param: typeof est?.bytes_per_param === "number" ? est.bytes_per_param : null,
		architecture: typeof est?.architecture === "string" ? est.architecture : null,
		parents: cleanParents(est?.parents),
		// A closed work: a home page, not a source. Nothing to fetch, no price.
		closed: canonicalizeSource(e.source).kind === "home",
		// Family, generation, member — read from the name, and labeled so.
		lineage: {
			family: lin.family,
			generation: lin.generation,
			member: lin.member,
			variants: lin.variants,
			formats: lin.formats,
			read_from: READ_FROM,
		},
		claim: liveClaim(parseClaim(e.claim_json)),
	};
}

export type ApiRow = ReturnType<typeof entryToApi>;

/** A claim past the TTL is over: it stops rendering as in flight, the same
 * moment it stops blocking new claims. Undated claims count as expired. */
export function liveClaim(claim: Claim | null, now = Date.now()): Claim | null {
	if (!claim) return null;
	const t = Date.parse(claim.updated || claim.claimed_at);
	return Number.isFinite(t) && now - t < CLAIM_TTL_MS ? claim : null;
}
