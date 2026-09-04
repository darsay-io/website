/**
 * The Starlight sidebar, computed from the pages that exist.
 *
 * `SIDEBAR` says where the pages we already know about go and what to call
 * them — placement and wording, not a link map. A synced page that is not
 * placed lands at the end of the group marked `fallback`, under its own
 * title, so a new CLI docs page reaches the sidebar without an edit here.
 * `sidebar.test.mjs` holds both halves: every page appears exactly once,
 * and no entry points at a page that does not exist.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Pages the sync writes: `src/content/docs/docs/<name>.mdx`. */
export const SYNCED_DIR = path.join(ROOT, "src/content/docs/docs");
/** Site-authored pages (the board, for agents): their URL comes from a `slug:` line. */
export const AUTHORED_DIR = path.join(ROOT, "src/content/docs/board");

export const SIDEBAR = [
	{ label: "All docs", slug: "docs" },
	{
		label: "Using the vault",
		fallback: true,
		items: [
			{ label: "Start here", slug: "docs/getting-started" },
			{ label: "Concepts", slug: "docs/concepts" },
			{ label: "Choosing a collection", slug: "docs/collections" },
			{ label: "North star", slug: "docs/north-star" },
			{ label: "Examples", slug: "docs/examples" },
			{ label: "Hydration", slug: "docs/hydration" },
			{ label: "Incremental transfer", slug: "docs/incremental" },
			{ label: "Datasets", slug: "docs/datasets" },
			{ label: "Sources", slug: "docs/sources" },
			{ label: "Quantization", slug: "docs/quantization" },
			{ label: "Catalogs", slug: "docs/catalogs" },
			{ label: "Doctor", slug: "docs/doctor" },
			{ label: "FAQ", slug: "docs/faq" },
		],
	},
	{
		label: "The formats",
		items: [
			{ label: "manifest.json", slug: "docs/manifest" },
			{ label: ".mvb.tar", slug: "docs/mvb-format" },
		],
	},
	{
		label: "The board",
		items: [
			{ label: "For agents", slug: "docs/board" },
			{ label: "Choosing a collection", slug: "docs/board/collections" },
			{ label: "API reference", slug: "docs/board/api" },
			{ label: "Agents & MCP", slug: "docs/board/agents" },
		],
	},
	{
		label: "Project",
		items: [
			{ label: "Design", slug: "docs/design" },
			{ label: "Distribution", slug: "docs/distribution" },
			{ label: "Testing", slug: "docs/testing" },
			{ label: "GitHub", link: "https://github.com/darsay-io/darsay" },
		],
	},
];

/** The slugs that have a page: the synced docs, and the site-authored ones. */
export function pageSlugs({ syncedDir = SYNCED_DIR, authoredDir = AUTHORED_DIR } = {}) {
	const synced = [];
	for (const f of fs.readdirSync(syncedDir)) {
		if (!f.endsWith(".mdx")) continue;
		synced.push(f === "index.mdx" ? "docs" : `docs/${f.replace(/\.mdx$/, "")}`);
	}
	const authored = [];
	for (const f of fs.readdirSync(authoredDir)) {
		if (!f.endsWith(".mdx")) continue;
		const m = /^slug:\s*(\S+)\s*$/m.exec(fs.readFileSync(path.join(authoredDir, f), "utf8"));
		if (m) authored.push(m[1]);
	}
	return { synced: synced.sort(), authored: authored.sort() };
}

/** Every slug `SIDEBAR` places, in the order it places them. */
export function placedSlugs() {
	const placed = [];
	for (const node of SIDEBAR) {
		if (node.slug) placed.push(node.slug);
		for (const item of node.items ?? []) if (item.slug) placed.push(item.slug);
	}
	return placed;
}

export function buildSidebar(opts = {}) {
	const { synced } = pageSlugs(opts);
	const placed = new Set(placedSlugs());
	const unplaced = synced.filter((slug) => !placed.has(slug));
	return SIDEBAR.map((node) => {
		if (!node.items) return { label: node.label, slug: node.slug };
		const items = node.items.map((item) => ({ ...item }));
		if (node.fallback) for (const slug of unplaced) items.push({ slug });
		return { label: node.label, items };
	});
}
