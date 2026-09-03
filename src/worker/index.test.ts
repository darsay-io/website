import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { app, type Env } from "./index.ts";
import { TestD1 } from "./testdb.ts";
import { CREATE_CAP, LOOKUP_CAP, MAX_ENTRIES, utcDay } from "./validate.ts";

const CREATE_SECRET = "test-create";

function env(db = new TestD1(), extra: Partial<Env> = {}): { db: TestD1; env: Env } {
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
		expect(Number(db.meta("creates_n"))).toBe(0);
	});

	it("disables create when CREATE_PASSWORD is not configured", async () => {
		const { env: e } = env(new TestD1(), { CREATE_PASSWORD: "" });
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
		db.setMeta("creates_utc", utcDay());
		db.setMeta("creates_n", String(CREATE_CAP));
		const res = await req(e, "/api/boards", postBoard());
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: "create_cap" });
	});

	it("canonicalizes HF sources, upserts identity, and exports catalog 2.0.0 without holders", async () => {
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

		const catRes = await req(e, `/api/boards/${id}/catalog.json`);
		expect(catRes.status).toBe(200);
		expect(catRes.headers.get("Content-Disposition")).toBe('attachment; filename="summer-2026.json"');
		const cat = (await catRes.json()) as Record<string, unknown>;
		expect(cat.catalog_schema_version).toBe("2.0.0");
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

	it("stores opaque scheme:locator rows, and a home URL as a closed work", async () => {
		const { env: e } = env();
		const created = await req(e, "/api/boards", postBoard());
		const { id } = (await created.json()) as { id: string };
		const ok = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "modelscope:qwen/Qwen-7B" }),
		});
		expect(ok.status).toBe(201);
		// An API-only model's page holds its place: no price, nothing to fetch.
		const home = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "https://www.qwencloud.com/models/qwen3.8-max-0902/#top", desire: 7 }),
		});
		expect(home.status).toBe(201);
		const row = (await home.json()) as Record<string, unknown>;
		expect(row.source).toBe("https://www.qwencloud.com/models/qwen3.8-max-0902");
		expect(row.closed).toBe(true);
		expect(row.payload_bytes).toBeNull();
		expect(row.artifact_type).toBeNull();
		// Nothing to pin or include on a closed work; http and bare hosts are not homes.
		const pinned = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "https://example.com/foo", revision: "v1" }),
		});
		expect(pinned.status).toBe(400);
		for (const bad of ["http://example.com/foo", "https://example.com/", "https://localhost/x"]) {
			const res = await req(e, `/api/boards/${id}/entries`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: bad }),
			});
			expect(res.status, bad).toBe(400);
		}
		// The export carries the home verbatim, at the current catalog schema.
		const cat = (await (await req(e, `/api/boards/${id}/catalog.json`)).json()) as {
			catalog_schema_version: string;
			entries: Array<{ source: string; estimate: unknown }>;
		};
		expect(cat.catalog_schema_version).toBe("2.0.0");
		const exported = cat.entries.find((x) => x.source.startsWith("https://"))!;
		expect(exported.estimate).toBeNull();
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
		expect(await clash.json()).toMatchObject({ error: "conflict" });
	});

	it("refuses a 201st row", async () => {
		const { db, env: e } = env();
		const created = await req(e, "/api/boards", postBoard());
		const { id } = (await created.json()) as { id: string };
		for (let i = 0; i < MAX_ENTRIES; i++) {
			db.exec(
				`INSERT INTO entries (board_id, source, revision, include_json, include_key, desire, note, status, holders, added)
				 VALUES (?, ?, '', NULL, '[]', NULL, NULL, 'want', '', '2026-08-26T18:00:00+00:00')`,
				id,
				`opaque:n${i}`,
			);
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
		expect(Number(db.meta("lookups_n"))).toBeGreaterThan(0);
		expect(Number(db.meta("lookups_n"))).toBeLessThan(LOOKUP_CAP);
	});
});


