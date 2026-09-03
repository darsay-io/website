import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportSource, openSource, pageIndex, runSync } from "./sync-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, "scripts/snapshots");
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, "docs.lock.json"), "utf8"));

/** The pinned CLI docs, copied into a directory a test may edit. */
function pinnedSourceCopy() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "darsay-src-"));
	exportSource(openSource(LOCK), dir);
	return dir;
}

function syncInto(sourceDir) {
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "darsay-out-"));
	return { outDir, written: runSync({ sourceDir, outDir, assets: false }) };
}

describe("sync-docs", () => {
	// Into a temp directory, never `src/content/docs/docs`: other suites read
	// that tree while this one runs, and `npm run check:docs` is what holds
	// the committed tree to the transform.
	it("transforms pinned CLI docs and matches snapshots", () => {
		const { written } = syncInto(null);
		expect(written["getting-started.mdx"]).toContain("title: \"Start here\"");
		expect(written["index.mdx"]).toContain("title: \"Documentation\"");
		expect(written["examples.mdx"]).toMatch(/\/docs\/getting-started\//);
		for (const name of ["getting-started.mdx", "catalogs.mdx", "sources.mdx", "examples.mdx", "index.mdx"]) {
			const snap = path.join(SNAP, name);
			if (fs.existsSync(snap)) {
				expect(written[name]).toBe(fs.readFileSync(snap, "utf8"));
			}
		}
		const leftover = /\]\([^)]+\.md(?:#[^)]*)?\)/;
		for (const body of Object.values(written)) {
			const strippedHttp = body.replace(/\]\(https?:\/\/[^)]+\)/g, "]()");
			expect(strippedHttp).not.toMatch(leftover);
		}
	});

	it("derives the page list from the source, so every docs page publishes", () => {
		const pages = pageIndex(openSource(LOCK));
		expect([...pages.keys()]).toContain("docs/FAQ.md");
		expect(pages.get("docs/README.md")).toMatchObject({ out: "index.mdx", slug: "/docs/" });
		expect(pages.get("docs/NORTH-STAR.md")).toMatchObject({ out: "north-star.mdx", slug: "/docs/north-star/" });
		expect(pages.get("examples/README.md")).toMatchObject({ out: "examples.mdx", slug: "/docs/examples/" });
		// docs/proposals/*.md are not pages; they are linked at GitHub.
		expect([...pages.keys()].some((rel) => rel.includes("proposals"))).toBe(false);
	});

	it("publishes a new CLI docs page with no edit to this repo", () => {
		const src = pinnedSourceCopy();
		fs.writeFileSync(
			path.join(src, "docs/NEW-PAGE.md"),
			[
				"# A new page",
				"",
				"> **In one sentence.**",
				"> Something the CLI shipped today.",
				"",
				"See [the examples](../examples/README.md#first-bundle) and the",
				"[classify proposal](proposals/classify.md), plus [concepts](CONCEPTS.md).",
				"",
			].join("\n"),
		);
		const concepts = path.join(src, "docs/CONCEPTS.md");
		fs.appendFileSync(concepts, "\nAlso: [the new page](NEW-PAGE.md).\n");

		const { outDir, written } = syncInto(src);

		expect(Object.keys(written)).toContain("new-page.mdx");
		expect(fs.existsSync(path.join(outDir, "new-page.mdx"))).toBe(true);
		const page = written["new-page.mdx"];
		expect(page).toContain("title: \"A new page\"");
		expect(page).toContain("description: \"Something the CLI shipped today.\"");
		expect(page).toContain("](/docs/examples/#first-bundle)");
		expect(page).toContain(`](https://github.com/${LOCK.repo}/blob/${LOCK.sha}/docs/proposals/classify.md)`);
		expect(page).toContain("](/docs/concepts/)");
		expect(written["concepts.mdx"]).toContain("](/docs/new-page/)");
		for (const body of Object.values(written)) {
			expect(body.replace(/\]\(https?:\/\/[^)]+\)/g, "]()")).not.toMatch(/\]\([^)]+\.md(?:#[^)]*)?\)/);
		}
	});

	it("refuses a link to a file the CLI source does not have", () => {
		const src = pinnedSourceCopy();
		fs.appendFileSync(path.join(src, "docs/CONCEPTS.md"), "\nSee [the missing page](MISSING.md).\n");
		expect(() => syncInto(src)).toThrow(/docs\/CONCEPTS\.md.*\(MISSING\.md\).*docs\/MISSING\.md/s);
	});

	it("refuses a filename that would make a URL nobody meant", () => {
		const src = pinnedSourceCopy();
		fs.writeFileSync(path.join(src, "docs/Field Notes.md"), "# Field notes\n");
		expect(() => syncInto(src)).toThrow(/would publish as field notes\.mdx/);
	});

	it("refuses two source files that would publish as one page", () => {
		const src = pinnedSourceCopy();
		fs.writeFileSync(path.join(src, "docs/EXAMPLES.md"), "# Examples\n");
		expect(() => syncInto(src)).toThrow(/both publish as examples\.mdx/);
	});

	it("reports a published page the CLI no longer has", () => {
		const src = pinnedSourceCopy();
		const { outDir } = syncInto(src);
		fs.writeFileSync(path.join(outDir, "removed.mdx"), "---\ntitle: \"Gone\"\n---\n");
		expect(() => runSync({ check: true, sourceDir: src, outDir })).toThrow(/removed\.mdx no longer exist/);
	});
});
