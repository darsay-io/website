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
/** Every site-authored directory: the board, and the field (Learn). */
export const AUTHORED_DIRS = [AUTHORED_DIR, path.join(ROOT, "src/content/docs/learn")];

export const SIDEBAR = [
	{ label: "All docs", slug: "docs" },
	{
		label: "Using the vault",
		fallback: true,
		items: [
			{ label: "Start here", slug: "docs/getting-started" },
			{ label: "Concepts", slug: "docs/concepts" },
			{ label: "Choose your collection", slug: "docs/collections" },
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
		label: "Learn the field",
		items: [
			{ label: "The map", slug: "docs/learn" },
			{ label: "A model, on disk", slug: "docs/learn/anatomy" },
			{ label: "The numbers inside", slug: "docs/learn/numbers" },
			{ label: "Quantization", slug: "docs/learn/quantization" },
			{ label: "Inside the transformer", slug: "docs/learn/architecture" },
			{ label: "How a model is trained", slug: "docs/learn/training" },
			{ label: "Base to assistant", slug: "docs/learn/post-training" },
			{ label: "Fine-tuning", slug: "docs/learn/fine-tuning" },
			{ label: "Running it locally", slug: "docs/learn/inference" },
			{ label: "The conversion toolchain", slug: "docs/learn/conversions" },
			{ label: "The workbench", slug: "docs/learn/workbench" },
			{ label: "Datasets and tokens", slug: "docs/learn/datasets" },
			{ label: "Reading a lineage", slug: "docs/learn/lineage" },
			{ label: "Glossary", slug: "docs/learn/glossary" },
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
			{ label: "The collection room", slug: "docs/board/collections" },
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

/** The authored directories an options bag names: `authoredDirs`, else the one `authoredDir`, else all of ours. */
export function authoredDirsOf({ authoredDir, authoredDirs } = {}) {
	if (authoredDirs) return authoredDirs;
	if (authoredDir) return [authoredDir];
	return AUTHORED_DIRS;
}

/** The slugs that have a page: the synced docs, and the site-authored ones. */
export function pageSlugs({ syncedDir = SYNCED_DIR, ...rest } = {}) {
	const synced = [];
	for (const f of fs.readdirSync(syncedDir)) {
		if (!f.endsWith(".mdx")) continue;
		synced.push(f === "index.mdx" ? "docs" : `docs/${f.replace(/\.mdx$/, "")}`);
	}
	const authored = [];
	for (const dir of authoredDirsOf(rest)) {
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith(".mdx")) continue;
			const m = /^slug:\s*(\S+)\s*$/m.exec(fs.readFileSync(path.join(dir, f), "utf8"));
			if (m) authored.push(m[1]);
		}
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
