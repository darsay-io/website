import { artifactTypeFromSource } from "./sources.ts";

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
};

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
		catalog_schema_version: "1.0.0",
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
	};
}
