import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LENSES, LENS_BY_KEY } from "./lenses.ts";
import { HINT_PRIMER, PRIMER, PRIMER_BY_KEY, primerCard } from "./primer.ts";
import { DOCS } from "./recipes.ts";

const DOCS_DIR = join(process.cwd(), "src/content/docs/docs");

/** github-slugger, as Starlight ids its headings: lowercase, strip punctuation, spaces → dashes. */
function slug(heading: string): string {
	return heading
		.replace(/`/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
}

function headingIds(page: string): Set<string> {
	const md = readFileSync(join(DOCS_DIR, `${page}.mdx`), "utf8");
	const ids = new Set<string>();
	for (const line of md.split("\n")) {
		const m = /^#{1,6}\s+(.*)$/.exec(line);
		if (m) ids.add(slug(m[1].trim()));
	}
	return ids;
}

const pages = new Set(readdirSync(DOCS_DIR).filter((f) => f.endsWith(".mdx")).map((f) => f.replace(/\.mdx$/, "")));

function expectDocResolves(href: string) {
	const m = /^\/docs\/([a-z-]+)\/(?:#(.+))?$/.exec(href);
	expect(m, `${href} is not a /docs/<page>/#anchor link`).not.toBeNull();
	const [, page, anchor] = m!;
	expect(pages.has(page), `${href}: no docs page ${page}`).toBe(true);
	if (anchor) expect(headingIds(page).has(anchor), `${href}: no heading #${anchor} in ${page}.mdx`).toBe(true);
}

describe("the field guide", () => {
	it("has unique keys and every related key resolves", () => {
		const keys = PRIMER.map((c) => c.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const c of PRIMER) {
			for (const r of c.related) {
				expect(PRIMER_BY_KEY[r], `${c.key} → ${r}`).toBeDefined();
				expect(r).not.toBe(c.key);
			}
		}
	});

	it("links only to docs headings that exist", () => {
		for (const c of PRIMER) if (c.doc) expectDocResolves(c.doc.href);
		for (const d of Object.values(DOCS)) expectDocResolves(d.href);
	});

	it("keeps outside links to arXiv only, over https", () => {
		for (const c of PRIMER) {
			if (!c.link) continue;
			expect(c.link.href).toMatch(/^https:\/\/arxiv\.org\/abs\/\d{4}\.\d{4,5}$/);
		}
	});

	it("is written: a lede, at least two paragraphs, a verdict, no dangling backticks", () => {
		for (const c of PRIMER) {
			expect(c.lede.length).toBeGreaterThan(40);
			expect(c.body.length).toBeGreaterThanOrEqual(2);
			expect(c.collect.length).toBeGreaterThan(30);
			for (const text of [c.lede, c.collect, ...c.body]) {
				expect((text.match(/`/g) ?? []).length % 2, `${c.key}: odd backticks in "${text.slice(0, 40)}…"`).toBe(0);
			}
			if (c.cmd) expect(c.cmd.lines.length).toBeGreaterThan(0);
		}
	});

	it("explains every lens and every hint chip", () => {
		for (const l of LENSES) expect(PRIMER_BY_KEY[l.primer], `lens ${l.key}`).toBeDefined();
		for (const [hint, key] of Object.entries(HINT_PRIMER)) expect(primerCard(key), `hint ${hint}`).toBeDefined();
		for (const c of PRIMER) if (c.lens) expect(LENS_BY_KEY[c.lens], `card ${c.key} → lens ${c.lens}`).toBeDefined();
	});

	it("leaves 'read from the repo name' to the guide chrome instead of repeating it per card", () => {
		for (const l of LENSES) {
			if (!l.fromName) continue;
			const card = PRIMER_BY_KEY[l.primer];
			expect(card.body.join(" ")).not.toMatch(/This lens reads the repo name/);
		}
	});

	it("speaks in GiB, like the board and the CLI", () => {
		for (const c of PRIMER) {
			for (const text of [c.lede, c.collect, ...c.body, ...(c.table?.rows.flat() ?? [])]) {
				expect(text, `${c.key}: "${text.slice(0, 60)}…"`).not.toMatch(/\d\s?GB\b/);
			}
		}
	});
});
