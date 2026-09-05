/**
 * The darsay.io worker: static assets for the site, the board shell for
 * `/b/<id>`, and the JSON API.
 *
 * Two address forms reach the same board sub-app: `/api/boards/:id/…`,
 * where the URL is the capability, and `/api/board/…`, where a bearer
 * key names the board and never learns its id. Every write goes through
 * `ops.ts` → `ledger.commit`, so the page, the CLI, a key, and the MCP
 * server all bump the same revision and land in the same audit trail.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
	MAX_KEYS,
	MAX_KEY_LABEL,
	SCOPES,
	SCOPE_HELP,
	hashSecret,
	keyToApi,
	newKeyId,
	newKeySecret,
	parseScopes,
	resolveGrant,
	type Grant,
	type KeyRow,
} from "./access.ts";
import type { BoardRow } from "./catalog.ts";
import { cardToApi, guideIndex, resolveCard } from "./guide.ts";
import { fingerprint, idempotencyKey, lookupIdempotent, storeIdempotent } from "./idempotency.ts";
import { actorOf, capStmts, clientFrom, commit, readCap, type Actor } from "./ledger.ts";
import { CARD_MAX_AGE, CARD_PATHS, serverCard } from "./card.ts";
import { serve, type McpRequest } from "./mcp.ts";
import { openapiDocument } from "./openapi.ts";
import {
	opApply,
	opAudit,
	opBatch,
	opBoard,
	opBoardPatch,
	opCatalogExport,
	opCatalogImport,
	opClaim,
	opRelease,
	opRow,
	opRowAdd,
	opPreview,
	opRowDrop,
	opRowPatch,
	opRowRemove,
	opRowRestore,
	opRows,
	type OpCtx,
	type OpResult,
} from "./ops.ts";
import {
	CREATE_CAP,
	LOOKUP_CAP,
	MAX_BODY,
	MAX_BOARD_NOTE,
	MAX_CURATOR,
	MAX_IMPORT_BODY,
	MAX_TITLE,
	clampStr,
	isBoardId,
	newBoardId,
	parseCatalogId,
	utcNow,
	secretEqual,
} from "./validate.ts";
import {
	MAX_WEBHOOKS,
	MAX_WEBHOOK_SECRET,
	newSecret,
	newWebhookId,
	parseEvents,
	validateWebhookUrl,
	webhookToApi,
	type WebhookRow,
} from "./webhooks.ts";

export type Env = {
	DB: D1Database;
	ASSETS?: Fetcher;
	/** Wrangler secret. Required for POST /api/boards. Never commit this value. */
	CREATE_PASSWORD?: string;
	/** Wrangler secret, optional: a GitHub token, so pricing a repository row is not bound by the unauthenticated API allowance. */
	GITHUB_TOKEN?: string;
};

type Vars = { grant: Grant; board: BoardRow; actor: Actor };
type App = { Bindings: Env; Variables: Vars };
type Ctx = Context<App>;

const app = new Hono<App>().basePath("/api");

const API_HEADERS: Record<string, string> = {
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "frame-ancestors 'none'",
	"Cache-Control": "no-store",
	// A JSON API for programs anywhere: no cookies, so an open origin gives
	// nothing away — the bearer or the URL is the whole credential.
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, If-None-Match, Idempotency-Key, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
	"Access-Control-Expose-Headers": "ETag, Idempotent-Replayed, Content-Disposition",
	"Access-Control-Max-Age": "86400",
};

/** The API defaults, applied after the handler; a header the handler set itself (a cacheable document's Cache-Control) stands. */
function applyApiHeaders(c: { header: (k: string, v: string) => void }, res?: Response) {
	for (const [k, v] of Object.entries(API_HEADERS)) if (!res?.headers.has(k)) c.header(k, v);
}

app.use("*", async (c, next) => {
	await next();
	applyApiHeaders(c, c.res);
});

app.options("*", (c) => c.body(null, 204));

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

