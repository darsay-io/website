import { Hono } from "hono";
import { CATALOG_SCHEMA_VERSION, exportCatalog, entryToApi, parseClaim, sanitizeDigest, type BoardRow, type EntryRow } from "./catalog.ts";
import { fetchEstimate } from "./estimate.ts";
import { canonicalizeSource, type HfCanonical } from "./sources.ts";
import {
	CLAIM_TTL_MS,
	CREATE_CAP,
	LOOKUP_CAP,
	MAX_BODY,
	MAX_CLIENT,
	MAX_IMPORT_BODY,
	MAX_BOARD_NOTE,
	MAX_CURATOR,
	MAX_ENTRIES,
	MAX_ENTRY_NOTE,
	MAX_HOLDERS,
	MAX_REVISION,
	MAX_SOURCE,
	MAX_TITLE,
	MUTATE_CAP,
	clampStr,
	foldSlug,
	includeJson,
	includeKey,
	isBoardId,
	newBoardId,
	parseCatalogId,
	parseDesire,
	parseInclude,
	utcDay,
	utcNow,
	secretEqual,
} from "./validate.ts";

export type Env = {
	DB: D1Database;
	ASSETS?: Fetcher;
	/** Wrangler secret. Required for POST /api/boards. Never commit this value. */
	CREATE_PASSWORD?: string;
};

const app = new Hono<{ Bindings: Env }>().basePath("/api");

const API_HEADERS: Record<string, string> = {
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "frame-ancestors 'none'",
	"Cache-Control": "no-store",
};

function applyApiHeaders(c: { header: (k: string, v: string) => void }) {
	for (const [k, v] of Object.entries(API_HEADERS)) c.header(k, v);
}

app.use("*", async (c, next) => {
	await next();
	applyApiHeaders(c);
});

app.notFound((c) => {
	applyApiHeaders(c);
	return c.json({ error: "not_found" }, 404);
});

app.onError((_err, c) => {
	console.log({ msg: "unhandled", status: 500 });
	applyApiHeaders(c);
	return c.json({ error: "internal" }, 500);
});

function jsonError(c: { json: (b: unknown, s: number) => Response }, error: string, status: number) {
	return c.json({ error }, status);
}

function idPrefix(id: string): string {
	return id.slice(0, 8);
}

async function readJson(c: { req: { raw: Request } }, max = MAX_BODY): Promise<
	{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }
> {
	const ct = c.req.raw.headers.get("content-type") || "";
	if (ct.toLowerCase().includes("multipart/")) {
		return { ok: false, status: 415, error: "multipart rejected" };
	}
	if (ct && !ct.toLowerCase().includes("application/json")) {
		return { ok: false, status: 415, error: "json required" };
	}
	const buf = await c.req.raw.arrayBuffer();
	if (buf.byteLength > max) return { ok: false, status: 413, error: "body too large" };
	if (buf.byteLength === 0) return { ok: true, body: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(buf));
	} catch {
		return { ok: false, status: 415, error: "invalid json" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, status: 415, error: "json object required" };
	}
	return { ok: true, body: parsed as Record<string, unknown> };
}

async function readCap(
	db: D1Database,
	kind: "creates" | "mutates" | "lookups",
): Promise<{ n: number; today: string }> {
	const today = utcDay();
	const utc = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(`${kind}_utc`).first<{ value: string }>();
	const nRow = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(`${kind}_n`).first<{ value: string }>();
	const n = utc?.value === today ? parseInt(nRow?.value ?? "0", 10) || 0 : 0;
	return { n, today };
}

function capStmts(
	db: D1Database,
	kind: "creates" | "mutates" | "lookups",
	today: string,
	next: number,
) {
	return [
		db.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(today, `${kind}_utc`),
		db.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(String(next), `${kind}_n`),
	];
}

async function bumpLookup(db: D1Database): Promise<"ok" | "cap"> {
	const { n, today } = await readCap(db, "lookups");
	if (n >= LOOKUP_CAP) return "cap";
	await db.batch(capStmts(db, "lookups", today, n + 1));
	return "ok";
}

