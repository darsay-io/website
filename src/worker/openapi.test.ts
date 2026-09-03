/**
 * The OpenAPI document is held against the router: every route Hono
 * serves is described, and every described /api path is served. The
 * root aliases (/openapi.json, /mcp, /b/{id}.json) are rewrites in the
 * worker's fetch handler, not Hono routes, so they are checked by hand.
 */
import { describe, expect, it } from "vitest";
import { app } from "./index.ts";
import { keyFormStubs, openapiDocument } from "./openapi.ts";
import { TOOLS } from "./mcp.ts";

const METHODS = ["get", "post", "patch", "put", "delete"];

/** `/api/boards/:id/entries/:eid` → `/api/boards/{id}/entries/{eid}` */
function toSpecPath(honoPath: string): string {
	return honoPath.replace(/:([a-z]+)/g, "{$1}");
}

// Served only to say "not here": the MCP method stubs (405) and the
// URL-only operations on the key address (403 url_required).
const STUBS = new Set(["GET /api/mcp", "DELETE /api/mcp", ...keyFormStubs()]);

function routerPairs(): Set<string> {
	const out = new Set<string>();
	for (const r of app.routes) {
		if (r.method === "ALL" || r.method === "OPTIONS") continue;
		const key = `${r.method} ${toSpecPath(r.path)}`;
		if (!STUBS.has(key)) out.add(key);
	}
	return out;
}

function specPairs(doc: Record<string, unknown>): Set<string> {
	const out = new Set<string>();
	for (const [path, item] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
		for (const m of METHODS) if (item[m]) out.add(`${m.toUpperCase()} ${path}`);
	}
	return out;
}

describe("the OpenAPI document", () => {
	const doc = openapiDocument("https://darsay.io");

	it("describes every route the router serves", () => {
		const spec = specPairs(doc);
		for (const pair of routerPairs()) expect(spec.has(pair), `${pair} is served but not described`).toBe(true);
	});

	it("describes no /api route the router does not serve", () => {
		const routes = routerPairs();
		for (const pair of specPairs(doc)) {
			const path = pair.split(" ")[1];
			if (!path.startsWith("/api/")) continue;
			expect(routes.has(pair), `${pair} is described but not served`).toBe(true);
		}
	});

	it("keeps the root aliases and the page address", () => {
		const paths = Object.keys(doc.paths as object);
		expect(paths).toContain("/openapi.json");
		expect(paths).toContain("/mcp");
		expect(paths).toContain("/mcp/server-card");
		expect(paths).toContain("/.well-known/mcp-server-card");
		expect(paths).toContain("/b/{id}.json");
	});

	it("names the MCP tools it advertises", () => {
		const mcp = (doc.paths as Record<string, { post: { description: string } }>)["/api/mcp"].post.description;
		for (const t of TOOLS) expect(mcp).toContain(t.name);
	});

	it("resolves every $ref and pins the server to the origin", () => {
		const schemas = Object.keys((doc.components as { schemas: object }).schemas);
		const text = JSON.stringify(doc);
		for (const m of text.matchAll(/#\/components\/schemas\/([A-Za-z]+)/g)) {
			expect(schemas, `unresolved $ref ${m[1]}`).toContain(m[1]);
		}
		expect(doc.servers).toEqual([{ url: "https://darsay.io" }]);
		expect(doc.openapi).toBe("3.1.0");
	});

	it("gives the key-addressed form every operation except what the URL keeps", () => {
		const paths = doc.paths as Record<string, Record<string, unknown>>;
		expect(paths["/api/board"].get).toBeDefined();
		expect(paths["/api/board"].delete).toBeUndefined();
		expect(paths["/api/board/keys"]).toBeUndefined();
		expect(paths["/api/board/webhooks"]).toBeUndefined();
		expect(paths["/api/board/entries/{eid}"].patch).toBeDefined();
		expect(paths["/api/boards/{id}/keys"].post).toBeDefined();
	});
});
