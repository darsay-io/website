import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { app, type Env } from "./index.ts";
import { CREATE_CAP, LOOKUP_CAP, MAX_ENTRIES, utcDay } from "./validate.ts";

type Board = {
	id: string;
	catalog_id: string;
	title: string;
	curator: string | null;
	note: string | null;
	created: string;
	updated: string;
};

type Entry = {
	id: number;
	board_id: string;
	source: string;
	revision: string;
	include_json: string | null;
	include_key: string;
	desire: number | null;
	note: string | null;
	status: string;
	holders: string;
	added: string;
	payload_bytes: number | null;
	estimate_json: string | null;
};

class FakeD1 {
	boards = new Map<string, Board>();
	entries: Entry[] = [];
	nextId = 1;
	meta: Record<string, string> = {
		schema: "1",
		creates_utc: "1970-01-01",
		creates_n: "0",
		mutates_utc: "1970-01-01",
		mutates_n: "0",
		lookups_utc: "1970-01-01",
		lookups_n: "0",
	};

	prepare(sql: string) {
		const db = this;
		const stmt = {
			_binds: [] as unknown[],
			bind(...args: unknown[]) {
				stmt._binds = args;
				return stmt;
			},
			first: async () => db.exec(sql, stmt._binds, "first"),
			all: async () => ({ results: db.exec(sql, stmt._binds, "all") }),
			run: async () => db.exec(sql, stmt._binds, "run"),
		};
		return stmt;
	}

	async batch(stmts: ReturnType<FakeD1["prepare"]>[]) {
		const out = [];
		for (const s of stmts) out.push(await s.run());
		return out;
	}

