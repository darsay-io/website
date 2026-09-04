/**
 * Everything a board can do, as plain operations: the REST routes and the
 * MCP tools are two doors into this one room. An operation takes a
 * context (the board, the grant, the actor, the revision the caller
 * expects) and returns a status and a body; nothing here knows about
 * HTTP headers or JSON-RPC.
 *
 * Words: a board has rows (never cards), a row wants or has a work,
 * desire orders the list, a row is dropped (undoable) or removed (gone).
 */
import { applyLenses, isLensKey, type LensEntry, type LensKey } from "../lib/lenses.ts";
import { familyKey, lineageOf } from "../lib/lineage.ts";
import { can, grantToApi, type Grant, type Scope } from "./access.ts";
import {
	applyFields,
	diffFields,
	identityKey,
	parseFields,
	parseIdentity,
	parseRef,
	planApply,
	rowIdentityKey,
	summarize,
	type Identity,
	type Intent,
	type PlanStep,
	type RowFields,
} from "./apply.ts";
import {
	CATALOG_SCHEMA_VERSION,
	addressOf,
	entryToApi,
	exportCatalog,
	parseClaim,
	rowSnapshot,
	sanitizeDigest,
	type ApiRow,
	type BoardRow,
	type EntryRow,
} from "./catalog.ts";
import { fetchEstimate } from "./estimate.ts";
import { announce, auditToApi, commit, type Actor, type AuditEvent, type AuditRow } from "./ledger.ts";
import { canonicalizeSource, type HfCanonical } from "./sources.ts";
import {
	CLAIM_TTL_MS,
	MAX_BOARD_NOTE,
	MAX_CLIENT,
	MAX_CURATOR,
	MAX_ENTRIES,
	MAX_ENTRY_NOTE,
	MAX_REVISION,
	MAX_SOURCE,
	MAX_TITLE,
	clampStr,
	foldSlug,
	includeJson,
	includeKey,
	parseCatalogId,
	parseDesire,
	parseInclude,
	utcNow,
} from "./validate.ts";

export type OpCtx = {
	db: D1Database;
	board: BoardRow;
	grant: Grant;
	actor: Actor;
	/** The revision the caller believes the board is at (If-Match), or null. */
	expectRevision: number | null;
	origin: string;
	waitUntil: (p: Promise<unknown>) => void;
};

export type OpResult = { status: number; body: unknown; headers?: Record<string, string> };

/** Rows in one apply or batch call. */
export const MAX_APPLY_ROWS = 100;
/**
 * New Hub rows priced on the spot per call. Each price is up to three
 * subrequests; the rest of a large list lands unpriced and is priced by
 * the next `darsay estimate <board>` round trip.
 */
export const PRICE_BUDGET = 12;
export const MAX_AUDIT_PAGE = 200;

export type DroppedMode = "none" | "all" | "only";

function fail(status: number, error: string, extra: Record<string, unknown> = {}): OpResult {
	return { status, body: { error, ...extra } };
}

function need(ctx: OpCtx, scope: Scope): OpResult | null {
	return can(ctx.grant, scope) ? null : fail(403, "forbidden", { scope, scopes: [...ctx.grant.scopes] });
}

function stale(ctx: OpCtx): OpResult | null {
	if (ctx.expectRevision === null || ctx.expectRevision === ctx.board.revision) return null;
	return fail(412, "stale", { revision: ctx.board.revision, expected: ctx.expectRevision });
}

export function etag(revision: number): string {
	return '"' + String(revision) + '"';
}

export function parseDropped(raw: unknown): DroppedMode {
	return raw === "all" ? "all" : raw === "only" ? "only" : "none";
}

/** The board's rows in the canonical order: desire high to low, unrated last, then as added. */
export async function loadRows(db: D1Database, boardId: string, dropped: DroppedMode = "none"): Promise<EntryRow[]> {
	const where = dropped === "all" ? "" : dropped === "only" ? " AND dropped IS NOT NULL" : " AND dropped IS NULL";
	const res = await db
		.prepare(
			`SELECT * FROM entries WHERE board_id = ?${where}
			 ORDER BY CASE WHEN desire IS NULL THEN 1 ELSE 0 END, desire DESC, id ASC`,
		)
		.bind(boardId)
		.all<EntryRow>();
	return res.results ?? [];
}

export async function loadRow(db: D1Database, boardId: string, id: number): Promise<EntryRow | null> {
	if (!Number.isInteger(id) || id < 1) return null;
	return db.prepare("SELECT * FROM entries WHERE id = ? AND board_id = ?").bind(id, boardId).first<EntryRow>();
}

async function reloadBoard(ctx: OpCtx): Promise<BoardRow> {
	const b = await ctx.db.prepare("SELECT * FROM boards WHERE id = ?").bind(ctx.board.id).first<BoardRow>();
	if (b) ctx.board = b;
	return ctx.board;
}

export function counts(rows: EntryRow[]) {
	const live = rows.filter((r) => !r.dropped);
	const now = Date.now();
	let claimed = 0;
	for (const r of live) {
		const c = parseClaim(r.claim_json);
		if (!c || c.state === "done") continue;
		const t = Date.parse(c.updated || c.claimed_at);
		if (Number.isFinite(t) && now - t < CLAIM_TTL_MS) claimed += 1;
	}
	return {
		rows: live.length,
		want: live.filter((r) => r.status === "want").length,
		have: live.filter((r) => r.status === "have").length,
		claimed,
		dropped: rows.length - live.length,
	};
}

export function links(ctx: OpCtx) {
	const o = ctx.origin;
	const base = ctx.grant.via === "url" ? o + "/api/boards/" + ctx.board.id : o + "/api/board";
	return {
		...(ctx.grant.via === "url" ? { page: o + "/b/" + ctx.board.id, json: o + "/b/" + ctx.board.id + ".json" } : {}),
		api: base,
		catalog: base + "/catalog.json",
		openapi: o + "/openapi.json",
		mcp: o + "/mcp",
		card: o + "/.well-known/mcp-server-card",
		docs: o + "/docs/board/",
	};
}

// ---------------------------------------------------------------- board

export async function opBoard(ctx: OpCtx, q: { dropped?: unknown } = {}): Promise<OpResult> {
	const denied = need(ctx, "read");
	if (denied) return denied;
	const all = await loadRows(ctx.db, ctx.board.id, "all");
	const mode = parseDropped(q.dropped);
	const shown = mode === "all" ? all : mode === "only" ? all.filter((r) => r.dropped) : all.filter((r) => !r.dropped);
	const b = ctx.board;
	return {
		status: 200,
		headers: { ETag: etag(b.revision) },
		body: {
			...(ctx.grant.via === "url" ? { id: b.id } : {}),
			catalog_id: b.catalog_id,
			title: b.title,
			curator: b.curator,
			note: b.note,
			created: b.created,
			updated: b.updated,
			revision: b.revision,
			access: grantToApi(ctx.grant),
			counts: counts(all),
			order: "desire desc, unrated last, then as added",
			entries: shown.map(entryToApi),
			links: links(ctx),
		},
	};
}

