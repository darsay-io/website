import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTHORED_DIR, SYNCED_DIR, buildSidebar, pageSlugs, placedSlugs } from "./sidebar.mjs";

/** Every `{ slug }` the built sidebar shows, in order, flattened out of its groups. */
function sidebarSlugs(sidebar) {
	const slugs = [];
	for (const node of sidebar) {
		if (node.slug) slugs.push(node.slug);
		for (const item of node.items ?? []) if (item.slug) slugs.push(item.slug);
	}
	return slugs;
}

describe("the docs sidebar", () => {
	it("shows every page exactly once", () => {
		const { synced, authored } = pageSlugs();
		const shown = sidebarSlugs(buildSidebar());
		expect(new Set(shown).size, `duplicate sidebar entries: ${shown.join(", ")}`).toBe(shown.length);
		for (const slug of [...synced, ...authored]) {
			expect(shown, `${slug} has a page but no sidebar entry`).toContain(slug);
		}
	});

	it("points at no page that does not exist", () => {
		const { synced, authored } = pageSlugs();
		const pages = new Set([...synced, ...authored]);
		for (const slug of sidebarSlugs(buildSidebar())) {
			expect(pages.has(slug), `sidebar entry ${slug} has no page`).toBe(true);
		}
		// The placement list is the part a person writes; a stale entry there
		// is the failure this catches earliest.
		for (const slug of placedSlugs()) {
			expect(pages.has(slug), `SIDEBAR places ${slug}, which has no page`).toBe(true);
		}
	});

	it("lands a page nobody placed at the end of Using the vault", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-"));
		for (const f of fs.readdirSync(SYNCED_DIR)) {
			fs.copyFileSync(path.join(SYNCED_DIR, f), path.join(tmp, f));
		}
		fs.writeFileSync(path.join(tmp, "new-page.mdx"), "---\ntitle: \"New page\"\n---\n\nBody.\n");

		const sidebar = buildSidebar({ syncedDir: tmp, authoredDir: AUTHORED_DIR });
		const vault = sidebar.find((node) => node.label === "Using the vault");
		// Placed pages keep their wording and their group; the new one lands
		// after all of them, under whatever title its frontmatter carries.
		expect(vault.items[0]).toEqual({ label: "Start here", slug: "docs/getting-started" });
		const landed = vault.items.findIndex((i) => i.slug === "docs/new-page");
		expect(landed, "docs/new-page did not reach the sidebar").toBeGreaterThan(-1);
		expect(vault.items[landed]).toEqual({ slug: "docs/new-page" });
		expect(vault.items.findLastIndex((i) => i.label !== undefined)).toBeLessThan(landed);
		expect(sidebarSlugs(sidebar).filter((s) => s === "docs/new-page")).toHaveLength(1);
	});
});
