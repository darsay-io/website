/**
 * The board, for programs: keys and scopes, the two address forms,
 * revisions and If-Match, idempotency keys, drop / restore / remove,
 * search, apply and batch (with dry runs), the audit trail, webhooks,
 * the JSON page address, and the MCP server. Runs on real SQLite with
 * the repository's migrations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { app, parseIfMatch, type Env } from "./index.ts";
import { sign } from "./webhooks.ts";
import { TestD1 } from "./testdb.ts";
import { MAX_ENTRIES } from "./validate.ts";

const CREATE_SECRET = "test-create";

class FakeCtx {
	pending: Promise<unknown>[] = [];
	waitUntil(p: Promise<unknown>) {
		this.pending.push(p);
	}
	passThroughOnException() {}
	async settle() {
		await Promise.all(this.pending);
		this.pending = [];
	}
}

function env(db = new TestD1(), extra: Partial<Env> = {}): { db: TestD1; env: Env; ctx: FakeCtx } {
	return { db, env: { DB: db as unknown as D1Database, CREATE_PASSWORD: CREATE_SECRET, ...extra }, ctx: new FakeCtx() };
}

type Harness = ReturnType<typeof env>;

function jsonInit(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
	return {
		method,
		headers: { "Content-Type": "application/json", ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	};
}

async function call(h: Harness, path: string, init?: RequestInit) {
	return app.request(path, init, h.env, h.ctx as unknown as ExecutionContext);
}

async function mkBoard(h: Harness, title = "Genesis stack"): Promise<string> {
	const res = await call(h, "/api/boards", jsonInit("POST", { title, password: CREATE_SECRET }));
	expect(res.status).toBe(201);
	const body = (await res.json()) as { id: string; revision: number };
	expect(body.revision).toBe(0);
	return body.id;
}

async function addRow(h: Harness, id: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
	const res = await call(h, `/api/boards/${id}/entries`, jsonInit("POST", body, headers));
	return { status: res.status, row: (await res.json()) as Record<string, unknown> & { id: number }, res };
}

async function mintKey(h: Harness, id: string, label: string, scopes?: string[]) {
	const res = await call(h, `/api/boards/${id}/keys`, jsonInit("POST", { label, ...(scopes ? { scopes } : {}) }));
	expect(res.status).toBe(201);
	return (await res.json()) as { id: string; key: string; scopes: string[]; label: string };
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("no", { status: 404 })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the board as a document", () => {
	it("carries revision, ETag, access, counts, links, and structured rows", async () => {
		const h = env();
		const id = await mkBoard(h);
		const a = await addRow(h, id, { source: "Qwen/Qwen3.8-27B-Instruct", desire: 8 });
		expect(a.status).toBe(201);
		expect(a.row.address).toEqual({ kind: "model", provider: "huggingface", locator: "Qwen/Qwen3.8-27B-Instruct", url: "https://huggingface.co/Qwen/Qwen3.8-27B-Instruct" });
		expect(a.row.lineage).toMatchObject({ family: "Qwen", generation: "3.8", member: "27B", read_from: "name" });
		expect(a.row.updated).toBe(a.row.added);
		expect(a.row.dropped).toBeNull();
		await addRow(h, id, { source: "datasets/ESCAD/OpenRTLSet" });
		await addRow(h, id, { source: "https://example.com/models/qwen-3.8-max", desire: 2 });

		const res = await call(h, `/api/boards/${id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("ETag")).toBe('"3"');
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const board = (await res.json()) as Record<string, unknown>;
		expect(board.id).toBe(id);
		expect(board.revision).toBe(3);
		expect(board.access).toEqual({ via: "url", scopes: ["read", "write", "claim", "remove"], key: null });
		expect(board.counts).toEqual({ rows: 3, want: 3, have: 0, claimed: 0, dropped: 0 });
		expect(board.links).toMatchObject({ page: `http://localhost/b/${id}`, json: `http://localhost/b/${id}.json`, mcp: "http://localhost/mcp", openapi: "http://localhost/openapi.json" });
		const entries = board.entries as Array<{ source: string; desire: number | null; address: { kind: string } }>;
		expect(entries.map((e) => e.source)).toEqual(["huggingface:Qwen/Qwen3.8-27B-Instruct", "https://example.com/models/qwen-3.8-max", "huggingface:datasets/ESCAD/OpenRTLSet"]);
		expect(entries[1].address.kind).toBe("closed");
		expect(entries[2].address.kind).toBe("dataset");

		const same = await call(h, `/api/boards/${id}`, { headers: { "If-None-Match": '"3"' } });
		expect(same.status).toBe(304);
		const one = await call(h, `/api/boards/${id}/entries/${a.row.id}`);
		expect(one.status).toBe(200);
		expect(((await one.json()) as { id: number }).id).toBe(a.row.id);
	});

	it("answers the page address as JSON: /b/<id>.json, or Accept: application/json", async () => {
		const h = env();
		const id = await mkBoard(h);
		const asJson = await worker.fetch(new Request(`http://localhost/b/${id}.json`), h.env, h.ctx as unknown as ExecutionContext);
		expect(asJson.status).toBe(200);
		expect(asJson.headers.get("content-type")).toContain("application/json");
		expect(((await asJson.json()) as { id: string }).id).toBe(id);
		const negotiated = await worker.fetch(new Request(`http://localhost/b/${id}`, { headers: { Accept: "application/json" } }), h.env, h.ctx as unknown as ExecutionContext);
		expect(negotiated.status).toBe(200);
		expect(((await negotiated.json()) as { id: string }).id).toBe(id);
		h.env.ASSETS = { fetch: async () => new Response("<html>shell</html>", { status: 200, headers: { "content-type": "text/html" } }) } as unknown as Fetcher;
		const browser = await worker.fetch(new Request(`http://localhost/b/${id}`, { headers: { Accept: "text/html,application/xhtml+xml,*/*" } }), h.env, h.ctx as unknown as ExecutionContext);
		expect(await browser.text()).toContain("shell");
		const spec = await worker.fetch(new Request("http://localhost/openapi.json"), h.env, h.ctx as unknown as ExecutionContext);
		expect(spec.status).toBe(200);
		expect(((await spec.json()) as { openapi: string }).openapi).toBe("3.1.0");
	});

	it("serves the field guide without a board", async () => {
		const h = env();
		const all = await call(h, "/api/guide");
		expect(all.status).toBe(200);
		const guide = (await all.json()) as { cards: Array<{ key: string }>; chips: string[] };
		expect(guide.cards.length).toBeGreaterThan(15);
		expect(guide.chips).toContain("gated");
		const one = await call(h, "/api/guide/gated");
		expect(((await one.json()) as { key: string; doc: { href: string } }).doc.href).toMatch(/^http:\/\/localhost\/docs\//);
		const lens = await call(h, "/api/guide/spec");
		expect(((await lens.json()) as { key: string }).key).toBe("spec");
		expect((await call(h, "/api/guide/nope")).status).toBe(404);
	});
});