export async function opBoardPatch(ctx: OpCtx, body: Record<string, unknown>): Promise<OpResult> {
	const denied = need(ctx, "write") ?? stale(ctx);
	if (denied) return denied;
	const board = ctx.board;
	const title = body.title === undefined ? board.title : clampStr(body.title, MAX_TITLE);
	const curator = body.curator === undefined ? board.curator : clampStr(body.curator, MAX_CURATOR);
	const note = body.note === undefined ? board.note : clampStr(body.note, MAX_BOARD_NOTE);
	if (body.title !== undefined && title === null) return fail(400, "field too long");
	if (body.curator !== undefined && curator === null) return fail(400, "field too long");
	if (body.note !== undefined && note === null) return fail(400, "field too long");
	let catalogId = board.catalog_id;
	if (body.catalog_id !== undefined) {
		const cat = parseCatalogId(body.catalog_id, typeof title === "string" ? title : board.title);
		if (!cat.ok) return fail(400, cat.error);
		catalogId = cat.id;
	}
	const before = { title: board.title, curator: board.curator, note: board.note, catalog_id: board.catalog_id };
	const after = { title: title as string, curator: curator || null, note: note || null, catalog_id: catalogId };
	const changed = JSON.stringify(before) !== JSON.stringify(after);
	if (!changed) return { status: 200, body: { ok: true, updated: board.updated, catalog_id: catalogId, revision: board.revision } };
	const res = await commit(
		ctx.db,
		board,
		ctx.actor,
		[{ action: "board.updated", entry_id: null, before, after }],
		[
			ctx.db
				.prepare("UPDATE boards SET title = ?, curator = ?, note = ?, catalog_id = ? WHERE id = ?")
				.bind(after.title, after.curator, after.note, catalogId, board.id),
		],
	);
	if (!res.ok) return fail(res.status, res.error);
	await announce(ctx.db, { ...board, ...after }, ctx.actor, [{ action: "board.updated", entry_id: null, before, after }], res.revision, res.now, ctx.waitUntil);
	return { status: 200, body: { ok: true, updated: res.now, catalog_id: catalogId, revision: res.revision } };
}

// ----------------------------------------------------------------- rows

export type RowQuery = {
	q?: unknown;
	source?: unknown;
	status?: unknown;
	type?: unknown;
	lens?: unknown;
	family?: unknown;
	desire_min?: unknown;
	desire_max?: unknown;
	dropped?: unknown;
	limit?: unknown;
};

function asLensEntry(row: ApiRow): LensEntry {
	return row as unknown as LensEntry;
}

function intOrNull(v: unknown): number | null {
	if (typeof v === "number" && Number.isInteger(v)) return v;
	if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
	return null;
}

/** Find rows: the board's own lens vocabulary, plus text and address matches. */
export async function opRows(ctx: OpCtx, q: RowQuery = {}): Promise<OpResult> {
	const denied = need(ctx, "read");
	if (denied) return denied;
	let rows = (await loadRows(ctx.db, ctx.board.id, parseDropped(q.dropped))).map(entryToApi);
	if (typeof q.source === "string" && q.source.trim()) {
		if (q.source.length > MAX_SOURCE) return fail(400, "invalid source");
		const parsed = canonicalizeSource(q.source);
		if (parsed.kind === "error") return fail(400, parsed.error);
		const want = parsed.canonical;
		const alt = parsed.kind === "hf" && parsed.artifactType === "model" ? "huggingface:datasets/" + parsed.locator : null;
		rows = rows.filter((r) => r.source === want || (alt !== null && r.source === alt));
	}
	if (q.status !== undefined && q.status !== "") {
		if (q.status !== "want" && q.status !== "have") return fail(400, "invalid status");
		rows = rows.filter((r) => r.status === q.status);
	}
	if (q.type !== undefined && q.type !== "") {
		if (!["model", "dataset", "closed", "opaque"].includes(String(q.type))) return fail(400, "invalid type");
		rows = rows.filter((r) => r.address.kind === q.type);
	}
	const lensKeys: LensKey[] = [];
	if (typeof q.lens === "string" && q.lens.trim()) {
		for (const k of q.lens.split(",").map((s) => s.trim()).filter(Boolean)) {
			if (!isLensKey(k)) return fail(400, "unknown lens", { lens: k.slice(0, 40) });
			lensKeys.push(k);
		}
	}
	const family = typeof q.family === "string" && q.family.trim() ? foldSlug(q.family) : null;
	if (lensKeys.length || family) {
		const kept = new Set(applyLenses(rows.map(asLensEntry), lensKeys, family));
		rows = rows.filter((r) => kept.has(asLensEntry(r)));
	}
	const min = intOrNull(q.desire_min);
	const max = intOrNull(q.desire_max);
	if (min !== null) rows = rows.filter((r) => r.desire !== null && r.desire >= min);
	if (max !== null) rows = rows.filter((r) => r.desire !== null && r.desire <= max);
	if (typeof q.q === "string" && q.q.trim()) {
		const needle = q.q.trim().toLowerCase();
		rows = rows.filter((r) =>
			[r.source, r.note ?? "", r.holders, r.lineage.family ?? "", r.lineage.member ?? "", r.address.locator]
				.join("\n")
				.toLowerCase()
				.includes(needle),
		);
	}
	const total = rows.length;
	const limit = intOrNull(q.limit);
	if (limit !== null && limit >= 0) rows = rows.slice(0, limit);
	return {
		status: 200,
		headers: { ETag: etag(ctx.board.revision) },
		body: { revision: ctx.board.revision, count: total, entries: rows },
	};
}

export async function opRow(ctx: OpCtx, id: number): Promise<OpResult> {
	const denied = need(ctx, "read");
	if (denied) return denied;
	const row = await loadRow(ctx.db, ctx.board.id, id);
	if (!row) return fail(404, "not_found");
	return { status: 200, headers: { ETag: etag(ctx.board.revision) }, body: entryToApi(row) };
}

type Priced = { canonical: string; estimateJson: string | null; payloadBytes: number | null; priced: boolean };

async function price(identity: Identity): Promise<Priced> {
	if (identity.kind !== "hf") return { canonical: identity.canonical, estimateJson: null, payloadBytes: null, priced: false };
	const hit = await fetchEstimate(identity.parsed as HfCanonical, identity.revision || null, identity.include);
	if (!hit) return { canonical: identity.canonical, estimateJson: null, payloadBytes: null, priced: false };
	return {
		canonical: hit.parsed.canonical,
		estimateJson: JSON.stringify(hit.digest),
		payloadBytes: hit.digest.payload_bytes,
		priced: true,
	};
}