async function readJson(
	c: Ctx,
	max = MAX_BODY,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }> {
	const ct = c.req.raw.headers.get("content-type") || "";
	if (ct.toLowerCase().includes("multipart/")) return { ok: false, status: 415, error: "multipart rejected" };
	if (ct && !ct.toLowerCase().includes("application/json")) return { ok: false, status: 415, error: "json required" };
	const text = await c.req.text();
	if (text.length > max) return { ok: false, status: 413, error: "body too large" };
	if (text.length === 0) return { ok: true, body: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, status: 415, error: "invalid json" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, status: 415, error: "json object required" };
	}
	return { ok: true, body: parsed as Record<string, unknown> };
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

/** `If-Match: "12"` (or W/"12", or 12) → 12; absent or `*` → null; anything else can never match. */
export function parseIfMatch(header: string | null | undefined): number | null {
	if (!header || header.trim() === "*") return null;
	const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(header);
	return m ? parseInt(m[1], 10) : -1;
}

function origin(c: Ctx): string {
	return new URL(c.req.url).origin;
}

function waitUntilOf(c: Ctx): (p: Promise<unknown>) => void {
	return (p) => {
		try {
			c.executionCtx.waitUntil(p);
		} catch {
			void p.catch(() => undefined);
		}
	};
}

function opCtx(c: Ctx): OpCtx {
	return {
		db: c.env.DB,
		board: c.get("board"),
		grant: c.get("grant"),
		actor: c.get("actor"),
		expectRevision: parseIfMatch(c.req.header("if-match")),
		origin: origin(c),
		githubToken: c.env.GITHUB_TOKEN,
		waitUntil: waitUntilOf(c),
	};
}

function send(c: Ctx, res: OpResult): Response {
	const headers = res.headers ?? {};
	if (c.req.method === "GET" && res.status === 200 && headers.ETag && c.req.header("if-none-match") === headers.ETag) {
		c.header("ETag", headers.ETag);
		return c.body(null, 304);
	}
	for (const [k, v] of Object.entries(headers)) c.header(k, v);
	if (typeof res.body === "string") return c.body(res.body, res.status as 200);
	return c.json(res.body, res.status as 200);
}

// ------------------------------------------------------------ create

app.post("/boards", async (c) => {
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const expected = c.env.CREATE_PASSWORD;
	if (!expected) return jsonError(c, "create_disabled", 503);
	if (!secretEqual(parsed.body.password, expected)) return jsonError(c, "unauthorized", 401);
	const title = clampStr(parsed.body.title ?? "", MAX_TITLE);
	const curator = clampStr(parsed.body.curator ?? "", MAX_CURATOR);
	const note = clampStr(parsed.body.note ?? "", MAX_BOARD_NOTE);
	if (title === null || curator === null || note === null) return jsonError(c, "field too long", 400);
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
				.prepare("INSERT INTO boards (id, catalog_id, title, curator, note, created, updated, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
				.bind(id, cat.id, title, curator || null, note || null, now, now),
		]);
	} catch {
		console.log({ msg: "create_fail", status: 503, id_prefix: idPrefix(id) });
		return jsonError(c, "quota", 503);
	}
	const o = origin(c);
	return c.json({ id, url: o + "/b/" + id, json: o + "/b/" + id + ".json", catalog_id: cat.id, created: now, revision: 0 }, 201);
});

// ------------------------------------------------------------- board

const board = new Hono<App>();

/** Validate the address, spend a lookup, resolve the grant, load the board. */
const boardGate: MiddlewareHandler<App> = async (c, next) => {
	const param = c.req.param("id");
	if (param !== undefined && !isBoardId(param)) return jsonError(c, "not_found", 404);
	const cap = await bumpLookup(c.env.DB);
	if (cap === "cap") return jsonError(c, "lookup_cap", 429);
	const g = await resolveGrant(c.env.DB, { paramBoardId: param ?? null, authorization: c.req.header("authorization") ?? null });
	if (!g.ok) {
		if (g.status === 401) c.header("WWW-Authenticate", 'Bearer realm="darsay.io", error="invalid_token"');
		return jsonError(c, g.error, g.status);
	}
	const row = await loadBoard(c.env.DB, g.grant.boardId);
	if (!row) return jsonError(c, "not_found", 404);
	c.set("grant", g.grant);
	c.set("board", row);
	c.set("actor", actorOf(g.grant, clientFrom(c.req.header("user-agent") ?? null)));
	await next();
};