describe("keys and scopes", () => {
	it("mints a key the URL can narrow, lists it, and revokes it", async () => {
		const h = env();
		const id = await mkBoard(h);
		const k = await mintKey(h, id, "chatgpt", ["write"]);
		expect(k.key).toMatch(/^darsay_[0-9a-f]{48}$/);
		expect(k.scopes).toEqual(["read", "write"]);
		const list = await call(h, `/api/boards/${id}/keys`);
		const keys = ((await list.json()) as { keys: Array<{ id: string; label: string }> }).keys;
		expect(keys).toHaveLength(1);
		expect(keys[0].label).toBe("chatgpt");
		expect(JSON.stringify(await (await call(h, `/api/boards/${id}/keys`)).json())).not.toContain(k.key);
		const gone = await call(h, `/api/boards/${id}/keys/${k.id}`, { method: "DELETE" });
		expect(gone.status).toBe(200);
		const after = await call(h, "/api/board", { headers: bearer(k.key) });
		expect(after.status).toBe(401);
		expect(await after.json()).toEqual({ error: "bad_key" });
	});

	it("refuses bad scopes, empty labels, and a 21st key", async () => {
		const h = env();
		const id = await mkBoard(h);
		expect((await call(h, `/api/boards/${id}/keys`, jsonInit("POST", { label: "x", scopes: ["admin"] }))).status).toBe(400);
		expect((await call(h, `/api/boards/${id}/keys`, jsonInit("POST", { label: "  " }))).status).toBe(400);
		for (let i = 0; i < 20; i++) await mintKey(h, id, `k${i}`);
		const res = await call(h, `/api/boards/${id}/keys`, jsonInit("POST", { label: "one too many" }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "key_cap" });
	});

	it("names the board by bearer under /api/board and never shows the id", async () => {
		const h = env();
		const id = await mkBoard(h);
		await addRow(h, id, { source: "Qwen/Qwen3-0.6B", desire: 5 });
		const k = await mintKey(h, id, "reader", []);
		const res = await call(h, "/api/board", { headers: bearer(k.key) });
		expect(res.status).toBe(200);
		const board = (await res.json()) as Record<string, unknown>;
		expect(board.id).toBeUndefined();
		expect(JSON.stringify(board)).not.toContain(id);
		expect(board.access).toEqual({ via: "key", scopes: ["read"], key: { id: k.id, label: "reader" } });
		expect(board.links).toMatchObject({ api: "http://localhost/api/board", catalog: "http://localhost/api/board/catalog.json" });
		const cat = await call(h, "/api/board/catalog.json", { headers: bearer(k.key) });
		expect(cat.status).toBe(200);
		expect(JSON.stringify(await cat.json())).not.toContain(id);
	});

	it("enforces scopes: read-only cannot write, write cannot remove, nothing a key does mints keys", async () => {
		const h = env();
		const id = await mkBoard(h);
		const reader = await mintKey(h, id, "reader", []);
		const writer = await mintKey(h, id, "writer", ["write"]);
		const denied = await call(h, "/api/board/entries", jsonInit("POST", { source: "Qwen/Qwen3-0.6B" }, bearer(reader.key)));
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ error: "forbidden", scope: "write" });
		const added = await call(h, "/api/board/entries", jsonInit("POST", { source: "Qwen/Qwen3-0.6B" }, bearer(writer.key)));
		expect(added.status).toBe(201);
		const row = (await added.json()) as { id: number };
		const remove = await call(h, `/api/board/entries/${row.id}`, { method: "DELETE", headers: bearer(writer.key) });
		expect(remove.status).toBe(403);
		const drop = await call(h, `/api/board/entries/${row.id}/drop`, { method: "POST", headers: bearer(writer.key) });
		expect(drop.status).toBe(200);
		const mint = await call(h, "/api/board/keys", jsonInit("POST", { label: "escalate" }, bearer(writer.key)));
		expect(mint.status).toBe(403);
		expect(await mint.json()).toEqual({ error: "url_required" });
		const destroy = await call(h, "/api/board", jsonInit("DELETE", { confirm: "delete" }, bearer(writer.key)));
		expect(destroy.status).toBe(403);
	});

	it("wants a bearer under /api/board, refuses a key from another board, and honors the id as a bearer", async () => {
		const h = env();
		const a = await mkBoard(h, "A");
		const b = await mkBoard(h, "B");
		const none = await call(h, "/api/board");
		expect(none.status).toBe(401);
		expect(none.headers.get("WWW-Authenticate")).toContain("Bearer");
		expect(await none.json()).toEqual({ error: "key_required" });
		const garbage = await call(h, "/api/board", { headers: { Authorization: "Bearer nope" } });
		expect(garbage.status).toBe(401);
		expect(await garbage.json()).toEqual({ error: "bad_bearer" });
		const kb = await mintKey(h, b, "b-key");
		const wrong = await call(h, `/api/boards/${a}`, { headers: bearer(kb.key) });
		expect(wrong.status).toBe(403);
		expect(await wrong.json()).toEqual({ error: "wrong_board" });
		const byId = await call(h, "/api/board", { headers: bearer(a) });
		expect(byId.status).toBe(200);
		expect(((await byId.json()) as { id: string; access: { via: string } }).access.via).toBe("url");
	});

	it("attributes writes to the key in the audit trail, even on the URL address", async () => {
		const h = env();
		const id = await mkBoard(h);
		const k = await mintKey(h, id, "codex", ["write"]);
		await addRow(h, id, { source: "Qwen/Qwen3-0.6B" }, bearer(k.key));
		const audit = await call(h, `/api/boards/${id}/audit`);
		const events = ((await audit.json()) as { events: Array<{ action: string; actor: { label: string; via: string } }> }).events;
		expect(events[0]).toMatchObject({ action: "row.added", actor: { via: "key", label: "key:codex" } });
		expect(events.some((e) => e.action === "key.created")).toBe(true);
	});
});