function findByIdentity(rows: EntryRow[], canonical: string, revision: string, key: string): EntryRow | undefined {
	const want = identityKey(canonical, revision, key);
	return rows.find((r) => rowIdentityKey(r) === want);
}

function insertStmt(db: D1Database, boardId: string, identity: Identity, canonical: string, fields: RowFields, priced: Priced, now: string) {
	return db
		.prepare(
			`INSERT INTO entries (board_id, source, revision, include_json, include_key, desire, note, status, holders, added, updated, payload_bytes, estimate_json)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			 WHERE (SELECT COUNT(*) FROM entries WHERE board_id = ?) < ?`,
		)
		.bind(
			boardId,
			canonical,
			identity.revision,
			identity.includeJson,
			identity.includeKey,
			fields.desire ?? null,
			fields.note || null,
			fields.status ?? "want",
			fields.holders ?? "",
			now,
			now,
			priced.payloadBytes,
			priced.estimateJson,
			boardId,
			MAX_ENTRIES,
		);
}

function updateFieldsStmt(db: D1Database, row: EntryRow, fields: RowFields, now: string, extra: { dropped?: null; source?: string; priced?: Priced } = {}) {
	const after = applyFields(row, fields);
	return db
		.prepare(
			`UPDATE entries SET desire = ?, note = ?, status = ?, holders = ?, updated = ?, dropped = ?, source = ?,
			 payload_bytes = ?, estimate_json = ? WHERE id = ?`,
		)
		.bind(
			after.desire,
			after.note,
			after.status,
			after.holders,
			now,
			extra.dropped === null ? null : row.dropped,
			extra.source ?? row.source,
			extra.priced?.priced ? extra.priced.payloadBytes : row.payload_bytes,
			extra.priced?.priced ? extra.priced.estimateJson : row.estimate_json,
			row.id,
		);
}

function snapshotAfter(row: EntryRow, fields: RowFields, extra: { dropped?: null; source?: string } = {}) {
	const after = applyFields(row, fields);
	if (extra.dropped === null) after.dropped = null;
	if (extra.source) after.source = extra.source;
	return rowSnapshot(after);
}

/**
 * Add a row, or update the row that already has this address. The answer
 * is 201 for a new row, 200 for one that was there (updated, restored, or
 * left exactly as it was — the last costs no write and no revision).
 */
export async function opRowAdd(ctx: OpCtx, body: Record<string, unknown>): Promise<OpResult> {
	const denied = need(ctx, "write") ?? stale(ctx);
	if (denied) return denied;
	const idn = parseIdentity(body);
	if (!idn.ok) return fail(400, idn.error);
	const flds = parseFields(body);
	if (!flds.ok) return fail(400, flds.error);
	const identity = idn.identity;
	const rows = await loadRows(ctx.db, ctx.board.id, "all");
	let existing = findByIdentity(rows, identity.canonical, identity.revision, identity.includeKey);
	// A priced row that is already here, with nothing to change, costs no
	// fetch and no write. An unpriced one is priced again — the Hub may
	// know it now, or know it only as a dataset.
	if (body.refresh !== undefined && typeof body.refresh !== "boolean") return fail(400, "refresh must be a boolean");
	const settled = !!existing && !existing.dropped && existing.estimate_json !== null && body.refresh !== true;
	if (settled && diffFields(existing!, flds.fields).length === 0) {
		return { status: 200, headers: { ETag: etag(ctx.board.revision) }, body: entryToApi(existing!) };
	}
	const now = utcNow();
	const priced = settled ? { canonical: identity.canonical, estimateJson: null, payloadBytes: null, priced: false } : await price(identity);
	if (body.refresh === true && !priced.priced) return fail(502, "estimate_unavailable");
	if (!existing && priced.canonical !== identity.canonical) {
		existing = findByIdentity(rows, priced.canonical, identity.revision, identity.includeKey);
	}
	const events: AuditEvent[] = [];
	const stmts: D1PreparedStatement[] = [];
	if (existing) {
		const restoring = !!existing.dropped;
		const before = rowSnapshot(existing);
		const after = snapshotAfter(existing, flds.fields, { dropped: null, source: priced.canonical });
		stmts.push(updateFieldsStmt(ctx.db, existing, flds.fields, now, { dropped: null, source: priced.canonical, priced }));
		events.push({ action: restoring ? "row.restored" : "row.updated", entry_id: existing.id, before, after });
	} else {
		if (rows.length >= MAX_ENTRIES) return fail(400, "entry_cap");
		stmts.push(insertStmt(ctx.db, ctx.board.id, identity, priced.canonical, flds.fields, priced, now));
	}
	const res = await commit(ctx.db, ctx.board, ctx.actor, events, stmts);
	if (!res.ok) return fail(res.status, res.error);
	const row = existing
		? await loadRow(ctx.db, ctx.board.id, existing.id)
		: await ctx.db
				.prepare("SELECT * FROM entries WHERE board_id = ? AND source = ? AND revision = ? AND include_key = ?")
				.bind(ctx.board.id, priced.canonical, identity.revision, identity.includeKey)
				.first<EntryRow>();
	if (!row) return fail(400, "entry_cap");
	if (!existing) {
		// The insert had no id to audit until now: record it against the row it made.
		await ctx.db
			.prepare(
				`INSERT INTO audit (board_id, at, actor_json, action, entry_id, before_json, after_json, revision)
				 VALUES (?, ?, ?, 'row.added', ?, NULL, ?, ?)`,
			)
			.bind(ctx.board.id, res.now, JSON.stringify(ctx.actor), row.id, JSON.stringify(rowSnapshot(row)), res.revision)
			.run();
		events.push({ action: "row.added", entry_id: row.id, before: null, after: rowSnapshot(row) });
	}
	await reloadBoard(ctx);
	await announce(ctx.db, ctx.board, ctx.actor, events, res.revision, res.now, ctx.waitUntil);
	return { status: existing ? 200 : 201, headers: { ETag: etag(res.revision) }, body: entryToApi(row) };
}