describe("catalog import (the CLI round trip)", () => {
	async function boardWithRows(e: Env) {
		const created = await req(e, "/api/boards", postBoard({ title: "Summer 2026" }));
		const { id } = (await created.json()) as { id: string };
		const one = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "hf:acme/one", desire: 9, status: "have", holders: "external SSD (2TB)" }),
		});
		expect(one.status).toBe(201);
		const two = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "hf:acme/two", desire: 2 }),
		});
		expect(two.status).toBe(201);
		return id;
	}

	function importDoc(over: Record<string, unknown> = {}) {
		return {
			method: "POST" as const,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				catalog_schema_version: "2.0.0",
				kind: "darsay.catalog",
				id: "summer-2026",
				title: "Summer 2026",
				entries: [
					{
						source: "huggingface:acme/one",
						revision: null,
						include: null,
						desire: 5,
						note: "reclassified",
						estimate: {
							as_of: "2026-09-01T00:00:00+00:00",
							artifact_type: "model",
							payload_bytes: 111_140_000_000,
							gated: false,
							parameters: 27_781_427_952,
							dominant_dtype: "BF16",
							hints: ["large", "redundant"],
							policy: "negatives",
							precision: "BF16",
							bytes_per_param: 4.0,
							architecture: "qwen3_5",
							parents: [{ source: "huggingface:Qwen/Qwen3.8-27B", relation: "finetune", declared_by: "tag" }, "junk"],
							extra: "drop me",
						},
					},
					{ source: "huggingface:acme/three", desire: 7 },
					{ source: "https://www.qwencloud.com/models/qwen3.8-max-0902", desire: 6, note: "API only" },
				],
				...over,
			}),
		};
	}

	it("upserts by identity, prunes, keeps board-side fields, stores CLI digests", async () => {
		const { env: e } = env();
		const id = await boardWithRows(e);
		const res = await req(e, `/api/boards/${id}/catalog.json`, importDoc());
		expect(res.status).toBe(200);
		const out = (await res.json()) as Record<string, unknown>;
		expect(out).toMatchObject({ ok: true, added: 2, updated: 1, removed: 1, entries: 3 });

		const board = (await (await req(e, `/api/boards/${id}`)).json()) as {
			entries: Array<Record<string, unknown>>;
		};
		const sources = board.entries.map((x) => x.source).sort();
		expect(sources).toEqual([
			"https://www.qwencloud.com/models/qwen3.8-max-0902",
			"huggingface:acme/one",
			"huggingface:acme/three",
		]);
		const one = board.entries.find((x) => x.source === "huggingface:acme/one")!;
		// Catalog facts came from the import; board-side facts survived.
		expect(one.desire).toBe(5);
		expect(one.note).toBe("reclassified");
		expect(one.payload_bytes).toBe(111_140_000_000);
		expect(one.hints).toEqual(["large", "redundant"]);
		expect(one.policy).toBe("negatives");
		expect(one.precision).toBe("BF16");
		expect(one.bytes_per_param).toBe(4.0);
		expect(one.architecture).toBe("qwen3_5");
		expect(one.parents).toEqual([{ source: "huggingface:Qwen/Qwen3.8-27B", relation: "finetune" }]);
		expect(one.status).toBe("have");
		expect(one.holders).toBe("external SSD (2TB)");
		const three = board.entries.find((x) => x.source === "huggingface:acme/three")!;
		expect(three.status).toBe("want");
		const closed = board.entries.find((x) => String(x.source).startsWith("https://"))!;
		expect(closed.closed).toBe(true);
		expect(closed.note).toBe("API only");
	});

	it("refuses a catalog of another major", async () => {
		const { env: e } = env();
		const id = await boardWithRows(e);
		const old = await req(e, `/api/boards/${id}/catalog.json`, importDoc({ catalog_schema_version: "1.2.0" }));
		expect(old.status).toBe(400);
	});

	it("rejects a catalog_id mismatch and non-catalog bodies", async () => {
		const { env: e } = env();
		const id = await boardWithRows(e);
		const wrong = await req(e, `/api/boards/${id}/catalog.json`, importDoc({ id: "someone-elses" }));
		expect(wrong.status).toBe(409);
		const notCat = await req(e, `/api/boards/${id}/catalog.json`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(notCat.status).toBe(400);
	});
});