describe("revisions and If-Match", () => {
	it("parses If-Match forms", () => {
		expect(parseIfMatch('"12"')).toBe(12);
		expect(parseIfMatch('W/"12"')).toBe(12);
		expect(parseIfMatch("12")).toBe(12);
		expect(parseIfMatch("*")).toBeNull();
		expect(parseIfMatch(undefined)).toBeNull();
		expect(parseIfMatch("board-revision-184")).toBe(-1);
	});

	it("refuses a stale write and accepts a current one", async () => {
		const h = env();
		const id = await mkBoard(h);
		const a = await addRow(h, id, { source: "Qwen/Qwen3-0.6B", desire: 3 });
		const stale = await call(h, `/api/boards/${id}/entries/${a.row.id}`, jsonInit("PATCH", { desire: 9 }, { "If-Match": '"0"' }));
		expect(stale.status).toBe(412);
		expect(await stale.json()).toEqual({ error: "stale", revision: 1, expected: 0 });
		const fresh = await call(h, `/api/boards/${id}/entries/${a.row.id}`, jsonInit("PATCH", { desire: 9 }, { "If-Match": '"1"' }));
		expect(fresh.status).toBe(200);
		expect(fresh.headers.get("ETag")).toBe('"2"');
		const noop = await call(h, `/api/boards/${id}/entries/${a.row.id}`, jsonInit("PATCH", { desire: 9 }));
		expect(noop.status).toBe(200);
		expect(noop.headers.get("ETag")).toBe('"2"');
	});
});

describe("idempotency keys", () => {
	it("replays the same answer for the same request, refuses a different one under the same key", async () => {
		const h = env();
		const id = await mkBoard(h);
		const hdr = { "Idempotency-Key": "8e79e3" };
		const first = await call(h, `/api/boards/${id}/entries`, jsonInit("POST", { source: "Qwen/Qwen3-0.6B", desire: 4 }, hdr));
		expect(first.status).toBe(201);
		const firstBody = await first.text();
		const again = await call(h, `/api/boards/${id}/entries`, jsonInit("POST", { source: "Qwen/Qwen3-0.6B", desire: 4 }, hdr));
		expect(again.status).toBe(201);
		expect(again.headers.get("Idempotent-Replayed")).toBe("true");
		expect(await again.text()).toBe(firstBody);
		expect(((await (await call(h, `/api/boards/${id}`)).json()) as { revision: number }).revision).toBe(1);
		const other = await call(h, `/api/boards/${id}/entries`, jsonInit("POST", { source: "Qwen/Qwen3-1.7B" }, hdr));
		expect(other.status).toBe(422);
		expect(await other.json()).toEqual({ error: "idempotency_mismatch" });
		const bad = await call(h, `/api/boards/${id}/entries`, jsonInit("POST", { source: "x/y" }, { "Idempotency-Key": "has space" }));
		expect(bad.status).toBe(400);
	});
});

describe("drop, restore, remove", () => {
	it("hides a dropped row from the list and the export, keeps it restorable, and lets an add bring it back", async () => {
		const h = env();
		const id = await mkBoard(h);
		const a = await addRow(h, id, { source: "Qwen/Qwen3-0.6B", desire: 7, note: "keep" });
		const drop = await call(h, `/api/boards/${id}/entries/${a.row.id}/drop`, { method: "POST" });
		expect(drop.status).toBe(200);
		expect(((await drop.json()) as { dropped: string | null }).dropped).not.toBeNull();
		const board = (await (await call(h, `/api/boards/${id}`)).json()) as { entries: unknown[]; counts: { dropped: number; rows: number } };
		expect(board.entries).toHaveLength(0);
		expect(board.counts).toMatchObject({ rows: 0, dropped: 1 });
		const only = (await (await call(h, `/api/boards/${id}?dropped=only`)).json()) as { entries: Array<{ id: number }> };
		expect(only.entries.map((e) => e.id)).toEqual([a.row.id]);
		const cat = (await (await call(h, `/api/boards/${id}/catalog.json`)).json()) as { entries: unknown[] };
		expect(cat.entries).toHaveLength(0);
		const claim = await call(h, `/api/boards/${id}/entries/${a.row.id}/claim`, jsonInit("POST", { client: "amber-heron-3f" }));
		expect(claim.status).toBe(409);
		expect(await claim.json()).toMatchObject({ error: "dropped" });
		const again = await addRow(h, id, { source: "Qwen/Qwen3-0.6B" });
		expect(again.status).toBe(200);
		expect(again.row.id).toBe(a.row.id);
		expect(again.row.dropped).toBeNull();
		expect(again.row.note).toBe("keep");
		const audit = (await (await call(h, `/api/boards/${id}/audit?entry=${a.row.id}`)).json()) as { events: Array<{ action: string }> };
		expect(audit.events.map((e) => e.action)).toEqual(["row.restored", "row.dropped", "row.added"]);
		const dropAgain = await call(h, `/api/boards/${id}/entries/${a.row.id}/drop`, { method: "POST" });
		expect(dropAgain.status).toBe(200);
		const restore = await call(h, `/api/boards/${id}/entries/${a.row.id}/restore`, { method: "POST" });
		expect(((await restore.json()) as { dropped: string | null }).dropped).toBeNull();
		const remove = await call(h, `/api/boards/${id}/entries/${a.row.id}`, { method: "DELETE" });
		expect(remove.status).toBe(200);
		expect((await call(h, `/api/boards/${id}/entries/${a.row.id}`)).status).toBe(404);
		const last = (await (await call(h, `/api/boards/${id}/audit?limit=1`)).json()) as { events: Array<{ action: string; before: { source: string }; after: unknown }> };
		expect(last.events[0]).toMatchObject({ action: "row.removed", before: { source: "huggingface:Qwen/Qwen3-0.6B" }, after: null });
	});

	it("a catalog import by a key without remove drops instead of removing, and restores what it names again", async () => {
		const h = env();
		const id = await mkBoard(h, "Summer");
		const a = await addRow(h, id, { source: "Qwen/Qwen3-0.6B", holders: "Maya" });
		const b = await addRow(h, id, { source: "Qwen/Qwen3-1.7B" });
		await call(h, `/api/boards/${id}/entries/${b.row.id}/drop`, { method: "POST" });
		const k = await mintKey(h, id, "cli-key", ["write"]);
		const doc = { catalog_schema_version: "2.0.0", kind: "darsay.catalog", id: "summer", entries: [{ source: "huggingface:Qwen/Qwen3-1.7B", desire: 6 }] };
		const res = await call(h, "/api/board/catalog.json", jsonInit("POST", doc, bearer(k.key)));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, added: 0, updated: 0, restored: 1, removed: 0, dropped: 1, entries: 1 });
		const all = (await (await call(h, `/api/boards/${id}?dropped=all`)).json()) as { entries: Array<{ id: number; dropped: string | null; holders: string; desire: number | null }> };
		const rowA = all.entries.find((e) => e.id === a.row.id)!;
		const rowB = all.entries.find((e) => e.id === b.row.id)!;
		expect(rowA.dropped).not.toBeNull();
		expect(rowA.holders).toBe("Maya");
		expect(rowB.dropped).toBeNull();
		expect(rowB.desire).toBe(6);
		const byUrl = await call(h, `/api/boards/${id}/catalog.json`, jsonInit("POST", doc));
		expect(await byUrl.json()).toMatchObject({ removed: 0, dropped: 0, updated: 1 });
	});
});