/** Change any subset of a row's columns; a changed address is re-priced and must not collide. */
export async function opRowPatch(ctx: OpCtx, id: number, body: Record<string, unknown>): Promise<OpResult> {
	const denied = need(ctx, "write") ?? stale(ctx);
	if (denied) return denied;
	const existing = await loadRow(ctx.db, ctx.board.id, id);
	if (!existing) return fail(404, "not_found");

	let canonical = existing.source;
	let srcKind: ReturnType<typeof canonicalizeSource> | null = null;
	if (body.source !== undefined) {
		if (typeof body.source !== "string" || body.source.length > MAX_SOURCE) return fail(400, "invalid source");
		srcKind = canonicalizeSource(body.source);
		if (srcKind.kind === "error") return fail(400, srcKind.error);
		canonical = srcKind.canonical;
	}
	let rev = existing.revision;
	if (body.revision !== undefined) {
		if (body.revision === null) rev = "";
		else if (typeof body.revision !== "string" || body.revision.length > MAX_REVISION) return fail(400, "invalid revision");
		else rev = body.revision;
	}
	let include = existing.include_json ? (JSON.parse(existing.include_json) as string[]) : null;
	if (body.include !== undefined) {
		const inc = parseInclude(body.include);
		if (!inc.ok) return fail(400, inc.error);
		include = inc.include;
	}
	const flds = parseFields(body);
	if (!flds.ok) return fail(400, flds.error);

	const key = includeKey(include);
	const json = includeJson(include);
	const parsedSrc = srcKind ?? canonicalizeSource(canonical);
	if (parsedSrc.kind === "home" && (rev || include)) return fail(400, "a closed work has nothing to pin or include");
	const identityChanged = canonical !== existing.source || rev !== existing.revision || key !== (existing.include_key ?? includeKey(null));
	const fieldChanges = diffFields(existing, flds.fields);
	if (!identityChanged && fieldChanges.length === 0) {
		return { status: 200, headers: { ETag: etag(ctx.board.revision) }, body: entryToApi(existing) };
	}

	let estimateJson = existing.estimate_json;
	let payloadBytes = existing.payload_bytes;
	if (identityChanged) {
		if (parsedSrc.kind === "hf") {
			const hit = await fetchEstimate(parsedSrc, rev || null, include);
			if (hit) {
				canonical = hit.parsed.canonical;
				estimateJson = JSON.stringify(hit.digest);
				payloadBytes = hit.digest.payload_bytes;
			} else {
				estimateJson = null;
				payloadBytes = null;
			}
		} else {
			estimateJson = null;
			payloadBytes = null;
		}
		const collision = await ctx.db
			.prepare("SELECT id FROM entries WHERE board_id = ? AND source = ? AND revision = ? AND include_key = ? AND id != ?")
			.bind(ctx.board.id, canonical, rev, key, id)
			.first<{ id: number }>();
		if (collision) return fail(409, "conflict", { entry_id: collision.id });
	}
	const after = applyFields(existing, flds.fields);
	const changes = [...fieldChanges];
	if (canonical !== existing.source) changes.push("source");
	if (rev !== existing.revision) changes.push("revision");
	if (key !== (existing.include_key ?? includeKey(null))) changes.push("include");
	const now = utcNow();
	const before = rowSnapshot(existing);
	const afterSnap = rowSnapshot({ ...after, source: canonical, revision: rev, include_json: json });
	const res = await commit(
		ctx.db,
		ctx.board,
		ctx.actor,
		[{ action: "row.updated", entry_id: id, before, after: { ...afterSnap, changes } }],
		[
			ctx.db
				.prepare(
					`UPDATE entries SET source = ?, revision = ?, include_json = ?, include_key = ?,
					 desire = ?, note = ?, status = ?, holders = ?, payload_bytes = ?, estimate_json = ?, updated = ?
					 WHERE id = ?`,
				)
				.bind(canonical, rev, json, key, after.desire, after.note, after.status, after.holders ?? "", payloadBytes, estimateJson, now, id),
		],
	);
	if (!res.ok) return fail(res.status, res.error);
	const row = await loadRow(ctx.db, ctx.board.id, id);
	await reloadBoard(ctx);
	await announce(ctx.db, ctx.board, ctx.actor, [{ action: "row.updated", entry_id: id, before, after: afterSnap }], res.revision, res.now, ctx.waitUntil);
	return { status: 200, headers: { ETag: etag(res.revision) }, body: entryToApi(row!) };
}

async function markDropped(ctx: OpCtx, id: number, drop: boolean): Promise<OpResult> {
	const denied = need(ctx, "write") ?? stale(ctx);
	if (denied) return denied;
	const existing = await loadRow(ctx.db, ctx.board.id, id);
	if (!existing) return fail(404, "not_found");
	if (drop === !!existing.dropped) return { status: 200, headers: { ETag: etag(ctx.board.revision) }, body: entryToApi(existing) };
	const now = utcNow();
	const before = rowSnapshot(existing);
	const after = { ...before, dropped: drop ? now : null };
	const event: AuditEvent = { action: drop ? "row.dropped" : "row.restored", entry_id: id, before, after };
	const res = await commit(ctx.db, ctx.board, ctx.actor, [event], [
		ctx.db.prepare("UPDATE entries SET dropped = ?, updated = ? WHERE id = ?").bind(drop ? now : null, now, id),
	]);
	if (!res.ok) return fail(res.status, res.error);
	const row = await loadRow(ctx.db, ctx.board.id, id);
	await reloadBoard(ctx);
	await announce(ctx.db, ctx.board, ctx.actor, [event], res.revision, res.now, ctx.waitUntil);
	return { status: 200, headers: { ETag: etag(res.revision) }, body: entryToApi(row!) };
}

/** A soft removal: the row leaves every list and the export, and can come back. */
export function opRowDrop(ctx: OpCtx, id: number): Promise<OpResult> {
	return markDropped(ctx, id, true);
}

export function opRowRestore(ctx: OpCtx, id: number): Promise<OpResult> {
	return markDropped(ctx, id, false);
}

/** Gone for good. The audit trail keeps the row as it was. */
export async function opRowRemove(ctx: OpCtx, id: number): Promise<OpResult> {
	const denied = need(ctx, "remove") ?? stale(ctx);
	if (denied) return denied;
	const existing = await loadRow(ctx.db, ctx.board.id, id);
	if (!existing) return fail(404, "not_found");
	const before = rowSnapshot(existing);
	const event: AuditEvent = { action: "row.removed", entry_id: id, before, after: null };
	const res = await commit(ctx.db, ctx.board, ctx.actor, [event], [ctx.db.prepare("DELETE FROM entries WHERE id = ?").bind(id)]);
	if (!res.ok) return fail(res.status, res.error);
	await reloadBoard(ctx);
	await announce(ctx.db, ctx.board, ctx.actor, [event], res.revision, res.now, ctx.waitUntil);
	return { status: 200, headers: { ETag: etag(res.revision) }, body: { ok: true, revision: res.revision } };
}

// -------------------------------------------------------- apply & batch

type IdOp = { op: "update" | "drop" | "restore" | "remove"; ref: string | null; id: number; fields: RowFields };

