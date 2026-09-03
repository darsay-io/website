import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileFor, machineInterfaces } from "../../scripts/llms.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const hrefs = (src: string) => [...src.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

/** Routes the worker or the static build serves that are not pages under src/pages or the docs. */
const ROUTES = new Set(["/.well-known/mcp-server-card", "/mcp/server-card", "/mcp", "/openapi.json", "/llms.txt", "/api/guide"]);

describe("/agents/, the machine interfaces as a page", () => {
	const page = read("src/pages/agents.astro");
	const links = hrefs(page);

	it("links every machine interface llms.txt names, and the docs, as ordinary anchors", () => {
		for (const i of machineInterfaces("")) expect(links, i.url).toContain(i.url);
		for (const p of ["/llms.txt", "/docs/", "/docs/board/", "/docs/board/api/", "/docs/board/agents/"]) expect(links).toContain(p);
	});

	it("has no link to nowhere", () => {
		for (const h of links) {
			if (/^https?:/.test(h) || ROUTES.has(h) || h === "/docs/") continue;
			const doc = /^\/docs\/(.+)\/$/.exec(h);
			if (doc) {
				expect(fileFor(`docs/${doc[1]}`), h).not.toBeNull();
				continue;
			}
			const page = /^\/([a-z-]+)\/$/.exec(h);
			if (page) {
				expect(fs.existsSync(path.join(ROOT, "src/pages", `${page[1]}.astro`)), h).toBe(true);
				continue;
			}
			throw new Error(`a link nothing accounts for: ${h}`);
		}
	});

	it("names no board", () => {
		expect(page).not.toMatch(/[0-9a-f]{32}/);
	});
});

describe("the walk to /agents/", () => {
	it("starts from every page's footer and from a board page's body", () => {
		expect(hrefs(read("src/layouts/Plain.astro"))).toContain("/agents/");
		expect(hrefs(read("src/components/starlight/Footer.astro"))).toContain("/agents/");
		expect(read("astro.config.mjs")).toContain("src/components/starlight/Footer.astro");
		const shell = read("src/pages/b/index.astro");
		expect(hrefs(shell)).toContain("/agents/");
		// The worker turns this into a link to the board's own JSON (index.ts, withAlternate).
		expect(shell).toMatch(/<span data-board-json[^>]*><\/span>/);
	});

	it("never leads back to a board: boards stay out of search", () => {
		expect(read("public/robots.txt")).toMatch(/^Disallow: \/b\/$/m);
		expect(read("public/_headers")).toMatch(/^\/b\/\*\n(?:.*\n)*?\s+X-Robots-Tag: noindex, nofollow$/m);
		expect(read("src/pages/b/index.astro")).toMatch(/<Layout[^>]*\bnoindex\b/);
		expect(read("src/pages/boards.astro")).toMatch(/<Layout[^>]*\bnoindex\b/);
		expect(read("src/layouts/Plain.astro")).toContain('<meta name="robots" content="noindex, nofollow" />');
	});
});