async function loadBoard(db: D1Database, id: string): Promise<BoardRow | null> {
	return db.prepare("SELECT * FROM boards WHERE id = ?").bind(id).first<BoardRow>();
}

async function loadEntries(db: D1Database, boardId: string): Promise<EntryRow[]> {
	const res = await db
		.prepare(
			`SELECT * FROM entries WHERE board_id = ?
       ORDER BY CASE WHEN desire IS NULL THEN 1 ELSE 0 END, desire DESC, id ASC`,
		)
		.bind(boardId)
		.all<EntryRow>();
	return res.results ?? [];
}

app.post("/boards", async (c) => {
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const expected = c.env.CREATE_PASSWORD;
	if (!expected) return jsonError(c, "create_disabled", 503);
	if (!secretEqual(parsed.body.password, expected)) {
		return jsonError(c, "unauthorized", 401);
	}
	const title = clampStr(parsed.body.title ?? "", MAX_TITLE);
	const curator = clampStr(parsed.body.curator ?? "", MAX_CURATOR);
	const note = clampStr(parsed.body.note ?? "", MAX_BOARD_NOTE);
	if (title === null || curator === null || note === null) {
		return jsonError(c, "field too long", 400);
	}
	const cat = parseCatalogId(parsed.body.catalog_id, title);
	if (!cat.ok) return jsonError(c, cat.error, 400);
	const { n, today } = await readCap(c.env.DB, "creates");
	if (n >= CREATE_CAP) return jsonError(c, "create_cap", 429);
	const id = newBoardId();
	const now = utcNow();
	try {
		await c.env.DB.batch([
			...capStmts(c.env.DB, "creates", today, n + 1),
			c.env.DB
				.prepare(
					`INSERT INTO boards (id, catalog_id, title, curator, note, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(id, cat.id, title, curator || null, note || null, now, now),
		]);
	} catch (err) {
		console.log({ msg: "create_fail", status: 503, id_prefix: idPrefix(id) });
		return jsonError(c, "quota", 503);
	}
	const origin = new URL(c.req.url).origin;
	return c.json({ id, url: `${origin}/b/${id}`, catalog_id: cat.id, created: now }, 201);
});

app.use("/boards/:id/*", (c, next) => lookupGate(c, next));
app.use("/boards/:id", (c, next) => lookupGate(c, next));

async function lookupGate(
	c: { req: { param: (k: string) => string }; env: Env; json: (b: unknown, s: number) => Response },
	next: () => Promise<void>,
) {
	const id = c.req.param("id");
	if (!isBoardId(id)) return jsonError(c, "not_found", 404);
	const cap = await bumpLookup(c.env.DB);
	if (cap === "cap") return jsonError(c, "lookup_cap", 429);
	await next();
}

app.get("/boards/:id", async (c) => {
	const id = c.req.param("id");
	const board = await loadBoard(c.env.DB, id);
	if (!board) return jsonError(c, "not_found", 404);
	const entries = await loadEntries(c.env.DB, id);
	return c.json({
		id: board.id,
		catalog_id: board.catalog_id,
		title: board.title,
		curator: board.curator,
		note: board.note,
		created: board.created,
		updated: board.updated,
		entries: entries.map(entryToApi),
	});
});

app.patch("/boards/:id", async (c) => {
	const id = c.req.param("id");
	const board = await loadBoard(c.env.DB, id);
	if (!board) return jsonError(c, "not_found", 404);
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const title = parsed.body.title === undefined ? board.title : clampStr(parsed.body.title, MAX_TITLE);
	const curator =
		parsed.body.curator === undefined ? board.curator : clampStr(parsed.body.curator, MAX_CURATOR);
	const note = parsed.body.note === undefined ? board.note : clampStr(parsed.body.note, MAX_BOARD_NOTE);
	if (parsed.body.title !== undefined && title === null) return jsonError(c, "field too long", 400);
	if (parsed.body.curator !== undefined && curator === null) return jsonError(c, "field too long", 400);
	if (parsed.body.note !== undefined && note === null) return jsonError(c, "field too long", 400);
	let catalogId = board.catalog_id;
	if (parsed.body.catalog_id !== undefined) {
		const cat = parseCatalogId(parsed.body.catalog_id, typeof title === "string" ? title : board.title);
		if (!cat.ok) return jsonError(c, cat.error, 400);
		catalogId = cat.id;
	}
	const now = utcNow();
	await c.env.DB
		.prepare(
			`UPDATE boards SET title = ?, curator = ?, note = ?, catalog_id = ?, updated = ? WHERE id = ?`,
		)
		.bind(title, curator || null, note || null, catalogId, now, id)
		.run();
	return c.json({ ok: true, updated: now, catalog_id: catalogId });
});

app.delete("/boards/:id", async (c) => {
	const id = c.req.param("id");
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	if (parsed.body.confirm !== "delete") return jsonError(c, "confirm delete", 400);
	const board = await loadBoard(c.env.DB, id);
	if (!board) return jsonError(c, "not_found", 404);
	await c.env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(id).run();
	return c.json({ ok: true });
});

async function catalogResponse(c: { env: Env; req: { param: (k: string) => string }; json: Function; header: Function; body: Function }) {
	const id = c.req.param("id");
	const board = await loadBoard(c.env.DB, id);
	if (!board) return jsonError(c as never, "not_found", 404);
	const entries = await loadEntries(c.env.DB, id);
	const cat = exportCatalog(board, entries);
	const body = JSON.stringify(cat, null, 2) + "\n";
	c.header("Content-Type", "application/json");
	c.header("Content-Disposition", `attachment; filename="${board.catalog_id}.json"`);
	return c.body(body);
}

app.get("/boards/:id/catalog.json", catalogResponse);

// The CLI round trip: darsay fetches catalog.json, refreshes it with
// classification (the part only the CLI can compute), and POSTs the
// refreshed document back. Import is authoritative for catalog facts —
// entries, desire, note, digests — and never touches the board-only
// claims; status and holders survive on rows the import keeps.
app.post("/boards/:id/catalog.json", async (c) => {
	const boardId = c.req.param("id");
	const board = await loadBoard(c.env.DB, boardId);
	if (!board) return jsonError(c, "not_found", 404);
	const parsed = await readJson(c, MAX_IMPORT_BODY);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const body = parsed.body;
	if (body.kind !== "darsay.catalog") return jsonError(c, "not a catalog", 400);
	const version = String(body.catalog_schema_version ?? "");
	// Fix forward: the board speaks one catalog major, the CLI's current one.
	if (version.split(".")[0] !== CATALOG_SCHEMA_VERSION.split(".")[0]) {
		return jsonError(c, "unsupported catalog schema", 400);
	}
	if (typeof body.id === "string" && foldSlug(body.id) !== board.catalog_id) {
		return jsonError(c, "catalog_id mismatch", 409);
	}
	const rawEntries = Array.isArray(body.entries) ? body.entries : [];
	if (rawEntries.length > MAX_ENTRIES) return jsonError(c, "entry_cap", 400);
	const title = clampStr(body.title ?? board.title, MAX_TITLE);
	const curator = clampStr(body.curator ?? "", MAX_CURATOR);
	const note = clampStr(body.note ?? "", MAX_BOARD_NOTE);
	if (title === null || curator === null || note === null) {
		return jsonError(c, "field too long", 400);
	}

	type Incoming = {
		canonical: string;
		revision: string;
		includeJson: string | null;
		includeKey: string;
		desire: number | null;
		note: string | null;
		digest: string | null;
		payloadBytes: number | null;
	};
	const incoming: Incoming[] = [];
	const seen = new Set<string>();
	for (const raw of rawEntries) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			return jsonError(c, "invalid entry", 400);
		}
		const entry = raw as Record<string, unknown>;
		if (typeof entry.source !== "string" || entry.source.length > MAX_SOURCE) {
			return jsonError(c, "invalid source", 400);
		}
		const src = canonicalizeSource(entry.source);
		if (src.kind === "error") return jsonError(c, src.error, 400);
		const revIn = entry.revision === undefined || entry.revision === null ? "" : entry.revision;
		if (typeof revIn !== "string" || revIn.length > MAX_REVISION) {
			return jsonError(c, "invalid revision", 400);
		}
		const inc = parseInclude(entry.include);
		if (!inc.ok) return jsonError(c, inc.error, 400);
		if (src.kind === "home" && (revIn || inc.include)) return jsonError(c, "a closed work has nothing to pin or include", 400);
		const des = parseDesire(entry.desire);
		if (!des.ok) return jsonError(c, des.error, 400);
		const entryNote = clampStr(entry.note ?? "", MAX_ENTRY_NOTE);
		if (entryNote === null) return jsonError(c, "field too long", 400);
		const digest = sanitizeDigest(entry.estimate);
		const payloadBytes =
			digest && typeof digest.payload_bytes === "number" ? digest.payload_bytes : null;
		const key = includeKey(inc.include);
		const identity = `${src.canonical}\u0000${revIn}\u0000${key}`;
		if (seen.has(identity)) return jsonError(c, "duplicate entry", 400);
		seen.add(identity);
		incoming.push({
			canonical: src.canonical,
			revision: revIn,
			includeJson: includeJson(inc.include),
			includeKey: key,
			desire: des.desire,
			note: entryNote || null,
			digest: digest ? JSON.stringify(digest) : null,
			payloadBytes,
		});
	}

	const { n: mutN, today } = await readCap(c.env.DB, "mutates");
	if (mutN >= MUTATE_CAP) return jsonError(c, "mutate_cap", 429);
	const now = utcNow();
	const existing = await loadEntries(c.env.DB, boardId);
	const byIdentity = new Map<string, EntryRow>();
	for (const e of existing) {
		byIdentity.set(`${e.source}\u0000${e.revision}\u0000${e.include_key}`, e);
	}

	let added = 0;
	let updated = 0;
	const keep = new Set<number>();
	const stmts = [
		...capStmts(c.env.DB, "mutates", today, mutN + 1),
		c.env.DB
			.prepare("UPDATE boards SET title = ?, curator = ?, note = ?, catalog_id = ?, updated = ? WHERE id = ?")
			.bind(title || board.title, curator || null, note || null, board.catalog_id, now, boardId),
	];
	for (const row of incoming) {
		const identity = `${row.canonical}\u0000${row.revision}\u0000${row.includeKey}`;
		const match = byIdentity.get(identity);
		if (match) {
			keep.add(match.id);
			updated += 1;
			stmts.push(
				c.env.DB
					.prepare(
						"UPDATE entries SET note = ?, desire = ?, payload_bytes = ?, estimate_json = ? WHERE id = ?",
					)
					.bind(row.note, row.desire, row.payloadBytes, row.digest ?? match.estimate_json, match.id),
			);
		} else {
			added += 1;
			stmts.push(
				c.env.DB
					.prepare(
						`INSERT INTO entries (board_id, source, revision, include_json, include_key, desire, note, status, holders, added, payload_bytes, estimate_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						boardId,
						row.canonical,
						row.revision,
						row.includeJson,
						row.includeKey,
						row.desire,
						row.note,
						"want",
						"",
						now,
						row.payloadBytes,
						row.digest,
					),
			);
		}
	}
	let removed = 0;
	for (const e of existing) {
		if (!keep.has(e.id)) {
			removed += 1;
			stmts.push(c.env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(e.id));
		}
	}
	try {
		await c.env.DB.batch(stmts);
	} catch (err) {
		if (/UNIQUE/i.test(String(err))) return jsonError(c, "conflict", 409);
		return jsonError(c, "quota", 503);
	}
	return c.json({ ok: true, added, updated, removed, entries: incoming.length });
});

app.post("/boards/:id/entries", async (c) => {
	const boardId = c.req.param("id");
	const board = await loadBoard(c.env.DB, boardId);
	if (!board) return jsonError(c, "not_found", 404);
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	if (typeof parsed.body.source !== "string" || parsed.body.source.length > MAX_SOURCE) {
		return jsonError(c, "invalid source", 400);
	}
	const src = canonicalizeSource(parsed.body.source);
	if (src.kind === "error") return jsonError(c, src.error, 400);
	const revIn = parsed.body.revision === undefined || parsed.body.revision === null ? "" : parsed.body.revision;
	if (typeof revIn !== "string" || revIn.length > MAX_REVISION) return jsonError(c, "invalid revision", 400);
	const inc = parseInclude(parsed.body.include);
	if (!inc.ok) return jsonError(c, inc.error, 400);
	// A closed work (a home page) has nothing to pin or include — and no price.
	if (src.kind === "home" && (revIn || inc.include)) return jsonError(c, "a closed work has nothing to pin or include", 400);
	const des = parseDesire(parsed.body.desire);
	if (!des.ok) return jsonError(c, des.error, 400);
	const note = clampStr(parsed.body.note ?? "", MAX_ENTRY_NOTE);
	const holders = clampStr(parsed.body.holders ?? "", MAX_HOLDERS);
	if (note === null || holders === null) return jsonError(c, "field too long", 400);
	let status = parsed.body.status === "have" ? "have" : "want";
	if (parsed.body.status !== undefined && parsed.body.status !== "have" && parsed.body.status !== "want") {
		return jsonError(c, "invalid status", 400);
	}

	let canonical = src.canonical;
	let estimateJson: string | null = null;
	let payloadBytes: number | null = null;
	if (src.kind === "hf") {
		const hit = await fetchEstimate(src as HfCanonical, revIn || null);
		if (hit) {
			canonical = hit.parsed.canonical;
			estimateJson = JSON.stringify(hit.digest);
			payloadBytes = hit.digest.payload_bytes;
		}
	}

	const key = includeKey(inc.include);
	const json = includeJson(inc.include);
	let existing = await c.env.DB
		.prepare(
			`SELECT * FROM entries WHERE board_id = ? AND source = ? AND revision = ? AND include_key = ?`,
		)
		.bind(boardId, canonical, revIn, key)
		.first<EntryRow>();
	if (!existing && src.kind === "hf" && canonical !== src.canonical) {
		existing = await c.env.DB
			.prepare(
				`SELECT * FROM entries WHERE board_id = ? AND source = ? AND revision = ? AND include_key = ?`,
			)
			.bind(boardId, src.canonical, revIn, key)
			.first<EntryRow>();
	}

	if (existing && estimateJson === null) {
		estimateJson = existing.estimate_json;
		payloadBytes = existing.payload_bytes;
	}

	const { n: mutN, today } = await readCap(c.env.DB, "mutates");
	if (mutN >= MUTATE_CAP) return jsonError(c, "mutate_cap", 429);
	const now = utcNow();

	try {
		if (existing) {
			await c.env.DB.batch([
				...capStmts(c.env.DB, "mutates", today, mutN + 1),
				c.env.DB
					.prepare(
						`UPDATE entries SET desire = ?, note = ?, status = ?, holders = ?,
             payload_bytes = ?, estimate_json = ?, source = ? WHERE id = ?`,
					)
					.bind(
						des.desire,
						note || null,
						status,
						holders,
						payloadBytes,
						estimateJson,
						canonical,
						existing.id,
					),
				c.env.DB.prepare("UPDATE boards SET updated = ? WHERE id = ?").bind(now, boardId),
			]);
			const row = await c.env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(existing.id).first<EntryRow>();
			return c.json(entryToApi(row!));
		}

		let inserted: { meta?: { changes?: number } };
		try {
			inserted = await c.env.DB
				.prepare(
					`INSERT INTO entries (board_id, source, revision, include_json, include_key, desire, note, status, holders, added, payload_bytes, estimate_json)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM entries WHERE board_id = ?) < ?`,
				)
				.bind(
					boardId,
					canonical,
					revIn,
					json,
					key,
					des.desire,
					note || null,
					status,
					holders,
					now,
					payloadBytes,
					estimateJson,
					boardId,
					MAX_ENTRIES,
				)
				.run();
		} catch (err) {
			if (/UNIQUE/i.test(String(err))) return jsonError(c, "conflict", 409);
			return jsonError(c, "quota", 503);
		}
		if (!inserted.meta?.changes) return jsonError(c, "entry_cap", 400);

		await c.env.DB.batch([
			...capStmts(c.env.DB, "mutates", today, mutN + 1),
			c.env.DB.prepare("UPDATE boards SET updated = ? WHERE id = ?").bind(now, boardId),
		]);
		const row = await c.env.DB
			.prepare(
				`SELECT * FROM entries WHERE board_id = ? AND source = ? AND revision = ? AND include_key = ?`,
			)
			.bind(boardId, canonical, revIn, key)
			.first<EntryRow>();
		return c.json(entryToApi(row!), 201);
	} catch (err) {
		if (/UNIQUE/i.test(String(err))) return jsonError(c, "conflict", 409);
		return jsonError(c, "quota", 503);
	}
});

app.patch("/boards/:id/entries/:eid", async (c) => {
	const boardId = c.req.param("id");
	const eid = Number(c.req.param("eid"));
	if (!Number.isInteger(eid)) return jsonError(c, "not_found", 404);
	const board = await loadBoard(c.env.DB, boardId);
	if (!board) return jsonError(c, "not_found", 404);
	const existing = await c.env.DB
		.prepare("SELECT * FROM entries WHERE id = ? AND board_id = ?")
		.bind(eid, boardId)
		.first<EntryRow>();
	if (!existing) return jsonError(c, "not_found", 404);
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);

	let canonical = existing.source;
	let srcKind: ReturnType<typeof canonicalizeSource> | null = null;
	if (parsed.body.source !== undefined) {
		if (typeof parsed.body.source !== "string" || parsed.body.source.length > MAX_SOURCE) {
			return jsonError(c, "invalid source", 400);
		}
		srcKind = canonicalizeSource(parsed.body.source);
		if (srcKind.kind === "error") return jsonError(c, srcKind.error, 400);
		canonical = srcKind.canonical;
	}

	let rev = existing.revision;
	if (parsed.body.revision !== undefined) {
		if (parsed.body.revision === null) rev = "";
		else if (typeof parsed.body.revision !== "string" || parsed.body.revision.length > MAX_REVISION) {
			return jsonError(c, "invalid revision", 400);
		} else rev = parsed.body.revision;
	}

	let include = existing.include_json ? (JSON.parse(existing.include_json) as string[]) : null;
	if (parsed.body.include !== undefined) {
		const inc = parseInclude(parsed.body.include);
		if (!inc.ok) return jsonError(c, inc.error, 400);
		include = inc.include;
	}

	let desire = existing.desire;
	if (parsed.body.desire !== undefined) {
		const des = parseDesire(parsed.body.desire);
		if (!des.ok) return jsonError(c, des.error, 400);
		desire = des.desire;
	}

	const note =
		parsed.body.note === undefined ? existing.note : clampStr(parsed.body.note, MAX_ENTRY_NOTE);
	const holders =
		parsed.body.holders === undefined ? existing.holders : clampStr(parsed.body.holders, MAX_HOLDERS);
	if (parsed.body.note !== undefined && note === null) return jsonError(c, "field too long", 400);
	if (parsed.body.holders !== undefined && holders === null) return jsonError(c, "field too long", 400);

	let status = existing.status;
	if (parsed.body.status !== undefined) {
		if (parsed.body.status !== "have" && parsed.body.status !== "want") {
			return jsonError(c, "invalid status", 400);
		}
		status = parsed.body.status;
	}

	const key = includeKey(include);
	const json = includeJson(include);
	let estimateJson = existing.estimate_json;
	let payloadBytes = existing.payload_bytes;
	const identityChanged =
		canonical !== existing.source || rev !== existing.revision || key !== existing.include_key;
	if ((srcKind ?? canonicalizeSource(canonical)).kind === "home" && (rev || include)) {
		return jsonError(c, "a closed work has nothing to pin or include", 400);
	}
	if (identityChanged) {
		const parsedSrc = srcKind ?? canonicalizeSource(canonical);
		if (parsedSrc.kind === "hf") {
			const hit = await fetchEstimate(parsedSrc, rev || null);
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
	}

	const collision = await c.env.DB
		.prepare(
			`SELECT id FROM entries WHERE board_id = ? AND source = ? AND revision = ? AND include_key = ? AND id != ?`,
		)
		.bind(boardId, canonical, rev, key, eid)
		.first<{ id: number }>();
	if (collision) return jsonError(c, "conflict", 409);

	const { n: mutN, today } = await readCap(c.env.DB, "mutates");
	if (mutN >= MUTATE_CAP) return jsonError(c, "mutate_cap", 429);
	const now = utcNow();
	try {
		await c.env.DB.batch([
			...capStmts(c.env.DB, "mutates", today, mutN + 1),
			c.env.DB
				.prepare(
					`UPDATE entries SET source = ?, revision = ?, include_json = ?, include_key = ?,
           desire = ?, note = ?, status = ?, holders = ?, payload_bytes = ?, estimate_json = ?
           WHERE id = ?`,
				)
				.bind(
					canonical,
					rev,
					json,
					key,
					desire,
					note || null,
					status,
					holders ?? "",
					payloadBytes,
					estimateJson,
					eid,
				),
			c.env.DB.prepare("UPDATE boards SET updated = ? WHERE id = ?").bind(now, boardId),
		]);
	} catch {
		return jsonError(c, "quota", 503);
	}
	const row = await c.env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(eid).first<EntryRow>();
	return c.json(entryToApi(row!));
});

// A claim is board-side coordination, like status and holders: "this
// client is fetching this row". The CLI claims before archiving and
// reports progress at boundaries; the board renders the gauge. A live
// claim by another client blocks a new one until it goes stale
// (CLAIM_TTL_MS without a report) or reports done; force overrides.
app.post("/boards/:id/entries/:eid/claim", async (c) => {
	const boardId = c.req.param("id");
	const eid = Number(c.req.param("eid"));
	if (!Number.isInteger(eid)) return jsonError(c, "not_found", 404);
	const board = await loadBoard(c.env.DB, boardId);
	if (!board) return jsonError(c, "not_found", 404);
	const existing = await c.env.DB
		.prepare("SELECT * FROM entries WHERE id = ? AND board_id = ?")
		.bind(eid, boardId)
		.first<EntryRow>();
	if (!existing) return jsonError(c, "not_found", 404);
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const client = clampStr(parsed.body.client, MAX_CLIENT, false);
	if (!client) return jsonError(c, "client required", 400);
	const state =
		parsed.body.state === "paused" || parsed.body.state === "done"
			? parsed.body.state
			: "archiving";
	const num = (v: unknown) =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
	const percentRaw = num(parsed.body.percent);
	const percent = percentRaw === null ? null : Math.min(100, percentRaw);

	const current = parseClaim(existing.claim_json);
	const now = utcNow();
	if (current && current.client !== client && current.state !== "done" && parsed.body.force !== true) {
		const updatedAt = Date.parse(current.updated || current.claimed_at);
		const live = Number.isFinite(updatedAt) && Date.now() - updatedAt < CLAIM_TTL_MS;
		if (live) return c.json({ error: "claimed", claim: current }, 409);
	}
	// The board's checkmark gates claims: an un-marked claim on a row already
	// checked off as have is an out-of-date --next about to re-download what
	// the group holds. A client that means it says so (refetch — that is
	// archive SOURCE --board) or forces; the holder's own boundary reports
	// keep flowing either way.
	if (
		existing.status === "have" &&
		parsed.body.refetch !== true &&
		parsed.body.force !== true &&
		!(current && current.client === client)
	) {
		return c.json({ error: "have", claim: current }, 409);
	}
	const claim = {
		client,
		state,
		percent,
		banked_bytes: num(parsed.body.banked_bytes),
		total_bytes: num(parsed.body.total_bytes),
		claimed_at: current && current.client === client ? current.claimed_at || now : now,
		updated: now,
	};
	// Reporting done is the one place the client writes the human columns:
	// the row flips to have, and an empty holders field learns the client.
	const status = state === "done" ? "have" : existing.status;
	const holders = state === "done" && !existing.holders ? client : existing.holders;

	const { n: mutN, today } = await readCap(c.env.DB, "mutates");
	if (mutN >= MUTATE_CAP) return jsonError(c, "mutate_cap", 429);
	await c.env.DB.batch([
		...capStmts(c.env.DB, "mutates", today, mutN + 1),
		c.env.DB
			.prepare("UPDATE entries SET claim_json = ?, status = ?, holders = ? WHERE id = ?")
			.bind(JSON.stringify(claim), status, holders, eid),
		c.env.DB.prepare("UPDATE boards SET updated = ? WHERE id = ?").bind(now, boardId),
	]);
	const row = await c.env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(eid).first<EntryRow>();
	return c.json(entryToApi(row!));
});

app.delete("/boards/:id/entries/:eid/claim", async (c) => {
	const boardId = c.req.param("id");
	const eid = Number(c.req.param("eid"));
	if (!Number.isInteger(eid)) return jsonError(c, "not_found", 404);
	const board = await loadBoard(c.env.DB, boardId);
	if (!board) return jsonError(c, "not_found", 404);
	const existing = await c.env.DB
		.prepare("SELECT * FROM entries WHERE id = ? AND board_id = ?")
		.bind(eid, boardId)
		.first<EntryRow>();
	if (!existing) return jsonError(c, "not_found", 404);
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const client = clampStr(parsed.body.client, MAX_CLIENT, false);
	const current = parseClaim(existing.claim_json);
	if (current && client !== current.client && parsed.body.force !== true) {
		return c.json({ error: "claimed", claim: current }, 409);
	}
	const { n: mutN, today } = await readCap(c.env.DB, "mutates");
	if (mutN >= MUTATE_CAP) return jsonError(c, "mutate_cap", 429);
	const now = utcNow();
	await c.env.DB.batch([
		...capStmts(c.env.DB, "mutates", today, mutN + 1),
		c.env.DB
			.prepare("UPDATE entries SET claim_json = ?, status = ?, holders = ? WHERE id = ?")
			.bind(null, existing.status, existing.holders, eid),
		c.env.DB.prepare("UPDATE boards SET updated = ? WHERE id = ?").bind(now, boardId),
	]);
	const row = await c.env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(eid).first<EntryRow>();
	return c.json(entryToApi(row!));
});

app.delete("/boards/:id/entries/:eid", async (c) => {
	const boardId = c.req.param("id");
	const eid = Number(c.req.param("eid"));
	if (!Number.isInteger(eid)) return jsonError(c, "not_found", 404);
	const existing = await c.env.DB
		.prepare("SELECT id FROM entries WHERE id = ? AND board_id = ?")
		.bind(eid, boardId)
		.first();
	if (!existing) return jsonError(c, "not_found", 404);
	const { n: mutN, today } = await readCap(c.env.DB, "mutates");
	if (mutN >= MUTATE_CAP) return jsonError(c, "mutate_cap", 429);
	const now = utcNow();
	await c.env.DB.batch([
		...capStmts(c.env.DB, "mutates", today, mutN + 1),
		c.env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(eid),
		c.env.DB.prepare("UPDATE boards SET updated = ? WHERE id = ?").bind(now, boardId),
	]);
	return c.json({ ok: true });
});

function isBoardPage(pathname: string): boolean {
	return pathname === "/b" || pathname === "/b/" || pathname.startsWith("/b/");
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (isBoardPage(url.pathname) && env.ASSETS) {
			return env.ASSETS.fetch(new Request(new URL("/b/", url.origin), request));
		}
		return app.fetch(request, env, ctx);
	},
};

export { app };