type StepReport = {
	ref: string | null;
	action: "added" | "updated" | "restored" | "unchanged" | "dropped" | "removed";
	id: number | null;
	source: string;
	revision: string | null;
	include: string[] | null;
	changes?: string[];
	priced?: boolean;
};

function parseIntent(raw: unknown, index: number): { ok: true; intent: Intent } | { ok: false; error: { index: number; ref: string | null; error: string } } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: { index, ref: null, error: "row must be an object" } };
	const body = raw as Record<string, unknown>;
	const ref = parseRef(body.ref);
	const idn = parseIdentity(body);
	if (!idn.ok) return { ok: false, error: { index, ref, error: idn.error } };
	const flds = parseFields(body);
	if (!flds.ok) return { ok: false, error: { index, ref, error: flds.error } };
	return { ok: true, intent: { ref, identity: idn.identity, fields: flds.fields } };
}

/**
 * Run a plan: price the new Hub rows within the budget, write everything
 * in one commit, and report each step with the id it ended up with.
 */
async function executePlan(ctx: OpCtx, rows: EntryRow[], steps: PlanStep[], idOps: IdOp[]): Promise<OpResult> {
	const now = utcNow();
	const stmts: D1PreparedStatement[] = [];
	const events: AuditEvent[] = [];
	const reports: StepReport[] = [];
	const inserted: { identity: Identity; canonical: string; ref: string | null; priced: boolean }[] = [];
	let budget = PRICE_BUDGET;
	const byIdentity = new Map(rows.map((r) => [rowIdentityKey(r), r]));

	for (const step of steps) {
		if (step.kind === "add") {
			let priced: Priced = { canonical: step.identity.canonical, estimateJson: null, payloadBytes: null, priced: false };
			if (step.identity.kind === "hf" && budget > 0) {
				budget -= 1;
				priced = await price(step.identity);
			}
			const retarget = priced.canonical !== step.identity.canonical ? byIdentity.get(identityKey(priced.canonical, step.identity.revision, step.identity.includeKey)) : undefined;
			if (retarget) {
				// The Hub knows this model-shaped id only as a dataset, and that row is already here.
				const changes = diffFields(retarget, step.fields);
				const restoring = !!retarget.dropped;
				if (changes.length || restoring) {
					stmts.push(updateFieldsStmt(ctx.db, retarget, step.fields, now, { dropped: null, priced }));
					events.push({ action: restoring ? "row.restored" : "row.updated", entry_id: retarget.id, before: rowSnapshot(retarget), after: snapshotAfter(retarget, step.fields, { dropped: null }) });
				}
				reports.push({ ref: step.ref, action: restoring ? "restored" : changes.length ? "updated" : "unchanged", id: retarget.id, source: retarget.source, revision: retarget.revision || null, include: step.identity.include, changes });
				continue;
			}
			stmts.push(insertStmt(ctx.db, ctx.board.id, step.identity, priced.canonical, step.fields, priced, now));
			inserted.push({ identity: step.identity, canonical: priced.canonical, ref: step.ref, priced: priced.priced });
		} else if (step.kind === "update" || step.kind === "restore") {
			const restoring = step.kind === "restore";
			stmts.push(updateFieldsStmt(ctx.db, step.row, step.fields, now, { dropped: null }));
			events.push({ action: restoring ? "row.restored" : "row.updated", entry_id: step.row.id, before: rowSnapshot(step.row), after: snapshotAfter(step.row, step.fields, { dropped: null }) });
			reports.push({ ref: step.ref, action: restoring ? "restored" : "updated", id: step.row.id, source: step.row.source, revision: step.row.revision || null, include: step.row.include_json ? (JSON.parse(step.row.include_json) as string[]) : null, changes: step.changes });
		} else if (step.kind === "unchanged") {
			reports.push({ ref: step.ref, action: "unchanged", id: step.row.id, source: step.row.source, revision: step.row.revision || null, include: step.row.include_json ? (JSON.parse(step.row.include_json) as string[]) : null, changes: [] });
		} else if (step.kind === "drop") {
			stmts.push(ctx.db.prepare("UPDATE entries SET dropped = ?, updated = ? WHERE id = ?").bind(now, now, step.row.id));
			const before = rowSnapshot(step.row);
			events.push({ action: "row.dropped", entry_id: step.row.id, before, after: { ...before, dropped: now } });
			reports.push({ ref: null, action: "dropped", id: step.row.id, source: step.row.source, revision: step.row.revision || null, include: null });
		}
	}
	let removed = 0;
	for (const op of idOps) {
		const row = rows.find((r) => r.id === op.id)!;
		const before = rowSnapshot(row);
		if (op.op === "update") {
			const changes = diffFields(row, op.fields);
			if (!changes.length) {
				reports.push({ ref: op.ref, action: "unchanged", id: row.id, source: row.source, revision: row.revision || null, include: null, changes: [] });
				continue;
			}
			stmts.push(updateFieldsStmt(ctx.db, row, op.fields, now));
			events.push({ action: "row.updated", entry_id: row.id, before, after: { ...snapshotAfter(row, op.fields), changes } });
			reports.push({ ref: op.ref, action: "updated", id: row.id, source: row.source, revision: row.revision || null, include: null, changes });
		} else if (op.op === "drop" || op.op === "restore") {
			const drop = op.op === "drop";
			if (drop === !!row.dropped) {
				reports.push({ ref: op.ref, action: "unchanged", id: row.id, source: row.source, revision: row.revision || null, include: null, changes: [] });
				continue;
			}
			stmts.push(ctx.db.prepare("UPDATE entries SET dropped = ?, updated = ? WHERE id = ?").bind(drop ? now : null, now, row.id));
			events.push({ action: drop ? "row.dropped" : "row.restored", entry_id: row.id, before, after: { ...before, dropped: drop ? now : null } });
			reports.push({ ref: op.ref, action: drop ? "dropped" : "restored", id: row.id, source: row.source, revision: row.revision || null, include: null });
		} else if (op.op === "remove") {
			removed += 1;
			stmts.push(ctx.db.prepare("DELETE FROM entries WHERE id = ?").bind(row.id));
			events.push({ action: "row.removed", entry_id: row.id, before, after: null });
			reports.push({ ref: op.ref, action: "removed", id: row.id, source: row.source, revision: row.revision || null, include: null });
		}
	}
	if (rows.length - removed + inserted.length > MAX_ENTRIES) return fail(400, "entry_cap", { room: Math.max(0, MAX_ENTRIES - rows.length + removed) });

	if (!stmts.length) {
		return { status: 200, headers: { ETag: etag(ctx.board.revision) }, body: { ok: true, dry_run: false, revision: ctx.board.revision, summary: summarizeReports(reports), rows: reports } };
	}
	const res = await commit(ctx.db, ctx.board, ctx.actor, events, stmts);
	if (!res.ok) return fail(res.status, res.error);
	if (inserted.length) {
		const fresh = await loadRows(ctx.db, ctx.board.id, "all");
		const auditStmts: D1PreparedStatement[] = [];
		for (const ins of inserted) {
			const row = findByIdentity(fresh, ins.canonical, ins.identity.revision, ins.identity.includeKey);
			if (!row) continue;
			const after = rowSnapshot(row);
			events.push({ action: "row.added", entry_id: row.id, before: null, after });
			auditStmts.push(
				ctx.db
					.prepare(
						`INSERT INTO audit (board_id, at, actor_json, action, entry_id, before_json, after_json, revision)
						 VALUES (?, ?, ?, 'row.added', ?, NULL, ?, ?)`,
					)
					.bind(ctx.board.id, res.now, JSON.stringify(ctx.actor), row.id, JSON.stringify(after), res.revision),
			);
			reports.push({ ref: ins.ref, action: "added", id: row.id, source: row.source, revision: row.revision || null, include: ins.identity.include, priced: ins.priced });
		}
		if (auditStmts.length) await ctx.db.batch(auditStmts);
	}
	await reloadBoard(ctx);
	await announce(ctx.db, ctx.board, ctx.actor, events, res.revision, res.now, ctx.waitUntil);
	return { status: 200, headers: { ETag: etag(res.revision) }, body: { ok: true, dry_run: false, revision: res.revision, summary: summarizeReports(reports), rows: reports } };
}