/** A repeated write under the same Idempotency-Key answers the same way twice. */
const idempotent: MiddlewareHandler<App> = async (c, next) => {
	const method = c.req.method;
	if (method !== "POST" && method !== "PATCH" && method !== "PUT" && method !== "DELETE") return next();
	const key = idempotencyKey(c.req.header("idempotency-key") ?? null);
	if (key === null) return next();
	if (key === "bad") return jsonError(c, "bad_idempotency_key", 400);
	const boardId = c.get("grant").boardId;
	const fp = await fingerprint(method, c.req.path, await c.req.text());
	const hit = await lookupIdempotent(c.env.DB, boardId, key);
	if (hit) {
		if (hit.fingerprint !== fp) return c.json({ error: "idempotency_mismatch" }, 422);
		c.header("Idempotent-Replayed", "true");
		c.header("Content-Type", "application/json");
		return c.body(hit.body, hit.status as 200);
	}
	await next();
	const res = c.res;
	if (res.status < 500 && res.status !== 304) {
		const body = await res.clone().text();
		await storeIdempotent(c.env.DB, boardId, key, fp, res.status, body, utcNow());
	}
};

board.use("*", boardGate);
board.use("*", idempotent);

function urlOnly(c: Ctx): Response | null {
	return c.get("grant").via === "url" ? null : c.json({ error: "url_required" }, 403);
}

function eid(c: Ctx): number {
	const n = Number(c.req.param("eid"));
	return Number.isInteger(n) ? n : -1;
}

board.get("/", (c) => opBoard(opCtx(c), { dropped: c.req.query("dropped") }).then((r) => send(c, r)));

board.patch("/", async (c) => {
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	return send(c, await opBoardPatch(opCtx(c), parsed.body));
});

board.delete("/", async (c) => {
	const denied = urlOnly(c);
	if (denied) return denied;
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	if (parsed.body.confirm !== "delete") return jsonError(c, "confirm delete", 400);
	await c.env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(c.get("board").id).run();
	return c.json({ ok: true });
});

board.get("/catalog.json", (c) => opCatalogExport(opCtx(c)).then((r) => send(c, r)));

board.post("/catalog.json", async (c) => {
	const parsed = await readJson(c, MAX_IMPORT_BODY);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	return send(c, await opCatalogImport(opCtx(c), parsed.body));
});

board.get("/entries", (c) => opRows(opCtx(c), c.req.query()).then((r) => send(c, r)));
board.get("/preview", (c) => opPreview(opCtx(c), c.req.query()).then((r) => send(c, r)));

board.post("/entries", async (c) => {
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	return send(c, await opRowAdd(opCtx(c), parsed.body));
});

board.post("/apply", async (c) => {
	const parsed = await readJson(c, MAX_IMPORT_BODY);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const body = c.req.query("dry_run") === "true" || c.req.query("dry_run") === "1" ? { ...parsed.body, dry_run: true } : parsed.body;
	return send(c, await opApply(opCtx(c), body));
});

board.post("/entries/batch", async (c) => {
	const parsed = await readJson(c, MAX_IMPORT_BODY);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const body = c.req.query("dry_run") === "true" || c.req.query("dry_run") === "1" ? { ...parsed.body, dry_run: true } : parsed.body;
	return send(c, await opBatch(opCtx(c), body));
});

board.get("/entries/:eid", (c) => opRow(opCtx(c), eid(c)).then((r) => send(c, r)));

board.patch("/entries/:eid", async (c) => {
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	return send(c, await opRowPatch(opCtx(c), eid(c), parsed.body));
});

