/**
 * The server card: the document a program that knows only darsay.io reads
 * to find the MCP server — held against the server it describes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index.ts";
import { CARD_NAME, CARD_PATHS, serverCard } from "./card.ts";
import { MCP_PROTOCOL_VERSIONS, MCP_SERVER, discoverResult } from "./mcp.ts";
import { TestD1 } from "./testdb.ts";

function env(): { env: Env; ctx: ExecutionContext } {
	const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
	return { env: { DB: new TestD1() as unknown as D1Database, CREATE_PASSWORD: "x" }, ctx };
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

describe("the server card", () => {
	it("names the endpoint, the revisions it speaks, and the header that opens it", () => {
		const card = serverCard("https://darsay.io");
		expect(card.name).toBe(CARD_NAME);
		// The registry's name rule: reverse-DNS, one slash.
		expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
		expect(card.description.length).toBeLessThanOrEqual(100);
		expect(card.version).toBe(MCP_SERVER.version);
		expect(card.websiteUrl).toBe("https://darsay.io/docs/board/agents/");
		expect(card.remotes).toHaveLength(1);
		expect(card.remotes[0]).toMatchObject({ type: "streamable-http", url: "https://darsay.io/mcp", supportedProtocolVersions: [...MCP_PROTOCOL_VERSIONS] });
		expect(card.remotes[0].headers[0]).toMatchObject({ name: "Authorization", value: "Bearer {key}", isRequired: true, isSecret: true });
		expect(card._meta["io.darsay/openapi"]).toBe("https://darsay.io/openapi.json");
		expect(card._meta["io.darsay/llms"]).toBe("https://darsay.io/llms.txt");
	});

	it("says the same as server/discover", () => {
		const card = serverCard("https://darsay.io");
		const discover = discoverResult("https://darsay.io");
		expect(discover.supportedVersions).toEqual(card.remotes[0].supportedProtocolVersions);
		expect(discover._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: card.title, version: card.version, websiteUrl: card.websiteUrl });
	});

	it("is served at the well-known address and beside the endpoint: public, cacheable, open to any origin", async () => {
		const h = env();
		for (const path of [...CARD_PATHS, "/api/mcp/server-card"]) {
			const res = await worker.fetch(new Request("http://localhost" + path), h.env, h.ctx);
			expect(res.status, path).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("application/json");
			expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
			const card = (await res.json()) as { name: string; remotes: Array<{ url: string }> };
			expect(card.name).toBe(CARD_NAME);
			expect(card.remotes[0].url).toBe("http://localhost/mcp");
		}
	});

	it("leaves the OpenAPI document cacheable too, where the API's no-store used to win", async () => {
		const h = env();
		const res = await worker.fetch(new Request("http://localhost/openapi.json"), h.env, h.ctx);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
		expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
	});
});