function summarizeReports(reports: StepReport[]) {
	const s = { added: 0, updated: 0, restored: 0, unchanged: 0, dropped: 0, removed: 0 };
	for (const r of reports) s[r.action] += 1;
	return s;
}

function dryRunReport(steps: PlanStep[], idOps: IdOp[], rows: EntryRow[]): StepReport[] {
	const out: StepReport[] = [];
	for (const step of steps) {
		if (step.kind === "add") out.push({ ref: step.ref, action: "added", id: null, source: step.identity.canonical, revision: step.identity.revision || null, include: step.identity.include, priced: false });
		else if (step.kind === "drop") out.push({ ref: null, action: "dropped", id: step.row.id, source: step.row.source, revision: step.row.revision || null, include: null });
		else out.push({ ref: step.ref, action: step.kind === "update" ? "updated" : step.kind === "restore" ? "restored" : "unchanged", id: step.row.id, source: step.row.source, revision: step.row.revision || null, include: step.row.include_json ? (JSON.parse(step.row.include_json) as string[]) : null, changes: step.kind === "unchanged" ? [] : step.changes });
	}
	for (const op of idOps) {
		const row = rows.find((r) => r.id === op.id)!;
		const base = { ref: op.ref, id: row.id, source: row.source, revision: row.revision || null, include: null };
		if (op.op === "update") {
			const changes = diffFields(row, op.fields);
			out.push({ ...base, action: changes.length ? "updated" : "unchanged", changes });
		} else if (op.op === "drop") out.push({ ...base, action: row.dropped ? "unchanged" : "dropped" });
		else if (op.op === "restore") out.push({ ...base, action: row.dropped ? "restored" : "unchanged" });
		else out.push({ ...base, action: "removed" });
	}
	return out;
}

/**
 * Ensure a list of rows is on the board: match by address, add what is
 * missing, update what differs, leave the identical alone. `sync` also
 * drops (never removes) the live rows the list left out. `dry_run`
 * returns the plan without writing it.
 */
export async function opApply(ctx: OpCtx, body: Record<string, unknown>): Promise<OpResult> {
	const denied = need(ctx, "write");
	if (denied) return denied;
	const dryRun = body.dry_run === true;
	if (!dryRun) {
		const s = stale(ctx);
		if (s) return s;
	}
	const mode = body.mode === undefined ? "upsert" : body.mode;
	if (mode !== "upsert" && mode !== "sync") return fail(400, "mode must be upsert or sync");
	if (!Array.isArray(body.rows)) return fail(400, "rows must be an array");
	if (body.rows.length > MAX_APPLY_ROWS) return fail(400, "too many rows", { max: MAX_APPLY_ROWS });
	const intents: Intent[] = [];
	const failures: { index: number; ref: string | null; error: string }[] = [];
	body.rows.forEach((raw, index) => {
		const p = parseIntent(raw, index);
		if (p.ok) intents.push(p.intent);
		else failures.push(p.error);
	});
	if (failures.length) return fail(400, "invalid rows", { failures });
	const rows = await loadRows(ctx.db, ctx.board.id, "all");
	const plan = planApply(rows, intents, mode);
	if (plan.errors.length) return fail(400, "invalid rows", { failures: plan.errors });
	if (dryRun) {
		const reports = dryRunReport(plan.steps, [], rows);
		return { status: 200, headers: { ETag: etag(ctx.board.revision) }, body: { ok: true, dry_run: true, revision: ctx.board.revision, summary: summarizeReports(reports), rows: reports } };
	}
	return executePlan(ctx, rows, plan.steps, []);
}

/**
 * Explicit operations — add, update, drop, restore, remove — checked as a
 * whole and written as a whole: one bad operation fails the batch and
 * nothing is written.
 */