board.delete("/entries/:eid", (c) => opRowRemove(opCtx(c), eid(c)).then((r) => send(c, r)));
board.post("/entries/:eid/drop", (c) => opRowDrop(opCtx(c), eid(c)).then((r) => send(c, r)));
board.post("/entries/:eid/restore", (c) => opRowRestore(opCtx(c), eid(c)).then((r) => send(c, r)));

board.post("/entries/:eid/claim", async (c) => {
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	return send(c, await opClaim(opCtx(c), eid(c), parsed.body));
});

board.delete("/entries/:eid/claim", async (c) => {
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	return send(c, await opRelease(opCtx(c), eid(c), parsed.body));
});

board.get("/audit", (c) => opAudit(opCtx(c), c.req.query()).then((r) => send(c, r)));

// Keys and webhooks are the URL's to give: a key cannot mint keys.

board.get("/keys", async (c) => {
	const denied = urlOnly(c);
	if (denied) return denied;
	const res = await c.env.DB.prepare("SELECT * FROM keys WHERE board_id = ? ORDER BY created ASC").bind(c.get("board").id).all<KeyRow>();
	return c.json({ keys: (res.results ?? []).map(keyToApi), scopes: SCOPES.map((s) => ({ scope: s, help: SCOPE_HELP[s] })), max: MAX_KEYS });
});

board.post("/keys", async (c) => {
	const denied = urlOnly(c);
	if (denied) return denied;
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const label = clampStr(parsed.body.label, MAX_KEY_LABEL, false)?.trim();
	if (!label) return jsonError(c, "label required", 400);
	const scopes = parseScopes(parsed.body.scopes);
	if (!scopes.ok) return jsonError(c, scopes.error, 400);
	const b = c.get("board");
	const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM keys WHERE board_id = ?").bind(b.id).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_KEYS) return jsonError(c, "key_cap", 400);
	const secret = newKeySecret();
	const id = newKeyId();
	const now = utcNow();
	const res = await commit(
		c.env.DB,
		b,
		c.get("actor"),
		[{ action: "key.created", entry_id: null, before: null, after: { id, label, scopes: scopes.scopes } }],
		[
			c.env.DB
				.prepare("INSERT INTO keys (id, board_id, hash, label, scopes, created) VALUES (?, ?, ?, ?, ?, ?)")
				.bind(id, b.id, await hashSecret(secret), label, JSON.stringify(scopes.scopes), now),
		],
	);
	if (!res.ok) return jsonError(c, res.error, res.status);
	const o = origin(c);
	return c.json(
		{
			id,
			label,
			scopes: scopes.scopes,
			created: now,
			key: secret,
			shown_once: true,
			api: o + "/api/board",
			mcp: o + "/mcp",
			revision: res.revision,
		},
		201,
	);
});

board.delete("/keys/:kid", async (c) => {
	const denied = urlOnly(c);
	if (denied) return denied;
	const b = c.get("board");
	const kid = c.req.param("kid");
	const key = await c.env.DB.prepare("SELECT * FROM keys WHERE id = ? AND board_id = ?").bind(kid, b.id).first<KeyRow>();
	if (!key) return jsonError(c, "not_found", 404);
	const res = await commit(
		c.env.DB,
		b,
		c.get("actor"),
		[{ action: "key.revoked", entry_id: null, before: keyToApi(key), after: null }],
		[c.env.DB.prepare("DELETE FROM keys WHERE id = ?").bind(key.id)],
	);
	if (!res.ok) return jsonError(c, res.error, res.status);
	return c.json({ ok: true, revision: res.revision });
});

board.get("/webhooks", async (c) => {
	const denied = urlOnly(c);
	if (denied) return denied;
	const res = await c.env.DB.prepare("SELECT * FROM webhooks WHERE board_id = ? ORDER BY created ASC").bind(c.get("board").id).all<WebhookRow>();
	return c.json({ webhooks: (res.results ?? []).map(webhookToApi), max: MAX_WEBHOOKS });
});

