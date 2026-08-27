import { Hono } from "hono";
import { exportCatalog, entryToApi, type BoardRow, type EntryRow } from "./catalog.ts";
import { fetchEstimate } from "./estimate.ts";
import { canonicalizeSource, type HfCanonical } from "./sources.ts";
import {
	CREATE_CAP,
	LOOKUP_CAP,
	MAX_BODY,
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
	includeJson,
	includeKey,
	isBoardId,
	newBoardId,
	parseCatalogId,
	parseDesire,
	parseInclude,
	utcDay,
	utcNow,
} from "./validate.ts";

export type Env = {
	DB: D1Database;
	ASSETS?: Fetcher;
};

const app = new Hono<{ Bindings: Env }>().basePath("/api");

const API_HEADERS: Record<string, string> = {
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "frame-ancestors 'none'",
	"Cache-Control": "no-store",
};

app.use("*", async (c, next) => {
	await next();
	for (const [k, v] of Object.entries(API_HEADERS)) c.header(k, v);
});

function jsonError(c: { json: (b: unknown, s: number) => Response }, error: string, status: number) {
	return c.json({ error }, status);
}

function idPrefix(id: string): string {
	return id.slice(0, 8);
}

async function readJson(c: { req: { raw: Request } }): Promise<
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
	if (buf.byteLength > MAX_BODY) return { ok: false, status: 413, error: "body too large" };
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

app.use("/boards/:id/*", async (c, next) => {
	return lookupGate(c, next);
});
app.use("/boards/:id", async (c, next) => {
	if (c.req.method === "POST" && !c.req.path.includes("/boards/")) {
		return next();
	}
	return lookupGate(c, next);
});

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
	if (title === null || curator === null || note === null) return jsonError(c, "field too long", 400);
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
app.post("/boards/:id/catalog.json", catalogResponse);

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
	const canonical = src.canonical;
	const revIn = parsed.body.revision === undefined || parsed.body.revision === null ? "" : parsed.body.revision;
	if (typeof revIn !== "string" || revIn.length > MAX_REVISION) return jsonError(c, "invalid revision", 400);
	const inc = parseInclude(parsed.body.include);
	if (!inc.ok) return jsonError(c, inc.error, 400);
	const des = parseDesire(parsed.body.desire);
	if (!des.ok) return jsonError(c, des.error, 400);
	const note = clampStr(parsed.body.note ?? "", MAX_ENTRY_NOTE);
	const holders = clampStr(parsed.body.holders ?? "", MAX_HOLDERS);
	if (note === null || holders === null) return jsonError(c, "field too long", 400);
	let status = parsed.body.status === "have" ? "have" : "want";
	if (parsed.body.status !== undefined && parsed.body.status !== "have" && parsed.body.status !== "want") {
		return jsonError(c, "invalid status", 400);
	}

	const key = includeKey(inc.include);
	const json = includeJson(inc.include);
	const existing = await c.env.DB
		.prepare(
			`SELECT * FROM entries WHERE board_id = ? AND source = ? AND revision = ? AND include_key = ?`,
		)
		.bind(boardId, canonical, revIn, key)
		.first<EntryRow>();

	let estimateJson: string | null = existing?.estimate_json ?? null;
	let payloadBytes: number | null = existing?.payload_bytes ?? null;
	if (src.kind === "hf") {
		const est = await fetchEstimate(src as HfCanonical, revIn || null);
		if (est) {
			estimateJson = JSON.stringify(est);
			payloadBytes = est.payload_bytes;
		}
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
             payload_bytes = ?, estimate_json = ? WHERE id = ?`,
					)
					.bind(des.desire, note || null, status, holders, payloadBytes, estimateJson, existing.id),
				c.env.DB.prepare("UPDATE boards SET updated = ? WHERE id = ?").bind(now, boardId),
			]);
			const row = await c.env.DB.prepare("SELECT * FROM entries WHERE id = ?").bind(existing.id).first<EntryRow>();
			return c.json(entryToApi(row!));
		}

		const countRow = await c.env.DB
			.prepare("SELECT COUNT(*) AS n FROM entries WHERE board_id = ?")
			.bind(boardId)
			.first<{ n: number }>();
		if ((countRow?.n ?? 0) >= MAX_ENTRIES) return jsonError(c, "entry_cap", 400);

		const ins = await c.env.DB.batch([
			...capStmts(c.env.DB, "mutates", today, mutN + 1),
			c.env.DB
				.prepare(
					`INSERT INTO entries (board_id, source, revision, include_json, include_key, desire, note, status, holders, added, payload_bytes, estimate_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				),
			c.env.DB.prepare("UPDATE boards SET updated = ? WHERE id = ?").bind(now, boardId),
		]);
		void ins;
		const row = await c.env.DB
			.prepare(
				`SELECT * FROM entries WHERE board_id = ? AND source = ? AND revision = ? AND include_key = ?`,
			)
			.bind(boardId, canonical, revIn, key)
			.first<EntryRow>();
		return c.json(entryToApi(row!), 201);
	} catch {
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
	if (note === null || holders === null) return jsonError(c, "field too long", 400);

	let status = existing.status;
	if (parsed.body.status !== undefined) {
		if (parsed.body.status !== "have" && parsed.body.status !== "want") {
			return jsonError(c, "invalid status", 400);
		}
		status = parsed.body.status;
	}

	const key = includeKey(include);
	const json = includeJson(include);
	const collision = await c.env.DB
		.prepare(
			`SELECT id FROM entries WHERE board_id = ? AND source = ? AND revision = ? AND include_key = ? AND id != ?`,
		)
		.bind(boardId, canonical, rev, key, eid)
		.first<{ id: number }>();
	if (collision) return jsonError(c, "conflict", 409);

	let estimateJson = existing.estimate_json;
	let payloadBytes = existing.payload_bytes;
	const identityChanged =
		canonical !== existing.source || rev !== existing.revision || key !== existing.include_key;
	if (identityChanged) {
		const parsedSrc = srcKind ?? canonicalizeSource(canonical);
		if (parsedSrc.kind === "hf") {
			const est = await fetchEstimate(parsedSrc, rev || null);
			estimateJson = est ? JSON.stringify(est) : null;
			payloadBytes = est?.payload_bytes ?? null;
		} else {
			estimateJson = null;
			payloadBytes = null;
		}
	}

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

export default app;