export async function opBatch(ctx: OpCtx, body: Record<string, unknown>): Promise<OpResult> {
	const denied = need(ctx, "write");
	if (denied) return denied;
	const dryRun = body.dry_run === true;
	if (!dryRun) {
		const s = stale(ctx);
		if (s) return s;
	}
	if (!Array.isArray(body.operations)) return fail(400, "operations must be an array");
	if (body.operations.length > MAX_APPLY_ROWS) return fail(400, "too many operations", { max: MAX_APPLY_ROWS });
	const rows = await loadRows(ctx.db, ctx.board.id, "all");
	const intents: Intent[] = [];
	const idOps: IdOp[] = [];
	const failures: { index: number; ref: string | null; error: string }[] = [];
	const touched = new Set<number>();
	body.operations.forEach((raw, index) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			failures.push({ index, ref: null, error: "operation must be an object" });
			return;
		}
		const o = raw as Record<string, unknown>;
		const ref = parseRef(o.ref);
		if (o.op === "add") {
			const p = parseIntent(o, index);
			if (p.ok) intents.push(p.intent);
			else failures.push(p.error);
			return;
		}
		if (o.op !== "update" && o.op !== "drop" && o.op !== "restore" && o.op !== "remove") {
			failures.push({ index, ref, error: "op must be add, update, drop, restore, or remove" });
			return;
		}
		if (o.op === "remove" && !can(ctx.grant, "remove")) {
			failures.push({ index, ref, error: "forbidden: remove needs the remove scope" });
			return;
		}
		const id = typeof o.id === "number" && Number.isInteger(o.id) ? o.id : null;
		const row = id === null ? undefined : rows.find((r) => r.id === id);
		if (!row) {
			failures.push({ index, ref, error: "no row with id " + String(o.id).slice(0, 20) });
			return;
		}
		if (touched.has(row.id)) {
			failures.push({ index, ref, error: "row " + row.id + " appears twice" });
			return;
		}
		touched.add(row.id);
		let fields: RowFields = {};
		if (o.op === "update") {
			const f = parseFields(o);
			if (!f.ok) {
				failures.push({ index, ref, error: f.error });
				return;
			}
			fields = f.fields;
		}
		idOps.push({ op: o.op, ref, id: row.id, fields });
	});
	if (failures.length) return fail(400, "invalid operations", { failures });
	const plan = planApply(rows, intents, "upsert");
	if (plan.errors.length) return fail(400, "invalid operations", { failures: plan.errors });
	for (const step of plan.steps) {
		if (step.kind !== "add" && touched.has(step.row.id)) {
			return fail(400, "invalid operations", { failures: [{ index: -1, ref: step.ref, error: "row " + step.row.id + " is both added by address and named by id" }] });
		}
	}
	if (dryRun) {
		const reports = dryRunReport(plan.steps, idOps, rows);
		return { status: 200, headers: { ETag: etag(ctx.board.revision) }, body: { ok: true, dry_run: true, revision: ctx.board.revision, summary: summarizeReports(reports), rows: reports } };
	}
	return executePlan(ctx, rows, plan.steps, idOps);
}

// ---------------------------------------------------------------- claims

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/**
 * A claim is board-side coordination, like status and holders: "this
 * client is fetching this row". A live claim by another client blocks a
 * new one until it goes stale or reports done; force overrides. A row
 * checked off as have refuses un-marked claims (refetch or force pass).
 */
export async function opClaim(ctx: OpCtx, id: number, body: Record<string, unknown>): Promise<OpResult> {
	const denied = need(ctx, "claim");
	if (denied) return denied;
	const existing = await loadRow(ctx.db, ctx.board.id, id);
	if (!existing) return fail(404, "not_found");
	if (existing.dropped) return fail(409, "dropped");
	const client = clampStr(body.client, MAX_CLIENT, false);
	if (!client) return fail(400, "client required");
	const state = body.state === "paused" || body.state === "done" ? body.state : "archiving";
	const percentRaw = num(body.percent);
	const percent = percentRaw === null ? null : Math.min(100, percentRaw);
	const current = parseClaim(existing.claim_json);
	const now = utcNow();
	if (current && current.client !== client && current.state !== "done" && body.force !== true) {
		const updatedAt = Date.parse(current.updated || current.claimed_at);
		const live = Number.isFinite(updatedAt) && Date.now() - updatedAt < CLAIM_TTL_MS;
		if (live) return { status: 409, body: { error: "claimed", claim: current } };
	}
	if (existing.status === "have" && body.refetch !== true && body.force !== true && !(current && current.client === client)) {
		return { status: 409, body: { error: "have", claim: current } };
	}
	const claim = {
		client,
		state,
		percent,
		banked_bytes: num(body.banked_bytes),
		total_bytes: num(body.total_bytes),
		claimed_at: current && current.client === client ? current.claimed_at || now : now,
		updated: now,
	};
	const status = state === "done" ? "have" : existing.status;
	const holders = state === "done" && !existing.holders ? client : existing.holders;
	const before = { claim: current, status: existing.status, holders: existing.holders };
	const after = { claim, status, holders };
	// A progress report is a fact, not a decision: only the boundaries are audited.
	const boundary = !current || current.client !== client || current.state !== state || state === "done";
	const events: AuditEvent[] = boundary ? [{ action: "claim.reported", entry_id: id, before, after }] : [];
	const res = await commit(ctx.db, ctx.board, ctx.actor, events, [
		ctx.db.prepare("UPDATE entries SET claim_json = ?, status = ?, holders = ? WHERE id = ?").bind(JSON.stringify(claim), status, holders, id),
	]);
	if (!res.ok) return fail(res.status, res.error);
	const row = await loadRow(ctx.db, ctx.board.id, id);
	await reloadBoard(ctx);
	await announce(ctx.db, ctx.board, ctx.actor, events, res.revision, res.now, ctx.waitUntil);
	return { status: 200, headers: { ETag: etag(res.revision) }, body: entryToApi(row!) };
}

export async function opRelease(ctx: OpCtx, id: number, body: Record<string, unknown>): Promise<OpResult> {
	const denied = need(ctx, "claim");
	if (denied) return denied;
	const existing = await loadRow(ctx.db, ctx.board.id, id);
	if (!existing) return fail(404, "not_found");
	const client = clampStr(body.client, MAX_CLIENT, false);
	const current = parseClaim(existing.claim_json);
	if (current && client !== current.client && body.force !== true) return { status: 409, body: { error: "claimed", claim: current } };
	const events: AuditEvent[] = current ? [{ action: "claim.released", entry_id: id, before: { claim: current }, after: { claim: null } }] : [];
	const res = await commit(ctx.db, ctx.board, ctx.actor, events, [
		ctx.db.prepare("UPDATE entries SET claim_json = NULL WHERE id = ?").bind(id),
	]);
	if (!res.ok) return fail(res.status, res.error);
	const row = await loadRow(ctx.db, ctx.board.id, id);
	await reloadBoard(ctx);
	await announce(ctx.db, ctx.board, ctx.actor, events, res.revision, res.now, ctx.waitUntil);
	return { status: 200, headers: { ETag: etag(res.revision) }, body: entryToApi(row!) };
}

// ----------------------------------------------------------------- audit

export async function opAudit(ctx: OpCtx, q: { limit?: unknown; before?: unknown; entry?: unknown } = {}): Promise<OpResult> {
	const denied = need(ctx, "read");
	if (denied) return denied;
	const limit = Math.min(MAX_AUDIT_PAGE, Math.max(1, intOrNull(q.limit) ?? 50));
	const before = intOrNull(q.before);
	const entry = intOrNull(q.entry);
	const res = await ctx.db
		.prepare(
			`SELECT * FROM audit WHERE board_id = ? AND (? IS NULL OR id < ?) AND (? IS NULL OR entry_id = ?)
			 ORDER BY id DESC LIMIT ?`,
		)
		.bind(ctx.board.id, before, before, entry, entry, limit + 1)
		.all<AuditRow>();
	const rows = res.results ?? [];
	const page = rows.slice(0, limit);
	return {
		status: 200,
		headers: { ETag: etag(ctx.board.revision) },
		body: {
			revision: ctx.board.revision,
			events: page.map(auditToApi),
			next_before: rows.length > limit ? page[page.length - 1].id : null,
		},
	};
}