	exec(sql: string, binds: unknown[], mode: "first" | "all" | "run") {
		const s = sql.replace(/\s+/g, " ").trim();
		if (s.startsWith("SELECT value FROM meta")) {
			const key = String(binds[0]);
			const value = this.meta[key];
			const row = value === undefined ? null : { value };
			return mode === "all" ? (row ? [row] : []) : row;
		}
		if (s.startsWith("UPDATE meta SET value")) {
			this.meta[String(binds[1])] = String(binds[0]);
			return { success: true, meta: { changes: 1 } };
		}
		if (s.startsWith("INSERT INTO boards")) {
			const [id, catalog_id, title, curator, note, created, updated] = binds as [
				string,
				string,
				string,
				string | null,
				string | null,
				string,
				string,
			];
			this.boards.set(id, { id, catalog_id, title, curator, note, created, updated });
			return { success: true, meta: { changes: 1 } };
		}
		if (s.startsWith("SELECT * FROM boards WHERE id")) {
			const row = this.boards.get(String(binds[0])) ?? null;
			return mode === "all" ? (row ? [row] : []) : row;
		}
		if (s.startsWith("UPDATE boards SET title")) {
			const [title, curator, note, catalog_id, updated, id] = binds as [
				string,
				string | null,
				string | null,
				string,
				string,
				string,
			];
			const b = this.boards.get(id);
			if (b) Object.assign(b, { title, curator, note, catalog_id, updated });
			return { success: true, meta: { changes: b ? 1 : 0 } };
		}
		if (s.startsWith("UPDATE boards SET updated")) {
			const b = this.boards.get(String(binds[1]));
			if (b) b.updated = String(binds[0]);
			return { success: true, meta: { changes: b ? 1 : 0 } };
		}
		if (s.startsWith("DELETE FROM boards")) {
			const id = String(binds[0]);
			this.boards.delete(id);
			this.entries = this.entries.filter((e) => e.board_id !== id);
			return { success: true, meta: { changes: 1 } };
		}
		if (s.startsWith("SELECT * FROM entries WHERE board_id = ? AND source")) {
			const [boardId, source, revision, includeKey] = binds as [string, string, string, string];
			const row =
				this.entries.find(
					(e) =>
						e.board_id === boardId &&
						e.source === source &&
						e.revision === revision &&
						e.include_key === includeKey,
				) ?? null;
			return mode === "all" ? (row ? [row] : []) : row;
		}
		if (s.startsWith("SELECT id FROM entries WHERE board_id = ? AND source")) {
			const [boardId, source, revision, includeKey, eid] = binds as [string, string, string, string, number];
			const row =
				this.entries.find(
					(e) =>
						e.board_id === boardId &&
						e.source === source &&
						e.revision === revision &&
						e.include_key === includeKey &&
						e.id !== eid,
				) ?? null;
			return mode === "all" ? (row ? [{ id: row.id }] : []) : row ? { id: row.id } : null;
		}
		if (s.startsWith("SELECT * FROM entries WHERE id = ? AND board_id")) {
			const [eid, boardId] = binds as [number, string];
			const row = this.entries.find((e) => e.id === eid && e.board_id === boardId) ?? null;
			return mode === "all" ? (row ? [row] : []) : row;
		}
		if (s.startsWith("SELECT id FROM entries WHERE id = ? AND board_id")) {
			const [eid, boardId] = binds as [number, string];
			const row = this.entries.find((e) => e.id === eid && e.board_id === boardId);
			return row ? { id: row.id } : null;
		}
		if (s.startsWith("SELECT * FROM entries WHERE id = ?")) {
			const row = this.entries.find((e) => e.id === Number(binds[0])) ?? null;
			return mode === "all" ? (row ? [row] : []) : row;
		}
		if (s.startsWith("SELECT * FROM entries WHERE board_id")) {
			const boardId = String(binds[0]);
			const results = this.entries
				.filter((e) => e.board_id === boardId)
				.sort((a, b) => {
					if (a.desire === null && b.desire === null) return a.id - b.id;
					if (a.desire === null) return 1;
					if (b.desire === null) return -1;
					if (b.desire !== a.desire) return b.desire - a.desire;
					return a.id - b.id;
				});
			return mode === "first" ? (results[0] ?? null) : results;
		}
		if (s.includes("INSERT INTO entries") && s.includes("WHERE (SELECT COUNT(*)")) {
			const boardId = String(binds[0]);
			const cap = Number(binds[13]);
			const n = this.entries.filter((e) => e.board_id === boardId).length;
			if (n >= cap) return { success: true, meta: { changes: 0 } };
			return this.insertEntry(binds);
		}
		if (s.startsWith("INSERT INTO entries")) {
			return this.insertEntry(binds);
		}
		if (s.startsWith("UPDATE entries SET source")) {
			const [
				source,
				revision,
				include_json,
				include_key,
				desire,
				note,
				status,
				holders,
				payload_bytes,
				estimate_json,
				eid,
			] = binds as [
				string,
				string,
				string | null,
				string,
				number | null,
				string | null,
				string,
				string,
				number | null,
				string | null,
				number,
			];
			const e = this.entries.find((row) => row.id === eid);
			if (e) {
				const collision = this.entries.some(
					(o) =>
						o.id !== eid &&
						o.board_id === e.board_id &&
						o.source === source &&
						o.revision === revision &&
						o.include_key === include_key,
				);
				if (collision) throw new Error("UNIQUE constraint failed");
				Object.assign(e, {
					source,
					revision,
					include_json,
					include_key,
					desire,
					note,
					status,
					holders,
					payload_bytes,
					estimate_json,
				});
			}
			return { success: true, meta: { changes: e ? 1 : 0 } };
		}
		if (s.startsWith("UPDATE entries SET desire")) {
			const [desire, note, status, holders, payload_bytes, estimate_json, source, eid] = binds as [
				number | null,
				string | null,
				string,
				string,
				number | null,
				string | null,
				string,
				number,
			];
			const e = this.entries.find((row) => row.id === eid);
			if (e) {
				Object.assign(e, { desire, note, status, holders, payload_bytes, estimate_json, source });
			}
			return { success: true, meta: { changes: e ? 1 : 0 } };
		}
		if (s.startsWith("DELETE FROM entries")) {
			const before = this.entries.length;
			this.entries = this.entries.filter((e) => e.id !== Number(binds[0]));
			return { success: true, meta: { changes: before - this.entries.length } };
		}
		throw new Error(`unhandled sql: ${s}`);
	}