describe("finding rows", () => {
	it("filters by address, status, type, lens, family, desire, and text", async () => {
		const h = env();
		const id = await mkBoard(h);
		await addRow(h, id, { source: "Qwen/Qwen3.8-27B-Instruct", desire: 8, status: "have", holders: "Maya, USB in Berlin" });
		await addRow(h, id, { source: "Qwen/Qwen3.8-27B-Base", desire: 5, note: "the experimental organism" });
		await addRow(h, id, { source: "datasets/ESCAD/OpenRTLSet", desire: 9 });
		await addRow(h, id, { source: "huihui-ai/Qwen3-4B-abliterated" });
		const get = async (qs: string) => {
			const res = await call(h, `/api/boards/${id}/entries?${qs}`);
			expect(res.status).toBe(200);
			return ((await res.json()) as { count: number; entries: Array<{ source: string }> }).entries.map((e) => e.source);
		};
		expect(await get("source=https://huggingface.co/datasets/ESCAD/OpenRTLSet")).toEqual(["huggingface:datasets/ESCAD/OpenRTLSet"]);
		expect(await get("source=ESCAD/OpenRTLSet")).toEqual(["huggingface:datasets/ESCAD/OpenRTLSet"]);
		expect(await get("status=have")).toEqual(["huggingface:Qwen/Qwen3.8-27B-Instruct"]);
		expect(await get("type=dataset")).toEqual(["huggingface:datasets/ESCAD/OpenRTLSet"]);
		expect(await get("lens=base")).toEqual(["huggingface:Qwen/Qwen3.8-27B-Base"]);
		expect(await get("lens=abliterated")).toEqual(["huggingface:huihui-ai/Qwen3-4B-abliterated"]);
		expect(await get("family=qwen&lens=want")).toEqual(["huggingface:Qwen/Qwen3.8-27B-Base", "huggingface:huihui-ai/Qwen3-4B-abliterated"]);
		expect(await get("desire_min=8")).toEqual(["huggingface:datasets/ESCAD/OpenRTLSet", "huggingface:Qwen/Qwen3.8-27B-Instruct"]);
		expect(await get("q=berlin")).toEqual(["huggingface:Qwen/Qwen3.8-27B-Instruct"]);
		expect(await get("q=organism")).toEqual(["huggingface:Qwen/Qwen3.8-27B-Base"]);
		expect(await get("limit=1")).toHaveLength(1);
		const bad = await call(h, `/api/boards/${id}/entries?lens=tier-0`);
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ error: "unknown lens" });
	});
});

describe("apply", () => {
	const rows = [
		{ ref: "openrtlset", source: "datasets/ESCAD/OpenRTLSet", desire: 9, note: "RTL corpus" },
		{ ref: "circuitnet", source: "huggingface:datasets/SKLP-EDA-LAB/CircuitNet3.0", desire: 8 },
		{ ref: "qwen", source: "Qwen/Qwen3.8-27B", desire: 7 },
	];

	it("plans on dry_run, then adds, updates, and leaves the identical alone", async () => {
		const h = env();
		const id = await mkBoard(h);
		const dry = await call(h, `/api/boards/${id}/apply?dry_run=true`, jsonInit("POST", { rows }));
		expect(dry.status).toBe(200);
		const plan = (await dry.json()) as { dry_run: boolean; summary: Record<string, number>; rows: Array<{ ref: string; action: string; id: number | null }> };
		expect(plan.dry_run).toBe(true);
		expect(plan.summary).toMatchObject({ added: 3, updated: 0, unchanged: 0 });
		expect(plan.rows.map((r) => [r.ref, r.action, r.id])).toEqual([["openrtlset", "added", null], ["circuitnet", "added", null], ["qwen", "added", null]]);
		expect(((await (await call(h, `/api/boards/${id}`)).json()) as { revision: number }).revision).toBe(0);

		const real = await call(h, `/api/boards/${id}/apply`, jsonInit("POST", { rows }));
		expect(real.status).toBe(200);
		const done = (await real.json()) as { revision: number; summary: Record<string, number>; rows: Array<{ ref: string; action: string; id: number | null; source: string }> };
		expect(done.summary).toMatchObject({ added: 3, updated: 0, unchanged: 0 });
		expect(done.revision).toBe(1);
		expect(done.rows.every((r) => typeof r.id === "number")).toBe(true);
		expect(done.rows.find((r) => r.ref === "openrtlset")!.source).toBe("huggingface:datasets/ESCAD/OpenRTLSet");

		const again = (await (await call(h, `/api/boards/${id}/apply`, jsonInit("POST", { rows: [...rows.slice(0, 2), { ...rows[2], desire: 3 }] }))).json()) as { revision: number; summary: Record<string, number>; rows: Array<{ ref: string; action: string; changes?: string[] }> };
		expect(again.summary).toMatchObject({ added: 0, updated: 1, unchanged: 2 });
		expect(again.rows.find((r) => r.ref === "qwen")).toMatchObject({ action: "updated", changes: ["desire"] });
		expect(again.revision).toBe(2);
		const same = (await (await call(h, `/api/boards/${id}/apply`, jsonInit("POST", { rows: [rows[0]] }))).json()) as { revision: number; summary: Record<string, number> };
		expect(same.summary).toMatchObject({ unchanged: 1 });
		expect(same.revision).toBe(2);
	});

	it("sync drops what the list left out and restores what it names again; never removes", async () => {
		const h = env();
		const id = await mkBoard(h);
		await call(h, `/api/boards/${id}/apply`, jsonInit("POST", { rows }));
		const sync = (await (await call(h, `/api/boards/${id}/apply`, jsonInit("POST", { rows: rows.slice(0, 1), mode: "sync" }))).json()) as { summary: Record<string, number>; rows: Array<{ action: string; source: string }> };
		expect(sync.summary).toMatchObject({ unchanged: 1, dropped: 2, removed: 0 });
		const board = (await (await call(h, `/api/boards/${id}`)).json()) as { entries: unknown[]; counts: { dropped: number } };
		expect(board.entries).toHaveLength(1);
		expect(board.counts.dropped).toBe(2);
		const back = (await (await call(h, `/api/boards/${id}/apply`, jsonInit("POST", { rows }))).json()) as { summary: Record<string, number> };
		expect(back.summary).toMatchObject({ restored: 2, unchanged: 1, added: 0 });
	});

	it("fails the whole list on one bad row, names duplicates, and respects the board's room", async () => {
		const h = env();
		const id = await mkBoard(h);
		const bad = await call(h, `/api/boards/${id}/apply`, jsonInit("POST", { rows: [rows[0], { ref: "broken", source: "https://example.com/" }] }));
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ error: "invalid rows", failures: [{ index: 1, ref: "broken" }] });
		expect(((await (await call(h, `/api/boards/${id}`)).json()) as { revision: number }).revision).toBe(0);
		const dup = await call(h, `/api/boards/${id}/apply`, jsonInit("POST", { rows: [rows[0], { ...rows[0], ref: "twice" }] }));
		expect(await dup.json()).toMatchObject({ failures: [{ ref: "twice" }] });
		for (let i = 0; i < MAX_ENTRIES - 1; i++) {
			h.db.exec("INSERT INTO entries (board_id, source, revision, include_key, status, holders, added) VALUES (?, ?, '', '[]', 'want', '', '2026-08-26T18:00:00+00:00')", id, `opaque:n${i}`);
		}
		const full = await call(h, `/api/boards/${id}/apply`, jsonInit("POST", { rows: rows.slice(0, 2) }));
		expect(full.status).toBe(400);
		expect(await full.json()).toMatchObject({ error: "entry_cap", room: 1 });
	});
});