describe("claims", () => {
	async function boardWithEntry(e: Env) {
		const created = await req(e, "/api/boards", postBoard({ title: "x" }));
		const { id } = (await created.json()) as { id: string };
		const add = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "hf:acme/one" }),
		});
		const entry = (await add.json()) as { id: number };
		return { id, eid: entry.id };
	}

	function claim(body: Record<string, unknown>) {
		return {
			method: "POST" as const,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		};
	}

	it("claims, reports progress, and flips have on done", async () => {
		const { env: e } = env();
		const { id, eid } = await boardWithEntry(e);
		const first = await req(e, `/api/boards/${id}/entries/${eid}/claim`, claim({ client: "jeremy-mbp" }));
		expect(first.status).toBe(200);
		let row = (await first.json()) as Record<string, any>;
		expect(row.claim.client).toBe("jeremy-mbp");
		expect(row.claim.state).toBe("archiving");

		const progress = await req(
			e,
			`/api/boards/${id}/entries/${eid}/claim`,
			claim({ client: "jeremy-mbp", percent: 62, banked_bytes: 62, total_bytes: 100 }),
		);
		row = (await progress.json()) as Record<string, any>;
		expect(row.claim.percent).toBe(62);
		expect(row.claim.banked_bytes).toBe(62);

		const done = await req(
			e,
			`/api/boards/${id}/entries/${eid}/claim`,
			claim({ client: "jeremy-mbp", state: "done", percent: 100 }),
		);
		row = (await done.json()) as Record<string, any>;
		expect(row.claim.state).toBe("done");
		expect(row.status).toBe("have");
		expect(row.holders).toBe("jeremy-mbp");
	});

	it("blocks a live claim by another client; stale and done claims yield", async () => {
		const { env: e } = env();
		const { id, eid } = await boardWithEntry(e);
		await req(e, `/api/boards/${id}/entries/${eid}/claim`, claim({ client: "jeremy-mbp" }));
		const blocked = await req(e, `/api/boards/${id}/entries/${eid}/claim`, claim({ client: "usb-carrier" }));
		expect(blocked.status).toBe(409);
		const body = (await blocked.json()) as Record<string, any>;
		expect(body.error).toBe("claimed");
		expect(body.claim.client).toBe("jeremy-mbp");

		const forced = await req(
			e,
			`/api/boards/${id}/entries/${eid}/claim`,
			claim({ client: "usb-carrier", force: true }),
		);
		expect(forced.status).toBe(200);

		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
			const stale = await req(e, `/api/boards/${id}/entries/${eid}/claim`, claim({ client: "third" }));
			expect(stale.status).toBe(200);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses an un-marked claim on a have row; refetch and own reports flow", async () => {
		const { env: e } = env();
		const created = await req(e, "/api/boards", postBoard({ title: "x" }));
		const { id } = (await created.json()) as { id: string };
		const add = await req(e, `/api/boards/${id}/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source: "hf:acme/one", status: "have" }),
		});
		const { id: eid } = (await add.json()) as { id: number };

		// An out-of-date --next about to re-download what the group holds.
		const blocked = await req(e, `/api/boards/${id}/entries/${eid}/claim`, claim({ client: "usb-carrier" }));
		expect(blocked.status).toBe(409);
		expect(((await blocked.json()) as Record<string, any>).error).toBe("have");

		// Naming the source is the deliberate act: archive SOURCE --board sends refetch.
		const refetch = await req(
			e,
			`/api/boards/${id}/entries/${eid}/claim`,
			claim({ client: "usb-carrier", refetch: true }),
		);
		expect(refetch.status).toBe(200);

		// The holder's own boundary reports keep flowing un-marked.
		const report = await req(
			e,
			`/api/boards/${id}/entries/${eid}/claim`,
			claim({ client: "usb-carrier", state: "paused", percent: 40 }),
		);
		expect(report.status).toBe(200);
		expect(((await report.json()) as Record<string, any>).claim.state).toBe("paused");
	});

	it("release clears the claim for the claimant only", async () => {
		const { env: e } = env();
		const { id, eid } = await boardWithEntry(e);
		await req(e, `/api/boards/${id}/entries/${eid}/claim`, claim({ client: "jeremy-mbp" }));
		const wrong = await req(e, `/api/boards/${id}/entries/${eid}/claim`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client: "usb-carrier" }),
		});
		expect(wrong.status).toBe(409);
		const ok = await req(e, `/api/boards/${id}/entries/${eid}/claim`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client: "jeremy-mbp" }),
		});
		expect(ok.status).toBe(200);
		const row = (await ok.json()) as Record<string, any>;
		expect(row.claim).toBeNull();
	});
});