	insertEntry(binds: unknown[]) {
		const [
			board_id,
			source,
			revision,
			include_json,
			include_key,
			desire,
			note,
			status,
			holders,
			added,
			payload_bytes,
			estimate_json,
		] = binds as [
			string,
			string,
			string,
			string | null,
			string,
			number | null,
			string | null,
			string,
			string,
			string,
			number | null,
			string | null,
		];
		if (
			this.entries.some(
				(e) =>
					e.board_id === board_id &&
					e.source === source &&
					e.revision === revision &&
					e.include_key === include_key,
			)
		) {
			throw new Error("UNIQUE constraint failed");
		}
		const row: Entry = {
			id: this.nextId++,
			board_id,
			source,
			revision,
			include_json,
			include_key,
			desire,
			note,
			status,
			holders,
			added,
			payload_bytes,
			estimate_json,
		};
		this.entries.push(row);
		return { success: true, meta: { changes: 1, last_row_id: row.id } };
	}
}

const CREATE_SECRET = "test-create";

function env(db = new FakeD1(), extra: Partial<Env> = {}): { db: FakeD1; env: Env } {
	return { db, env: { DB: db as unknown as D1Database, CREATE_PASSWORD: CREATE_SECRET, ...extra } };
}

function postBoard(over: Record<string, unknown> = {}) {
	return {
		method: "POST" as const,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title: "x", password: CREATE_SECRET, ...over }),
	};
}

const HDR = {
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "frame-ancestors 'none'",
	"Cache-Control": "no-store",
};

async function req(e: Env, path: string, init?: RequestInit) {
	return app.request(path, init, e);
}