describe("batch", () => {
	it("writes explicit operations as a whole, or nothing", async () => {
		const h = env();
		const id = await mkBoard(h);
		const a = await addRow(h, id, { source: "Qwen/Qwen3-0.6B", desire: 2 });
		const b = await addRow(h, id, { source: "Qwen/Qwen3-1.7B" });
		const ops = [
			{ op: "add", ref: "new", source: "Qwen/Qwen3-4B", desire: 6 },
			{ op: "update", ref: "bump", id: a.row.id, desire: 9, status: "have" },
			{ op: "drop", ref: "bye", id: b.row.id },
		];
		const dry = (await (await call(h, `/api/boards/${id}/entries/batch`, jsonInit("POST", { operations: ops, dry_run: true }))).json()) as { dry_run: boolean; rows: Array<{ ref: string; action: string }> };
		expect(dry.dry_run).toBe(true);
		expect(dry.rows.map((r) => [r.ref, r.action])).toEqual([["new", "added"], ["bump", "updated"], ["bye", "dropped"]]);
		const res = await call(h, `/api/boards/${id}/entries/batch`, jsonInit("POST", { operations: ops }));
		expect(res.status).toBe(200);
		const done = (await res.json()) as { revision: number; summary: Record<string, number>; rows: Array<{ ref: string; action: string; id: number }> };
		expect(done.summary).toMatchObject({ added: 1, updated: 1, dropped: 1 });
		expect(done.revision).toBe(3);
		const board = (await (await call(h, `/api/boards/${id}`)).json()) as { entries: Array<{ id: number; desire: number | null; status: string }> };
		expect(board.entries.map((e) => e.id).sort()).toEqual([a.row.id, done.rows.find((r) => r.ref === "new")!.id].sort());
		expect(board.entries.find((e) => e.id === a.row.id)).toMatchObject({ desire: 9, status: "have" });

		const broken = await call(h, `/api/boards/${id}/entries/batch`, jsonInit("POST", { operations: [{ op: "update", id: a.row.id, desire: 1 }, { op: "drop", id: 9999 }] }));
		expect(broken.status).toBe(400);
		expect(await broken.json()).toMatchObject({ error: "invalid operations", failures: [{ index: 1 }] });
		expect(((await (await call(h, `/api/boards/${id}`)).json()) as { revision: number }).revision).toBe(3);
	});

	it("keeps remove behind the remove scope", async () => {
		const h = env();
		const id = await mkBoard(h);
		const a = await addRow(h, id, { source: "Qwen/Qwen3-0.6B" });
		const k = await mintKey(h, id, "writer", ["write"]);
		const res = await call(h, "/api/board/entries/batch", jsonInit("POST", { operations: [{ op: "remove", id: a.row.id }] }, bearer(k.key)));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ failures: [{ error: expect.stringContaining("remove scope") }] });
		const byUrl = await call(h, `/api/boards/${id}/entries/batch`, jsonInit("POST", { operations: [{ op: "remove", id: a.row.id }] }));
		expect(await byUrl.json()).toMatchObject({ summary: { removed: 1 } });
	});
});

describe("the audit trail", () => {
	it("records who did what with before and after, newest first, and pages", async () => {
		const h = env();
		const id = await mkBoard(h);
		await call(h, `/api/boards/${id}`, jsonInit("PATCH", { title: "Renamed" }, { "User-Agent": "darsay/0.14.10 (+https://darsay.io)" }));
		const a = await addRow(h, id, { source: "Qwen/Qwen3-0.6B", desire: 4 });
		await call(h, `/api/boards/${id}/entries/${a.row.id}`, jsonInit("PATCH", { desire: 8, note: "now" }));
		const page = (await (await call(h, `/api/boards/${id}/audit?limit=2`)).json()) as { events: Array<Record<string, unknown>>; next_before: number | null };
		expect(page.events).toHaveLength(2);
		expect(page.events[0]).toMatchObject({ action: "row.updated", entry_id: a.row.id, before: { desire: 4, note: null }, after: { desire: 8, note: "now", changes: ["desire", "note"] }, revision: 3, actor: { label: "url", client: "rest" } });
		expect(page.events[1]).toMatchObject({ action: "row.added", after: { source: "huggingface:Qwen/Qwen3-0.6B" }, revision: 2 });
		expect(page.next_before).toBe(page.events[1].id);
		const rest = (await (await call(h, `/api/boards/${id}/audit?before=${page.next_before}`)).json()) as { events: Array<Record<string, unknown>>; next_before: number | null };
		expect(rest.events).toHaveLength(1);
		expect(rest.events[0]).toMatchObject({ action: "board.updated", before: { title: "Genesis stack" }, after: { title: "Renamed" }, actor: { label: "cli", client: "cli" } });
		expect(rest.next_before).toBeNull();
	});
});