// --------------------------------------------------------------- catalog

export async function opCatalogExport(ctx: OpCtx): Promise<OpResult> {
	const denied = need(ctx, "read");
	if (denied) return denied;
	const rows = await loadRows(ctx.db, ctx.board.id, "none");
	const cat = exportCatalog(ctx.board, rows);
	return {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Content-Disposition": 'attachment; filename="' + ctx.board.catalog_id + '.json"',
			ETag: etag(ctx.board.revision),
		},
		body: JSON.stringify(cat, null, 2) + "\n",
	};
}

/**
 * The CLI round trip: darsay fetches catalog.json, refreshes it with
 * classification, and POSTs the document back. Import is authoritative
 * for catalog facts — entries, desire, note, digests — and never touches
 * board-side claims; status and holders survive on kept rows. Rows the
 * document left out are removed by the URL and dropped by a key without
 * `remove`; a dropped row the document names again is restored.
 */
export async function opCatalogImport(ctx: OpCtx, body: Record<string, unknown>): Promise<OpResult> {
	const denied = need(ctx, "write") ?? stale(ctx);
	if (denied) return denied;
	const board = ctx.board;
	if (body.kind !== "darsay.catalog") return fail(400, "not a catalog");
	const version = String(body.catalog_schema_version ?? "");
	if (version.split(".")[0] !== CATALOG_SCHEMA_VERSION.split(".")[0]) return fail(400, "unsupported catalog schema");
	if (typeof body.id === "string" && foldSlug(body.id) !== board.catalog_id) return fail(409, "catalog_id mismatch");
	const rawEntries = Array.isArray(body.entries) ? body.entries : [];
	if (rawEntries.length > MAX_ENTRIES) return fail(400, "entry_cap");
	const title = clampStr(body.title ?? board.title, MAX_TITLE);
	const curator = clampStr(body.curator ?? "", MAX_CURATOR);
	const note = clampStr(body.note ?? "", MAX_BOARD_NOTE);
	if (title === null || curator === null || note === null) return fail(400, "field too long");

	type Incoming = { canonical: string; revision: string; includeJson: string | null; includeKey: string; desire: number | null; note: string | null; digest: string | null; payloadBytes: number | null };
	const incoming: Incoming[] = [];
	const seen = new Set<string>();
	for (const raw of rawEntries) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "invalid entry");
		const entry = raw as Record<string, unknown>;
		if (typeof entry.source !== "string" || entry.source.length > MAX_SOURCE) return fail(400, "invalid source");
		const src = canonicalizeSource(entry.source);
		if (src.kind === "error") return fail(400, src.error);
		const revIn = entry.revision === undefined || entry.revision === null ? "" : entry.revision;
		if (typeof revIn !== "string" || revIn.length > MAX_REVISION) return fail(400, "invalid revision");
		const inc = parseInclude(entry.include);
		if (!inc.ok) return fail(400, inc.error);
		if (src.kind === "home" && (revIn || inc.include)) return fail(400, "a closed work has nothing to pin or include");
		const des = parseDesire(entry.desire);
		if (!des.ok) return fail(400, des.error);
		const entryNote = clampStr(entry.note ?? "", MAX_ENTRY_NOTE);
		if (entryNote === null) return fail(400, "field too long");
		const digest = sanitizeDigest(entry.estimate);
		const payloadBytes = digest && typeof digest.payload_bytes === "number" ? digest.payload_bytes : null;
		const key = includeKey(inc.include);
		const identity = identityKey(src.canonical, revIn, key);
		if (seen.has(identity)) return fail(400, "duplicate entry");
		seen.add(identity);
		incoming.push({ canonical: src.canonical, revision: revIn, includeJson: includeJson(inc.include), includeKey: key, desire: des.desire, note: entryNote || null, digest: digest ? JSON.stringify(digest) : null, payloadBytes });
	}

	const now = utcNow();
	const existing = await loadRows(ctx.db, board.id, "all");
	const byIdentity = new Map(existing.map((e) => [rowIdentityKey(e), e]));
	let added = 0;
	let updated = 0;
	let restored = 0;
	const keep = new Set<number>();
	const stmts: D1PreparedStatement[] = [
		ctx.db
			.prepare("UPDATE boards SET title = ?, curator = ?, note = ?, catalog_id = ? WHERE id = ?")
			.bind(title || board.title, curator || null, note || null, board.catalog_id, board.id),
	];
	for (const row of incoming) {
		const match = byIdentity.get(identityKey(row.canonical, row.revision, row.includeKey));
		if (match) {
			keep.add(match.id);
			if (match.dropped) restored += 1;
			else updated += 1;
			stmts.push(
				ctx.db
					.prepare("UPDATE entries SET note = ?, desire = ?, payload_bytes = ?, estimate_json = ?, updated = ?, dropped = NULL WHERE id = ?")
					.bind(row.note, row.desire, row.payloadBytes, row.digest, now, match.id),
			);
		} else {
			added += 1;
			stmts.push(
				ctx.db
					.prepare(
						`INSERT INTO entries (board_id, source, revision, include_json, include_key, desire, note, status, holders, added, updated, payload_bytes, estimate_json)
						 VALUES (?, ?, ?, ?, ?, ?, ?, 'want', '', ?, ?, ?, ?)`,
					)
					.bind(board.id, row.canonical, row.revision, row.includeJson, row.includeKey, row.desire, row.note, now, now, row.payloadBytes, row.digest),
			);
		}
	}
	const destroy = can(ctx.grant, "remove");
	let removed = 0;
	let dropped = 0;
	for (const e of existing) {
		if (keep.has(e.id) || e.dropped) continue;
		if (destroy) {
			removed += 1;
			stmts.push(ctx.db.prepare("DELETE FROM entries WHERE id = ?").bind(e.id));
		} else {
			dropped += 1;
			stmts.push(ctx.db.prepare("UPDATE entries SET dropped = ?, updated = ? WHERE id = ?").bind(now, now, e.id));
		}
	}
	const summary = { added, updated, restored, removed, dropped, entries: incoming.length };
	const event: AuditEvent = { action: "catalog.imported", entry_id: null, before: null, after: summary };
	const res = await commit(ctx.db, board, ctx.actor, [event], stmts);
	if (!res.ok) return fail(res.status, res.error);
	await reloadBoard(ctx);
	await announce(ctx.db, ctx.board, ctx.actor, [event], res.revision, res.now, ctx.waitUntil);
	return { status: 200, headers: { ETag: etag(res.revision) }, body: { ok: true, ...summary, revision: res.revision } };
}

export { addressOf, familyKey, lineageOf };
