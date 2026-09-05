import { afterEach, describe, expect, it, vi } from "vitest";
import { app, type Env } from "./index.ts";
import { TestD1 } from "./testdb.ts";
import fixture from "./glm-5.3-flash-gguf.json";
import { selectionTotals, type Publication } from "../lib/collection.ts";
import { PREVIEW_CAP, utcDay } from "./validate.ts";

afterEach(() => vi.unstubAllGlobals());

async function harness() {
	const db = new TestD1();
	const e = { DB: db, CREATE_PASSWORD: "test-preview" } as unknown as Env;
	const call = (path: string, init?: RequestInit) => app.request(path, init, e);
	const created = await call("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Collection", password: "test-preview" }) });
	const { id } = await created.json() as { id: string };
	return { call, id, db };
}

const upstream = (over: object = {}) => ({ sha: fixture.revision, gguf: { total: fixture.parameters }, siblings: fixture.files.map((f) => ({ rfilename: f.path, size: f.size })), ...over });

describe("publication inspection", () => {
	it("retargets an unprefixed dataset source and does not invent GGUF choices", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("/api/models/") ? new Response("missing", { status: 404 }) : new Response(JSON.stringify({ sha: "b".repeat(40), siblings: [{ rfilename: "train.parquet", size: 50 }] }))));
		const { call, id } = await harness();
		const result = await call(`/api/boards/${id}/preview?source=curator/corpus`);
		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({ source: "huggingface:datasets/curator/corpus", revision: "b".repeat(40), variants: [], companions: [], files: [{ path: "train.parquet", size: 50 }] });
	});
	it("returns a pinned inventory and separate companions without a board mutation", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(upstream()))));
		const { call, id } = await harness();
		const path = `/api/boards/${id}`;
		const before = await (await call(path)).json();
		const result = await call(`${path}/preview?source=${fixture.source}`);
		expect(result.status).toBe(200);
		expect(result.headers.get("Cache-Control")).toBe("no-store");
		const preview = await result.json() as Publication;
		expect(preview.source).toBe(`huggingface:${fixture.source}`);
		expect(preview.revision).toBe(fixture.revision);
		expect(preview.variants).toHaveLength(12);
		expect(preview.companions).toHaveLength(2);
		expect(preview.files).toHaveLength(87);
		expect(await (await call(path)).json()).toEqual(before);
		const audit = await (await call(`${path}/audit`)).json() as { events: unknown[] };
		expect(audit.events).toHaveLength(0);
	});
	it("saves a reviewed multi-variant selection as one row with support counted once", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(upstream()))));
		const { call, id } = await harness();
		const preview = await (await call(`/api/boards/${id}/preview?source=${fixture.source}`)).json() as Publication;
		const include = [...preview.variants.find((v) => v.precision === "UD-Q4_K_XL")!.include, ...preview.companions[0].include];
		const saved = await call(`/api/boards/${id}/entries`, { method: "POST", headers: { "Content-Type": "application/json", "If-Match": '"0"' }, body: JSON.stringify({ source: preview.source, revision: preview.revision, include, desire: 8 }) });
		expect(saved.status).toBe(201);
		expect(await saved.json()).toMatchObject({ revision: fixture.revision, include: [...include].sort(), payload_bytes: selectionTotals(preview.files, include).bytes, size_basis: "selection", desire: 8 });
		const board = await (await call(`/api/boards/${id}`)).json() as { entries: unknown[]; revision: number };
		expect(board.entries).toHaveLength(1);
		expect(board.revision).toBe(1);
	});
	it("allows a read key to inspect, without granting permission to add", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(upstream()))));
		const { call, id } = await harness();
		const key = await (await call(`/api/boards/${id}/keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "reader", scopes: ["read"] }) })).json() as { key: string };
		const headers = { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json" };
		expect((await call(`/api/board/preview?source=${fixture.source}`, { headers })).status).toBe(200);
		expect((await call("/api/board/entries", { method: "POST", headers, body: JSON.stringify({ source: fixture.source }) })).status).toBe(403);
	});
	it.each([["?source=https://example.com/model", 400], ["", 400], ["?source=acme/pack&revision=" + "x".repeat(65), 400]])("rejects invalid inspection %s", async (query, status) => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const { call, id } = await harness();
		expect((await call(`/api/boards/${id}/preview${query}`)).status).toBe(status);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([{ sha: "main" }, { siblings: [] }, { siblings: Array.from({ length: 10001 }, (_, n) => ({ rfilename: `${n}.json`, size: 1 })) }])("refuses unpinnable or unsafe inventory %#", async (over) => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(upstream(over)))));
		const { call, id } = await harness();
		expect((await call(`/api/boards/${id}/preview?source=${fixture.source}`)).status).toBe(over.sha ? 502 : 422);
	});
	it("spends a daily preview budget of its own, because every inspection is a Hub fetch", async () => {
		const fetcher = vi.fn(async () => new Response(JSON.stringify(upstream())));
		vi.stubGlobal("fetch", fetcher);
		const { call, id, db } = await harness();
		expect((await call(`/api/boards/${id}/preview?source=${fixture.source}`)).status).toBe(200);
		const spent = await db.prepare("SELECT value FROM meta WHERE key = ?").bind("previews_n").first<{ value: string }>();
		expect(spent?.value).toBe("1");
		const calls = fetcher.mock.calls.length;
		await db.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(String(PREVIEW_CAP), "previews_n").run();
		await db.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(utcDay(), "previews_utc").run();
		const refused = await call(`/api/boards/${id}/preview?source=${fixture.source}`);
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({ error: "preview_cap" });
		expect(fetcher.mock.calls.length).toBe(calls);
	});
	it("reports unavailable publications without inventing a selection", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
		const { call, id } = await harness();
		expect((await call(`/api/boards/${id}/preview?source=${fixture.source}`)).status).toBe(502);
		expect(await (await call(`/api/boards/${id}`)).json()).toMatchObject({ revision: 0, entries: [] });
	});
	it("can save an explicitly uninspected whole-publication intention without inventing a price", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
		const { call, id } = await harness();
		const result = await call(`/api/boards/${id}/entries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "curator/private-publication", revision: null, include: null }) });
		expect(result.status).toBe(201);
		expect(await result.json()).toMatchObject({ include: null, revision: null, payload_bytes: null, size_basis: null });
	});
	it("prices the whole publication as the repository, whichever way it is spelled", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(upstream()))));
		const { call, id } = await harness();
		const spelled = await call(`/api/boards/${id}/entries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: fixture.source, revision: fixture.revision, include: ["/*"] }) });
		expect(spelled.status).toBe(201);
		const row = await spelled.json() as { include: string[] | null; size_basis: string; payload_bytes: number; hints: string[] };
		expect(row).toMatchObject({ include: null, size_basis: "repository", payload_bytes: 2_545_636_747_545 });
		expect(row.hints).not.toContain("subset");
		// The same identity, so the plain spelling is an upsert, not a second row.
		const plain = await call(`/api/boards/${id}/entries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: fixture.source, revision: fixture.revision, include: null }) });
		expect(plain.status).toBe(200);
		const board = await (await call(`/api/boards/${id}`)).json() as { entries: { include: string[] | null; hints: string[] }[] };
		expect(board.entries).toHaveLength(1);
		expect(board.entries[0].hints).not.toContain("subset");
	});
});