board.post("/webhooks", async (c) => {
	const denied = urlOnly(c);
	if (denied) return denied;
	const parsed = await readJson(c);
	if (!parsed.ok) return jsonError(c, parsed.error, parsed.status);
	const url = validateWebhookUrl(parsed.body.url);
	if (!url.ok) return jsonError(c, url.error, 400);
	const events = parseEvents(parsed.body.events);
	if (!events.ok) return jsonError(c, events.error, 400);
	const given = clampStr(parsed.body.secret ?? "", MAX_WEBHOOK_SECRET);
	if (given === null) return jsonError(c, "field too long", 400);
	const b = c.get("board");
	const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE board_id = ?").bind(b.id).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_WEBHOOKS) return jsonError(c, "webhook_cap", 400);
	const id = newWebhookId();
	const secret = given || newSecret();
	const now = utcNow();
	const res = await commit(
		c.env.DB,
		b,
		c.get("actor"),
		[{ action: "webhook.created", entry_id: null, before: null, after: { id, url: url.url, events: events.events } }],
		[
			c.env.DB
				.prepare("INSERT INTO webhooks (id, board_id, url, events, secret, created) VALUES (?, ?, ?, ?, ?, ?)")
				.bind(id, b.id, url.url, JSON.stringify(events.events), secret, now),
		],
	);
	if (!res.ok) return jsonError(c, res.error, res.status);
	return c.json({ id, url: url.url, events: events.events, created: now, secret, shown_once: true, revision: res.revision }, 201);
});

board.delete("/webhooks/:wid", async (c) => {
	const denied = urlOnly(c);
	if (denied) return denied;
	const b = c.get("board");
	const hook = await c.env.DB.prepare("SELECT * FROM webhooks WHERE id = ? AND board_id = ?").bind(c.req.param("wid"), b.id).first<WebhookRow>();
	if (!hook) return jsonError(c, "not_found", 404);
	const res = await commit(
		c.env.DB,
		b,
		c.get("actor"),
		[{ action: "webhook.removed", entry_id: null, before: webhookToApi(hook), after: null }],
		[c.env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(hook.id)],
	);
	if (!res.ok) return jsonError(c, res.error, res.status);
	return c.json({ ok: true, revision: res.revision });
});

app.route("/boards/:id", board);
app.route("/board", board);

// ------------------------------------------------- guide, spec, and MCP

app.get("/guide", (c) => c.json(guideIndex(origin(c))));

app.get("/guide/:chip", (c) => {
	const card = resolveCard(c.req.param("chip"));
	if (!card) return c.json({ error: "not_found", chips: guideIndex(origin(c)).chips }, 404);
	return c.json(cardToApi(card, origin(c)));
});

app.get("/openapi.json", (c) => {
	c.header("Cache-Control", "public, max-age=600");
	return c.json(openapiDocument(origin(c)));
});

// The server card: where the MCP server is and what opens it. Reached at
// /.well-known/mcp-server-card and /mcp/server-card through the fetch
// handler below; public, cacheable, and the same for every caller.
app.get("/mcp/server-card", (c) => {
	c.header("Cache-Control", "public, max-age=" + CARD_MAX_AGE);
	return c.json(serverCard(origin(c)));
});

async function mcp(c: Ctx): Promise<Response> {
	const g = await resolveGrant(c.env.DB, { paramBoardId: null, authorization: c.req.header("authorization") ?? null });
	if (!g.ok) {
		if (g.status === 401) c.header("WWW-Authenticate", 'Bearer realm="darsay.io", error="invalid_token"');
		return c.json({ error: g.error, hint: "Authorization: Bearer <a board key, or the board id>" }, g.status);
	}
	const cap = await bumpLookup(c.env.DB);
	if (cap === "cap") return jsonError(c, "lookup_cap", 429);
	const row = await loadBoard(c.env.DB, g.grant.boardId);
	if (!row) return jsonError(c, "not_found", 404);
	const parsed = await readJson(c, MAX_IMPORT_BODY);
	if (!parsed.ok) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: parsed.error } }, parsed.status as 400);
	const grant = g.grant;
	const actor = actorOf(grant, "mcp");
	// No Origin check: this is a public server on the open internet with a bearer
	// for a credential and no cookies, so the DNS-rebinding case the transport
	// guards against (a local server reached from a page) does not arise, and
	// the API already answers any origin for the same reason.
	const answer = await serve(parsed.body as McpRequest, c.req.raw.headers, origin(c), async () => ({
		db: c.env.DB,
		board: (await loadBoard(c.env.DB, grant.boardId)) ?? row,
		grant,
		actor,
		expectRevision: null,
		origin: origin(c),
		githubToken: c.env.GITHUB_TOKEN,
		waitUntil: waitUntilOf(c),
	}));
	if (answer.body === null) return c.body(null, 202);
	return c.json(answer.body, answer.status as 200);
}