describe("webhooks", () => {
	it("registers only public https listeners, lists, and removes them", async () => {
		const h = env();
		const id = await mkBoard(h);
		for (const url of ["http://example.com/hook", "https://localhost/hook", "https://10.0.0.1/hook", "https://[::1]/hook", "https://intranet/hook", "https://box.local/hook"]) {
			const res = await call(h, `/api/boards/${id}/webhooks`, jsonInit("POST", { url }));
			expect(res.status, url).toBe(400);
		}
		const bad = await call(h, `/api/boards/${id}/webhooks`, jsonInit("POST", { url: "https://example.com/hook", events: ["card.created"] }));
		expect(bad.status).toBe(400);
		const res = await call(h, `/api/boards/${id}/webhooks`, jsonInit("POST", { url: "https://example.com/hook#frag", events: ["row.added"] }));
		expect(res.status).toBe(201);
		const hook = (await res.json()) as { id: string; url: string; secret: string; events: string[] };
		expect(hook.url).toBe("https://example.com/hook");
		expect(hook.secret).toMatch(/^whsec_/);
		const list = (await (await call(h, `/api/boards/${id}/webhooks`)).json()) as { webhooks: Array<{ id: string; events: string[] }> };
		expect(list.webhooks).toEqual([expect.objectContaining({ id: hook.id, events: ["row.added"] })]);
		expect(JSON.stringify(list)).not.toContain(hook.secret);
		const k = await mintKey(h, id, "writer");
		expect((await call(h, "/api/board/webhooks", { headers: bearer(k.key) })).status).toBe(403);
		expect((await call(h, `/api/boards/${id}/webhooks/${hook.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await call(h, `/api/boards/${id}/webhooks/${hook.id}`, { method: "DELETE" })).status).toBe(404);
	});

	it("delivers one signed POST per commit with the matching events and no board id", async () => {
		const h = env();
		const id = await mkBoard(h);
		const hook = (await (await call(h, `/api/boards/${id}/webhooks`, jsonInit("POST", { url: "https://listener.example/darsay", events: ["row.added", "row.dropped"], secret: "s3cret" }))).json()) as { id: string };
		const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.startsWith("https://listener.example/")) {
					seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
					return new Response(null, { status: 204 });
				}
				return new Response("no", { status: 404 });
			}),
		);
		const a = await addRow(h, id, { source: "Qwen/Qwen3-0.6B", desire: 5 });
		await h.ctx.settle();
		expect(seen).toHaveLength(1);
		expect(seen[0].headers["x-darsay-events"]).toBe("row.added");
		expect(seen[0].headers["x-darsay-signature"]).toBe(await sign("s3cret", seen[0].body));
		const payload = JSON.parse(seen[0].body) as { board: { catalog_id: string; revision: number }; events: Array<{ action: string; entry_id: number; after: { source: string } }> };
		expect(payload.board).toMatchObject({ catalog_id: "genesis-stack", revision: 2 });
		expect(payload.events).toEqual([expect.objectContaining({ action: "row.added", entry_id: a.row.id, after: expect.objectContaining({ source: "huggingface:Qwen/Qwen3-0.6B" }) })]);
		expect(seen[0].body).not.toContain(id);
		await call(h, `/api/boards/${id}/entries/${a.row.id}`, jsonInit("PATCH", { desire: 9 }));
		await h.ctx.settle();
		expect(seen).toHaveLength(1);
		await call(h, `/api/boards/${id}/entries/${a.row.id}/drop`, { method: "POST" });
		await h.ctx.settle();
		expect(seen).toHaveLength(2);
		const list = (await (await call(h, `/api/boards/${id}/webhooks`)).json()) as { webhooks: Array<{ id: string; last_status: number | null }> };
		expect(list.webhooks[0]).toMatchObject({ id: hook.id, last_status: 204 });
	});
});

describe("the MCP server", () => {
	const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
	const notify = (method: string) => ({ jsonrpc: "2.0", method, params: {} });

	async function mcp(h: Harness, key: string, body: unknown) {
		return call(h, "/api/mcp", jsonInit("POST", body, bearer(key)));
	}

	it("wants a bearer, refuses GET, and answers at /mcp as well as /api/mcp", async () => {
		const h = env();
		const none = await call(h, "/api/mcp", jsonInit("POST", rpc("initialize")));
		expect(none.status).toBe(401);
		expect(none.headers.get("WWW-Authenticate")).toContain("Bearer");
		const get = await call(h, "/api/mcp", { method: "GET", headers: bearer("x") });
		expect(get.status).toBe(405);
		const id = await mkBoard(h);
		const root = await worker.fetch(new Request("http://localhost/mcp", jsonInit("POST", rpc("ping"), bearer(id))), h.env, h.ctx as unknown as ExecutionContext);
		expect(root.status).toBe(200);
		expect(((await root.json()) as { result: unknown }).result).toEqual({});
	});

	it("initializes, lists tools, and runs them against the board the key names", async () => {
		const h = env();
		const id = await mkBoard(h);
		const k = await mintKey(h, id, "claude", ["write"]);
		const init = (await (await mcp(h, k.key, rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }))).json()) as { result: { protocolVersion: string; serverInfo: { name: string }; instructions: string; capabilities: { tools: unknown } } };
		expect(init.result.protocolVersion).toBe("2025-06-18");
		expect(init.result.serverInfo.name).toContain("darsay");
		expect(init.result.instructions).toContain("rows, not cards");
		expect((await mcp(h, k.key, notify("notifications/initialized"))).status).toBe(202);
		const list = (await (await mcp(h, k.key, rpc("tools/list"))).json()) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
		expect(list.result.tools.map((t) => t.name)).toEqual(["get_board", "find_rows", "get_row", "add_row", "update_row", "drop_row", "restore_row", "remove_row", "apply", "batch", "audit", "explain"]);
		expect(list.result.tools.find((t) => t.name === "get_board")!.annotations.readOnlyHint).toBe(true);

		const added = (await (await mcp(h, k.key, rpc("tools/call", { name: "add_row", arguments: { source: "ESCAD/OpenRTLSet", desire: 9, note: "RTL corpus" } }))).json()) as { result: { isError?: boolean; structuredContent: { id: number; source: string; desire: number } } };
		expect(added.result.isError).toBeUndefined();
		expect(added.result.structuredContent).toMatchObject({ source: "huggingface:ESCAD/OpenRTLSet", desire: 9 });
		const rowId = added.result.structuredContent.id;

		const board = (await (await mcp(h, k.key, rpc("tools/call", { name: "get_board", arguments: {} }))).json()) as { result: { structuredContent: { revision: number; entries: unknown[]; id?: string } } };
		expect(board.result.structuredContent.revision).toBe(2);
		expect(board.result.structuredContent.entries).toHaveLength(1);
		expect(board.result.structuredContent.id).toBeUndefined();

		const stale = (await (await mcp(h, k.key, rpc("tools/call", { name: "update_row", arguments: { id: rowId, desire: 1, expect_revision: 1 } }))).json()) as { result: { isError: boolean; structuredContent: { error: string } } };
		expect(stale.result.isError).toBe(true);
		expect(stale.result.structuredContent.error).toBe("stale");

		const removed = (await (await mcp(h, k.key, rpc("tools/call", { name: "remove_row", arguments: { id: rowId } }))).json()) as { result: { isError: boolean; structuredContent: { error: string; scope: string } } };
		expect(removed.result).toMatchObject({ isError: true, structuredContent: { error: "forbidden", scope: "remove" } });

		const explain = (await (await mcp(h, k.key, rpc("tools/call", { name: "explain", arguments: { chip: "gated" } }))).json()) as { result: { structuredContent: { key: string; title: string } } };
		expect(explain.result.structuredContent.key).toBe("gated");

		const audit = (await (await mcp(h, k.key, rpc("tools/call", { name: "audit", arguments: { limit: 1 } }))).json()) as { result: { structuredContent: { events: Array<{ actor: { label: string; client: string } }> } } };
		expect(audit.result.structuredContent.events[0].actor).toMatchObject({ label: "key:claude", client: "mcp" });

		const unknown = (await (await mcp(h, k.key, rpc("tools/call", { name: "create_card", arguments: {} }))).json()) as { error: { code: number } };
		expect(unknown.error.code).toBe(-32602);
		const missing = (await (await mcp(h, k.key, rpc("resources/list"))).json()) as { error: { code: number } };
		expect(missing.error.code).toBe(-32601);
		const ping = (await (await mcp(h, k.key, rpc("ping"))).json()) as { result: unknown };
		expect(ping.result).toEqual({});
	});

	it("accepts the board id itself as the bearer", async () => {
		const h = env();
		const id = await mkBoard(h);
		const res = (await (await mcp(h, id, rpc("tools/call", { name: "get_board", arguments: {} }))).json()) as { result: { structuredContent: { id: string; access: { via: string } } } };
		expect(res.result.structuredContent.id).toBe(id);
		expect(res.result.structuredContent.access.via).toBe("url");
	});

	// Revision 2026-07-28: the version and capabilities ride in _meta and are
	// mirrored into headers; there is no handshake.
	const META = "io.modelcontextprotocol/";
	const meta = (protocolVersion = "2026-07-28") => ({ [META + "protocolVersion"]: protocolVersion, [META + "clientCapabilities"]: {}, [META + "clientInfo"]: { name: "test", version: "0" } });
	const mirrored = (method: string, name?: string, protocolVersion = "2026-07-28") => ({ "MCP-Protocol-Version": protocolVersion, "Mcp-Method": method, ...(name ? { "Mcp-Name": name } : {}) });
	const modern = (method: string, params: Record<string, unknown> = {}, v?: string) => ({ jsonrpc: "2.0", id: 7, method, params: { ...params, _meta: meta(v) } });
	async function post(h: Harness, key: string, body: unknown, headers: Record<string, string>) {
		return call(h, "/api/mcp", jsonInit("POST", body, { ...bearer(key), ...headers }));
	}

	it("answers server/discover to anyone with a bearer, with or without _meta", async () => {
		const h = env();
		const id = await mkBoard(h);
		const bare = await mcp(h, id, rpc("server/discover"));
		expect(bare.status).toBe(200);
		const d = ((await bare.json()) as { result: { resultType: string; supportedVersions: string[]; capabilities: { tools: unknown }; instructions: string; ttlMs: number; cacheScope: string; _meta: Record<string, { name: string; websiteUrl: string }> } }).result;
		expect(d.resultType).toBe("complete");
		expect(d.supportedVersions[0]).toBe("2026-07-28");
		expect(d.supportedVersions).toContain("2025-06-18");
		expect(d.capabilities.tools).toBeDefined();
		expect(d.instructions).toContain("rows, not cards");
		expect(d.cacheScope).toBe("public");
		expect(d.ttlMs).toBeGreaterThan(0);
		expect(d._meta[META + "serverInfo"]).toMatchObject({ name: "darsay.io board", websiteUrl: "http://localhost/docs/board/agents/" });
		const withMeta = await post(h, id, modern("server/discover"), mirrored("server/discover"));
		expect(withMeta.status).toBe(200);
		// A version this server has never heard of still learns what it speaks.
		const future = await post(h, id, modern("server/discover", {}, "2031-01-01"), mirrored("server/discover", undefined, "2031-01-01"));
		expect(future.status).toBe(200);
	});

	it("serves 2026-07-28 statelessly: _meta, mirrored headers, resultType, a cacheable tool list", async () => {
		const h = env();
		const id = await mkBoard(h);
		const k = await mintKey(h, id, "codex", ["write"]);

		const list = await post(h, k.key, modern("tools/list"), mirrored("tools/list"));
		expect(list.status).toBe(200);
		const l = ((await list.json()) as { result: { resultType: string; tools: Array<{ name: string }>; ttlMs: number; cacheScope: string; _meta: Record<string, unknown> } }).result;
		expect(l.resultType).toBe("complete");
		expect(l.tools.map((t) => t.name)).toContain("apply");
		expect(l).toMatchObject({ ttlMs: expect.any(Number), cacheScope: "public" });
		expect(l._meta[META + "serverInfo"]).toBeDefined();

		const added = await post(h, k.key, modern("tools/call", { name: "add_row", arguments: { source: "ESCAD/OpenRTLSet", desire: 8 } }), mirrored("tools/call", "add_row"));
		expect(added.status).toBe(200);
		const a = ((await added.json()) as { result: { resultType: string; isError?: boolean; structuredContent: { source: string }; _meta: Record<string, unknown> } }).result;
		expect(a.resultType).toBe("complete");
		expect(a.isError).toBeUndefined();
		expect(a.structuredContent.source).toBe("huggingface:ESCAD/OpenRTLSet");
		expect(a._meta[META + "serverInfo"]).toBeDefined();

		// A name that rode as the Base64 sentinel is decoded before it is compared.
		const sentinel = await post(h, k.key, modern("tools/call", { name: "get_board", arguments: {} }), mirrored("tools/call", "=?base64?" + btoa("get_board") + "?="));
		expect(sentinel.status).toBe(200);
		expect(((await sentinel.json()) as { result: { structuredContent: { revision: number } } }).result.structuredContent.revision).toBe(2);

		// The audit trail still knows who acted.
		const audit = await post(h, k.key, modern("tools/call", { name: "audit", arguments: { limit: 1 } }), mirrored("tools/call", "audit"));
		expect(((await audit.json()) as { result: { structuredContent: { events: Array<{ actor: { label: string; client: string } }> } } }).result.structuredContent.events[0].actor).toMatchObject({ label: "key:codex", client: "mcp" });

		// A tool it does not have is a JSON-RPC error, not an HTTP one.
		const unknownTool = await post(h, k.key, modern("tools/call", { name: "create_card", arguments: {} }), mirrored("tools/call", "create_card"));
		expect(unknownTool.status).toBe(200);
		expect(((await unknownTool.json()) as { error: { code: number } }).error.code).toBe(-32602);
	});

	it("refuses a 2026-07-28 request whose headers are missing or disagree with the body", async () => {
		const h = env();
		const id = await mkBoard(h);
		const code = async (res: Response) => ((await res.json()) as { error: { code: number; message: string } }).error;

		const noVersion = await post(h, id, modern("tools/list"), { "Mcp-Method": "tools/list" });
		expect(noVersion.status).toBe(400);
		expect((await code(noVersion)).code).toBe(-32020);

		const wrongVersion = await post(h, id, modern("tools/list"), mirrored("tools/list", undefined, "2025-06-18"));
		expect(wrongVersion.status).toBe(400);
		expect(await code(wrongVersion)).toMatchObject({ code: -32020, message: expect.stringContaining("MCP-Protocol-Version") });

		const noMethod = await post(h, id, modern("tools/list"), { "MCP-Protocol-Version": "2026-07-28" });
		expect(noMethod.status).toBe(400);
		expect(await code(noMethod)).toMatchObject({ code: -32020, message: expect.stringContaining("Mcp-Method") });

		const wrongMethod = await post(h, id, modern("tools/list"), mirrored("tools/call"));
		expect(wrongMethod.status).toBe(400);
		expect((await code(wrongMethod)).code).toBe(-32020);

		const noName = await post(h, id, modern("tools/call", { name: "get_board", arguments: {} }), mirrored("tools/call"));
		expect(noName.status).toBe(400);
		expect(await code(noName)).toMatchObject({ code: -32020, message: expect.stringContaining("Mcp-Name") });

		const wrongName = await post(h, id, modern("tools/call", { name: "get_board", arguments: {} }), mirrored("tools/call", "add_row"));
		expect(wrongName.status).toBe(400);
		expect((await code(wrongName)).code).toBe(-32020);

		// Headers are checked before the version is: an intermediary's view and the body must agree first.
		const unsupported = await post(h, id, modern("tools/list", {}, "2031-01-01"), mirrored("tools/list", undefined, "2031-01-01"));
		expect(unsupported.status).toBe(400);
		const u = (await unsupported.json()) as { error: { code: number; data: { supported: string[]; requested: string } } };
		expect(u.error.code).toBe(-32022);
		expect(u.error.data).toEqual({ supported: ["2026-07-28"], requested: "2031-01-01" });

		// A version this server speaks only through initialize is not a per-request version.
		const legacyAsModern = await post(h, id, modern("tools/list", {}, "2025-06-18"), mirrored("tools/list", undefined, "2025-06-18"));
		expect(legacyAsModern.status).toBe(400);
		expect((await code(legacyAsModern)).code).toBe(-32022);

		const noCaps = await post(h, id, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [META + "protocolVersion"]: "2026-07-28" } } }, mirrored("tools/list"));
		expect(noCaps.status).toBe(400);
		expect(await code(noCaps)).toMatchObject({ code: -32602, message: expect.stringContaining("clientCapabilities") });

		// The handshake and ping belong to the older era; under 2026-07-28 they are unknown methods, and unknown is 404.
		for (const method of ["initialize", "ping", "resources/list"]) {
			const res = await post(h, id, modern(method), mirrored(method));
			expect(res.status, method).toBe(404);
			expect((await code(res)).code).toBe(-32601);
		}

		// The older era is untouched by any of this: no _meta, no headers, initialize answers.
		const legacy = await mcp(h, id, rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
		expect(legacy.status).toBe(200);
		expect(((await legacy.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");
	});
});

describe("the board page, for a program", () => {
	const shell = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Board</title></head><body><div id="board-root"></div></body></html>';
	function assets(): Fetcher {
		return { fetch: async () => new Response(shell, { headers: { "Content-Type": "text/html", "X-Robots-Tag": "noindex, nofollow" } }) } as unknown as Fetcher;
	}

	it("carries a link to its own JSON in the page and in a header", async () => {
		const h = env(new TestD1(), { ASSETS: assets() });
		const id = "c1b3b14664504a538da32956758d7a75";
		const res = await worker.fetch(new Request(`http://localhost/b/${id}`), h.env, h.ctx as unknown as ExecutionContext);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html");
		expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
		expect(res.headers.get("Link")).toBe(`</b/${id}.json>; rel="alternate"; type="application/json"`);
		const html = await res.text();
		expect(html).toContain(`<head><link rel="alternate" type="application/json" href="/b/${id}.json"><meta charset="utf-8">`);
		expect(html).toContain('<div id="board-root">');
	});

	it("leaves the bare shell alone", async () => {
		const h = env(new TestD1(), { ASSETS: assets() });
		const res = await worker.fetch(new Request("http://localhost/b/"), h.env, h.ctx as unknown as ExecutionContext);
		expect(res.status).toBe(200);
		expect(res.headers.get("Link")).toBeNull();
		expect(await res.text()).toBe(shell);
	});

	it("still hands a JSON reader the board, and links the card from the document", async () => {
		const h = env(new TestD1(), { ASSETS: assets() });
		const id = await mkBoard(h);
		const res = await worker.fetch(new Request(`http://localhost/b/${id}`, { headers: { Accept: "application/json" } }), h.env, h.ctx as unknown as ExecutionContext);
		expect(res.status).toBe(200);
		const doc = (await res.json()) as { id: string; links: Record<string, string> };
		expect(doc.id).toBe(id);
		expect(doc.links).toMatchObject({ mcp: "http://localhost/mcp", card: "http://localhost/.well-known/mcp-server-card", openapi: "http://localhost/openapi.json" });
	});
});