function expectHeaders(res: Response) {
	for (const [k, v] of Object.entries(HDR)) expect(res.headers.get(k)).toBe(v);
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("no", { status: 404 })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("boards API", () => {
	it("creates a board and slugs catalog_id from the title", async () => {
		const { env: e } = env();
		const res = await req(e, "/api/boards", postBoard({ title: "Summer 2026" }));
		expect(res.status).toBe(201);
		expectHeaders(res);
		const body = (await res.json()) as { id: string; url: string; catalog_id: string };
		expect(body.catalog_id).toBe("summer-2026");
		expect(body.id).toMatch(/^[0-9a-f]{32}$/);
		expect(body.url).toMatch(new RegExp(`/b/${body.id}$`));
		const patched = await req(e, `/api/boards/${body.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Summer 2026 (kept)" }),
		});
		expect(patched.status).toBe(200);
	});

	it("rejects create without the shared password", async () => {
		const { db, env: e } = env();
		const missing = await req(e, "/api/boards", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "x" }),
		});
		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual({ error: "unauthorized" });
		const wrong = await req(e, "/api/boards", postBoard({ password: "nope" }));
		expect(wrong.status).toBe(401);
		expect(Number(db.meta.creates_n)).toBe(0);
	});

	it("disables create when CREATE_PASSWORD is not configured", async () => {
		const { env: e } = env(new FakeD1(), { CREATE_PASSWORD: "" });
		const res = await req(e, "/api/boards", postBoard());
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "create_disabled" });
	});

	it("rejects an explicit catalog_id that fails SLUG_RE", async () => {
		const { env: e } = env();
		const res = await req(e, "/api/boards", postBoard({ catalog_id: "Nope Space" }));
		expect(res.status).toBe(400);
		expectHeaders(res);
	});

	it("has no list endpoint", async () => {
		const { env: e } = env();
		const res = await req(e, "/api/boards", { method: "GET" });
		expect(res.status).toBe(404);
		expectHeaders(res);
	});

	it("returns 404 for an unknown id with the same headers as a hit", async () => {
		const { env: e } = env();
		const res = await req(e, "/api/boards/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		expect(res.status).toBe(404);
		expectHeaders(res);
		expect(await res.json()).toEqual({ error: "not_found" });
	});

	it("rejects multipart", async () => {
		const { env: e } = env();
		const res = await req(e, "/api/boards", {
			method: "POST",
			headers: { "Content-Type": "multipart/form-data" },
			body: "x",
		});
		expect(res.status).toBe(415);
		expectHeaders(res);
	});

	it("returns create_cap at the daily limit", async () => {
		const { db, env: e } = env();
		db.meta.creates_utc = utcDay();
		db.meta.creates_n = String(CREATE_CAP);
		const res = await req(e, "/api/boards", postBoard());
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: "create_cap" });
	});

	it("canonicalizes HF sources, upserts identity, and exports catalog 1.0.0 without holders", async () => {
		const { env: e } = env();
		const created = await req(e, "/api/boards", postBoard({ title: "Summer 2026" }));
		const { id } = (await created.json()) as { id: string };

		const add = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "HF:Qwen/Qwen3-0.6B",
				desire: 9,
				holders: "Maya, USB in Berlin",
				status: "have",
				include: ["*.gguf", "tokenizer*"],
			}),
		});
		expect(add.status).toBe(201);
		const entry = (await add.json()) as { source: string; id: number };
		expect(entry.source).toBe("huggingface:Qwen/Qwen3-0.6B");

		const again = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "hf:Qwen/Qwen3-0.6B", desire: 8, include: ["*.gguf", "tokenizer*"] }),
		});
		expect(again.status).toBe(200);
		const upserted = (await again.json()) as { id: number; desire: number };
		expect(upserted.id).toBe(entry.id);
		expect(upserted.desire).toBe(8);

		const catRes = await req(e, `/api/boards/${id}/catalog.json`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(catRes.status).toBe(200);
		expect(catRes.headers.get("Content-Disposition")).toBe('attachment; filename="summer-2026.json"');
		const cat = (await catRes.json()) as Record<string, unknown>;
		expect(cat.catalog_schema_version).toBe("1.0.0");
		expect(JSON.stringify(cat)).not.toContain("holders");
		expect(JSON.stringify(cat)).not.toContain(id);
		expect(JSON.stringify(cat)).not.toMatch(/"status"/);
		const entries = cat.entries as Array<Record<string, unknown>>;
		expect(entries[0].include).toEqual(["*.gguf", "tokenizer*"]);
		expect(entries[0].desire).toBe(8);
	});

	it("retargets a model-shaped dataset-only Hub id", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/models/")) {
					return new Response(JSON.stringify({ error: "Invalid username or password." }), { status: 401 });
				}
				if (url.includes("/api/datasets/")) {
					return new Response(
						JSON.stringify({
							sha: "abc",
							gated: false,
							siblings: [{ rfilename: "train.parquet", size: 42 }],
							cardData: { license: "mit" },
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("no", { status: 404 });
			}),
		);
		const { env: e } = env();
		const created = await req(e, "/api/boards", postBoard());
		const { id } = (await created.json()) as { id: string };
		const add = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "huggingface:saidutta69/fable-5-premium", desire: 3 }),
		});
		expect(add.status).toBe(201);
		const entry = (await add.json()) as { source: string; artifact_type: string; payload_bytes: number };
		expect(entry.source).toBe("huggingface:datasets/saidutta69/fable-5-premium");
		expect(entry.artifact_type).toBe("dataset");
		expect(entry.payload_bytes).toBe(42);
	});

	it("rewrites a previously stored model-shaped dataset id on re-add", async () => {
		const { env: e } = env();
		const created = await req(e, "/api/boards", postBoard());
		const { id } = (await created.json()) as { id: string };
		const first = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "huggingface:saidutta69/fable-5-premium", desire: 3 }),
		});
		expect(first.status).toBe(201);
		const stored = (await first.json()) as { id: number; source: string };
		expect(stored.source).toBe("huggingface:saidutta69/fable-5-premium");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/models/")) {
					return new Response("no", { status: 401 });
				}
				return new Response(
					JSON.stringify({
						sha: "abc",
						siblings: [{ rfilename: "train.parquet", size: 42 }],
						cardData: { license: "mit" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}),
		);
		const again = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "huggingface:saidutta69/fable-5-premium", desire: 3 }),
		});
		expect(again.status).toBe(200);
		const updated = (await again.json()) as { id: number; source: string; artifact_type: string };
		expect(updated.id).toBe(stored.id);
		expect(updated.source).toBe("huggingface:datasets/saidutta69/fable-5-premium");
		expect(updated.artifact_type).toBe("dataset");
	});

	it("stores opaque scheme:locator rows and 400s unknown https hosts", async () => {
		const { env: e } = env();
		const created = await req(e, "/api/boards", postBoard());
		const { id } = (await created.json()) as { id: string };
		const ok = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "modelscope:qwen/Qwen-7B" }),
		});
		expect(ok.status).toBe(201);
		const bad = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "https://example.com/foo" }),
		});
		expect(bad.status).toBe(400);
	});

	it("returns 409 when a PATCH identity collides", async () => {
		const { env: e } = env();
		const created = await req(e, "/api/boards", postBoard());
		const { id } = (await created.json()) as { id: string };
		const a = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "huggingface:Qwen/Qwen3-0.6B" }),
		});
		const b = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "huggingface:other/model" }),
		});
		expect(a.status).toBe(201);
		const { id: eid } = (await b.json()) as { id: number };
		const clash = await req(e, `/api/boards/${id}/entries/${eid}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "hf:Qwen/Qwen3-0.6B" }),
		});
		expect(clash.status).toBe(409);
		expect(await clash.json()).toEqual({ error: "conflict" });
	});

	it("refuses a 201st row", async () => {
		const { db, env: e } = env();
		const created = await req(e, "/api/boards", postBoard());
		const { id } = (await created.json()) as { id: string };
		for (let i = 0; i < MAX_ENTRIES; i++) {
			db.entries.push({
				id: db.nextId++,
				board_id: id,
				source: `opaque:n${i}`,
				revision: "",
				include_json: null,
				include_key: "[]",
				desire: null,
				note: null,
				status: "want",
				holders: "",
				added: "2026-08-26T18:00:00+00:00",
				payload_bytes: null,
				estimate_json: null,
			});
		}
		const res = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "test:one-more" }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "entry_cap" });
	});

	it("serves the board shell for a capability URL", async () => {
		const { env: e } = env();
		e.ASSETS = {
			fetch: async (input: RequestInfo | URL) => {
				const u = input instanceof Request ? input.url : String(input);
				return new Response(`shell:${new URL(u).pathname}`, { headers: { "Content-Type": "text/html" } });
			},
		} as Fetcher;
		const id = "a".repeat(32);
		const res = await worker.fetch(
			new Request(`http://127.0.0.1:8787/b/${id}`),
			e,
			{} as ExecutionContext,
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("shell:/b/");
		const empty = await worker.fetch(new Request("http://127.0.0.1:8787/b/"), e, {} as ExecutionContext);
		expect(empty.status).toBe(200);
		expect(await empty.text()).toBe("shell:/b/");
	});

	it("requires confirm delete and counts lookups", async () => {
		const { db, env: e } = env();
		const created = await req(e, "/api/boards", postBoard());
		const { id } = (await created.json()) as { id: string };
		const denied = await req(e, `/api/boards/${id}`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(denied.status).toBe(400);
		const ok = await req(e, `/api/boards/${id}`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirm: "delete" }),
		});
		expect(ok.status).toBe(200);
		expect(Number(db.meta.lookups_n)).toBeGreaterThan(0);
		expect(Number(db.meta.lookups_n)).toBeLessThan(LOOKUP_CAP);
	});
});