app.post("/mcp", (c) => mcp(c));
app.get("/mcp", (c) => {
	c.header("Allow", "POST");
	return c.json({ error: "method_not_allowed", hint: "POST JSON-RPC here; this server keeps no session and opens no stream. The card is at /mcp/server-card." }, 405);
});
app.delete("/mcp", (c) => {
	c.header("Allow", "POST");
	return c.json({ error: "method_not_allowed" }, 405);
});

// ------------------------------------------------------------- fetch

function isBoardPage(pathname: string): boolean {
	return pathname === "/b" || pathname === "/b/" || pathname.startsWith("/b/");
}

const BOARD_JSON = /^\/b\/([0-9a-f]{32})(\.json)?\/?$/;

/** A program asking for the board page wants the board, not the shell. */
function wantsJson(request: Request): boolean {
	const accept = (request.headers.get("accept") || "").toLowerCase();
	return accept.includes("application/json") && !accept.includes("text/html");
}

/** The shell's placeholder for a link to this board's own JSON (src/pages/b/index.astro). */
const BOARD_JSON_MARK = /<span data-board-json[^>]*><\/span>/;

/**
 * The board shell, told which board it is. The page is one static file for
 * every board — the id lives in the URL and the script reads it there — so
 * a program that fetched the HTML would otherwise find nothing to follow.
 * `rel="alternate"` is the registered word for "the same thing, as JSON";
 * the header says it too, for a HEAD; and the body says it as an ordinary
 * anchor, for a reader that sees neither `<head>` nor headers. No lookup:
 * the id is what the requester already holds, and nothing about the board
 * is read for this.
 */
async function withAlternate(shell: Response, href: string): Promise<Response> {
	if (shell.status !== 200 || !(shell.headers.get("content-type") || "").includes("text/html")) return shell;
	const headers = new Headers(shell.headers);
	headers.append("Link", "<" + href + '>; rel="alternate"; type="application/json"');
	headers.delete("Content-Length");
	const html = await shell.text();
	const at = html.indexOf("<head>");
	const tag = '<link rel="alternate" type="application/json" href="' + href + '">';
	const anchor = '<a href="' + href + '" rel="alternate" type="application/json">this board as JSON</a> · ';
	const body = (at === -1 ? html : html.slice(0, at + 6) + tag + html.slice(at + 6)).replace(BOARD_JSON_MARK, anchor);
	return new Response(body, { status: shell.status, headers });
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const m = BOARD_JSON.exec(url.pathname);
		if (m && (m[2] || wantsJson(request))) {
			return app.fetch(new Request(new URL("/api/boards/" + m[1] + url.search, url.origin), request), env, ctx);
		}
		if (url.pathname === "/openapi.json" || url.pathname === "/mcp") {
			return app.fetch(new Request(new URL("/api" + url.pathname + url.search, url.origin), request), env, ctx);
		}
		if ((CARD_PATHS as readonly string[]).includes(url.pathname)) {
			return app.fetch(new Request(new URL("/api/mcp/server-card" + url.search, url.origin), request), env, ctx);
		}
		if (isBoardPage(url.pathname) && env.ASSETS) {
			const shell = await env.ASSETS.fetch(new Request(new URL("/b/", url.origin), request));
			return m ? withAlternate(shell, "/b/" + m[1] + ".json") : shell;
		}
		return app.fetch(request, env, ctx);
	},
};

export { app };
