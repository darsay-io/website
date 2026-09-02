import { entryHints } from "./hints.ts";
import { artifactTypeFromSource } from "./sources.ts";
import { CLAIM_TTL_MS } from "./validate.ts";

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
	// Since catalog schema 1.2.0 (darsay 0.14.4): the closed hint
	// vocabulary and the masters-policy marker, written by the CLI.
	"hints",
	"policy",
] as const;

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
	hints?: string[];
	policy?: string | null;
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
};

export type EntryRow = {
	id: number;
	source: string;
	revision: string;
	include_json: string | null;
	desire: number | null;
	note: string | null;
	status: string;
	holders: string;
	added: string;
	payload_bytes: number | null;
	estimate_json: string | null;
	claim_json: string | null;
};

const MAX_DIGEST_STRING = 200;
const MAX_HINTS = 16;
const MAX_HINT = 40;

/** A digest from an untrusted import: project DIGEST_KEYS, drop bad leaves. */
export function sanitizeDigest(raw: unknown): EstimateDigest | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
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
		} else if (typeof v === "boolean" || typeof v === "number") {
			out[k] = v;
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
		const obj = JSON.parse(raw) as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k of DIGEST_KEYS) {
			if (k in obj) out[k] = obj[k];
		}
		return out as EstimateDigest;
	} catch {
		return null;
	}
}

export function exportCatalog(board: BoardRow, entries: EntryRow[]): Record<string, unknown> {
	return {
		catalog_schema_version: "1.2.0",
		kind: "darsay.catalog",
		id: board.catalog_id,
		title: board.title || board.catalog_id,
		curator: board.curator || null,
		note: board.note || null,
		created: board.created,
		updated: board.updated,
		entries: entries.map((e) => {
			let include: string[] | null = null;
			if (e.include_json) {
				try {
					include = JSON.parse(e.include_json) as string[];
				} catch {
					include = null;
				}
			}
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
	let include: string[] | null = null;
	if (e.include_json) {
		try {
			include = JSON.parse(e.include_json) as string[];
		} catch {
			include = null;
		}
	}
	const est = parseEstimate(e.estimate_json);
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
		payload_bytes: e.payload_bytes,
		artifact_type: est?.artifact_type ?? artifactTypeFromSource(e.source),
		// Digest facts the board reads to pick recipes for a row. Same fetch as
		// the board itself; the catalog.json export is unchanged.
		gated: typeof est?.gated === "boolean" ? est.gated : null,
		parameters: typeof est?.parameters === "number" ? est.parameters : null,
		dominant_dtype: typeof est?.dominant_dtype === "string" ? est.dominant_dtype : null,
		// Stored hints win (the CLI wrote them); a digest without any is read
		// the way the CLI's derive_hints reads a 1.0.0 file.
		hints: entryHints(est, include),
		policy: typeof est?.policy === "string" ? est.policy : null,
		claim: liveClaim(parseClaim(e.claim_json)),
	};
}

/** A claim past the TTL is over: it stops rendering as in flight, the same
 * moment it stops blocking new claims. Undated claims count as expired. */
export function liveClaim(claim: Claim | null, now = Date.now()): Claim | null {
	if (!claim) return null;
	const t = Date.parse(claim.updated || claim.claimed_at);
	return Number.isFinite(t) && now - t < CLAIM_TTL_MS ? claim : null;
}
