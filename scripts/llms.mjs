/**
 * `/llms.txt`, computed from the pages that exist — the same page list the
 * sidebar is built from, so a new CLI docs page reaches it with no edit
 * here. The format is llmstxt.org's: an H1, a blockquote that says what
 * this is, H2 sections of `[name](url): note` lines, and an *Optional*
 * section a reader short on context may skip. Every note is the page's
 * own description, cut at its last whole sentence — the sync keeps the
 * first line of a page's opening paragraph, which can stop mid-sentence
 * — or nothing, when that line is a table row, a list item, or a
 * fragment with no sentence in it. A name with no note is truer than a
 * name with half of one.
 */
import fs from "node:fs";
import path from "node:path";
import { AUTHORED_DIR, SYNCED_DIR, buildSidebar } from "./sidebar.mjs";

export const SITE = "https://darsay.io";

/** The machine interfaces, in the order a program should try them. */
export function machineInterfaces(origin = SITE) {
	return [
		{
			name: "MCP server card",
			url: origin + "/.well-known/mcp-server-card",
			note: "where the MCP server is, which protocol revisions it speaks, and the header that opens it; the same document at /mcp/server-card.",
		},
		{
			name: "MCP server",
			url: origin + "/mcp",
			note: "Streamable HTTP, POST JSON-RPC, stateless; revision 2026-07-28 (server/discover, tools/list, tools/call) and the initialize era; Authorization: Bearer a board key or a board id.",
		},
		{
			name: "OpenAPI",
			url: origin + "/openapi.json",
			note: "every call of the board API with its scope, body, and errors; OpenAPI 3.1.",
		},
		{
			name: "Field guide",
			url: origin + "/api/guide",
			note: "what every chip on a board row means and what a collector should do about it, as JSON; one card at /api/guide/{chip}.",
		},
	];
}

/** `title` and `description` from a page's frontmatter; the sync writes JSON-quoted values, the authored pages plain double quotes. */
export function frontmatter(file) {
	const src = fs.readFileSync(file, "utf8");
	const fm = /^---\n([\s\S]*?)\n---/.exec(src);
	const out = { title: "", description: "" };
	if (!fm) return out;
	for (const key of ["title", "description"]) {
		const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(fm[1]);
		if (!m) continue;
		const raw = m[1].trim();
		if (raw.startsWith('"')) {
			try {
				out[key] = JSON.parse(raw);
				continue;
			} catch {
				out[key] = raw.replace(/^"|"$/g, "");
				continue;
			}
		}
		out[key] = raw;
	}
	return out;
}

/**
 * A description down to its last whole sentence, with emphasis marks and
 * link syntax taken off; the empty string when it is not prose (a table
 * row, a list item) or has no whole sentence in it.
 * @param {string} desc
 */
export function sentence(desc) {
	const plain = desc
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*|`|(?<!\w)\*|\*(?!\w)/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!plain || /^(\||[-*+] |\d+\. |#)/.test(plain)) return "";
	let end = -1;
	for (const m of plain.matchAll(/[.!?](?=\s|$)/g)) end = m.index;
	return end === -1 ? "" : plain.slice(0, end + 1);
}

/** The file that renders a slug: a synced page by its stem, an authored page by its `slug:` line. */
export function fileFor(slug, { syncedDir = SYNCED_DIR, authoredDir = AUTHORED_DIR } = {}) {
	if (slug === "docs") return path.join(syncedDir, "index.mdx");
	if (/^docs\/[a-z0-9-]+$/.test(slug)) {
		const synced = path.join(syncedDir, slug.slice(5) + ".mdx");
		if (fs.existsSync(synced)) return synced;
	}
	for (const f of fs.readdirSync(authoredDir)) {
		if (!f.endsWith(".mdx")) continue;
		const m = /^slug:\s*(\S+)\s*$/m.exec(fs.readFileSync(path.join(authoredDir, f), "utf8"));
		if (m && m[1] === slug) return path.join(authoredDir, f);
	}
	return null;
}

/**
 * @typedef {{ syncedDir?: string, authoredDir?: string }} Dirs
 *   Where the pages are; defaults to this checkout's `src/content/docs`.
 */

/**
 * The documentation, grouped as the sidebar groups it: `{ label, items: [{ name, url, note }] }`.
 * @param {string} [origin]
 * @param {Dirs} [opts]
 */
export function docSections(origin = SITE, opts = {}) {
	const sections = [];
	let loose = null;
	for (const node of buildSidebar(opts)) {
		if (!node.items) {
			loose ??= { label: "Documentation", items: [] };
			loose.items.push(pageItem(node, origin, opts));
			continue;
		}
		sections.push({ label: node.label, items: node.items.map((item) => (item.link ? { name: item.label, url: item.link, note: "" } : pageItem(item, origin, opts))) });
	}
	return loose ? [loose, ...sections] : sections;
}

function pageItem(item, origin, opts) {
	const file = fileFor(item.slug, opts);
	if (!file) throw new Error(`llms.txt: no page for ${item.slug}`);
	const fm = frontmatter(file);
	return { name: item.label ?? fm.title, url: `${origin}/${item.slug}/`, note: sentence(fm.description) };
}

function line({ name, url, note }) {
	return note ? `- [${name}](${url}): ${note}` : `- [${name}](${url})`;
}

/** @param {{ origin?: string } & Dirs} [options] */
export function buildLlmsTxt({ origin = SITE, ...opts } = {}) {
	const out = [
		"# darsay",
		"",
		"> Keep a model forever. Run it tomorrow. darsay is a command-line archiver for models and datasets: a bundle is a pinned, hashed, documented snapshot that any loader still understands, and a vault is a folder of bundles. darsay.io holds the documentation and the board — a group's want-list of works to archive, which programs read as JSON and write through one API or as an MCP server.",
		"",
		"The site never hosts model files. A board's page address plus `.json` (or `Accept: application/json`) is the board as a document, and the page itself links to it with `rel=\"alternate\"`. The words are the CLI's: a board has rows, not cards; a row wants or has a work; a negative is what nothing can regenerate, a print is a cast of one.",
		"",
		"## Machine interfaces",
		"",
		...machineInterfaces(origin).map(line),
	];
	for (const section of docSections(origin, opts)) {
		out.push("", `## ${section.label}`, "", ...section.items.map(line));
	}
	out.push(
		"",
		"## Optional",
		"",
		line({ name: "Agents & API", url: origin + "/agents/", note: "the machine interfaces above as a page of ordinary links, for a reader that starts from HTML." }),
		line({ name: "Privacy", url: origin + "/privacy/", note: "" }),
		line({ name: "Terms", url: origin + "/terms/", note: "" }),
		line({ name: "darsay on GitHub", url: "https://github.com/darsay-io/darsay", note: "the CLI: source, releases, and the docs these pages are built from." }),
		line({ name: "darsay.io on GitHub", url: "https://github.com/darsay-io/website", note: "this site and the board's worker." }),
		"",
	);
	return out.join("\n");
}
