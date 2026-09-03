#!/usr/bin/env node
/**
 * Publish CLI Markdown from a pinned darsay ref into Starlight.
 * Source of truth stays in the CLI repo; this is a transform.
 *
 * The page list is derived, never typed: every `docs/*.md` in the pinned
 * source becomes a page, plus `examples/README.md`. A new CLI docs page
 * publishes itself — there is no map here to forget to edit, and so no red
 * sync run waiting on a website commit.
 *
 * Links stay strict. A relative link is resolved against the file that
 * wrote it and must name something the source checkout actually has; a
 * target that does not exist fails the sync. Permissiveness would trade
 * red runs for dead links on darsay.io, which is the worse of the two.
 *
 *     node scripts/sync-docs.mjs                    # publish the pinned docs
 *     node scripts/sync-docs.mjs --check            # fail if the tree is stale
 *     DARSAY_DOCS_ROOT=../darsay node scripts/sync-docs.mjs --snapshots
 *
 * `DARSAY_DOCS_ROOT` is how a checkout other than the pinned release gets
 * transformed — the site's own CI points it at the pinned commit, and the
 * CLI's `Docs site transform` job points it at the commit under test. There
 * is deliberately no second flag that does the same thing.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "docs.lock.json");
const OUT_DIR = path.join(ROOT, "src/content/docs/docs");
const SNAPSHOT_DIR = path.join(ROOT, "scripts/snapshots");

/**
 * Files copied out of the CLI repo and served by this site. A relative link
 * to one of these points at our copy. Anything else in the repo that a doc
 * links to is served from GitHub at the pinned SHA, so this map only grows
 * when the site starts hosting another file — and until it does, a link to
 * an uncopied asset fails the sync rather than 404ing in production.
 */
const ASSETS = { "docs/darsay-logo.png": "/darsay-logo.png" };

// --- the source checkout ---------------------------------------------------

function gitSource(cwd, sha) {
	const show = (rel, encoding) =>
		execFileSync("git", ["show", `${sha}:${rel}`], { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
	return {
		describe: `${cwd} at ${sha.slice(0, 12)}`,
		read: (rel) => show(rel, "utf8"),
		readBinary: (rel) => show(rel, null),
		has: (rel) => {
			try {
				execFileSync("git", ["cat-file", "-e", `${sha}:${rel}`], { cwd, stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		},
		entries: (dir) => {
			let out;
			try {
				out = execFileSync("git", ["ls-tree", `${sha}:${dir}`], { cwd, encoding: "utf8" });
			} catch {
				return [];
			}
			return out
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [meta, name] = line.split("\t");
					return { name, type: meta.split(" ")[1] === "blob" ? "file" : "dir" };
				});
		},
	};
}

function dirSource(root) {
	return {
		describe: root,
		read: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
		readBinary: (rel) => fs.readFileSync(path.join(root, rel)),
		has: (rel) => fs.existsSync(path.join(root, rel)),
		entries: (dir) => {
			const full = dir ? path.join(root, dir) : root;
			if (!fs.existsSync(full)) return [];
			return fs
				.readdirSync(full, { withFileTypes: true })
				.map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" }));
		},
	};
}

/** A checkout to transform: an explicit directory, `DARSAY_DOCS_ROOT`, or the sibling repo at the pinned SHA. */
export function openSource(lock, sourceDir = null) {
	const explicit = sourceDir || process.env.DARSAY_DOCS_ROOT;
	if (explicit) {
		if (!fs.existsSync(path.join(explicit, "docs"))) {
			throw new Error(`${explicit} has no docs/ directory; it is not a darsay checkout`);
		}
		return dirSource(explicit);
	}
	const sibling = path.resolve(ROOT, "../darsay");
	if (fs.existsSync(path.join(sibling, ".git"))) {
		try {
			execFileSync("git", ["cat-file", "-e", `${lock.sha}^{commit}`], { cwd: sibling, stdio: "ignore" });
			return gitSource(sibling, lock.sha);
		} catch {
			/* the sibling does not have the pinned commit; fall through */
		}
	}
	if (fs.existsSync(path.join(sibling, "docs/GETTING-STARTED.md"))) {
		return dirSource(sibling);
	}
	throw new Error("Set DARSAY_DOCS_ROOT to a darsay checkout, or clone darsay-io/darsay next to this repo");
}

/**
 * Write the parts of a source a transform can reach — `docs/`, `examples/`,
 * and the repo's top-level Markdown — into a plain directory. Tests use it
 * to build a variant source without touching either repository.
 */
export function exportSource(src, dest) {
	const copyDir = (dir) => {
		fs.mkdirSync(path.join(dest, dir), { recursive: true });
		for (const entry of src.entries(dir)) {
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.type === "dir") copyDir(rel);
			else fs.writeFileSync(path.join(dest, rel), src.readBinary(rel));
		}
	};
	copyDir("docs");
	copyDir("examples");
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of src.entries("")) {
		if (entry.type === "file" && entry.name.endsWith(".md")) {
			fs.writeFileSync(path.join(dest, entry.name), src.readBinary(entry.name));
		}
	}
	return dest;
}

// --- the page list ---------------------------------------------------------

function outNameFor(rel) {
	if (rel === "examples/README.md") return "examples.mdx";
	const base = path.posix.basename(rel);
	if (base === "README.md") return "index.mdx";
	return `${base.replace(/\.md$/, "").toLowerCase().replace(/_/g, "-")}.mdx`;
}

function slugForOut(outName) {
	return outName === "index.mdx" ? "/docs/" : `/docs/${outName.replace(/\.mdx$/, "")}/`;
}

/** Source path -> `{ rel, out, slug }`, one entry per published page. */
export function pageIndex(src) {
	const rels = src
		.entries("docs")
		.filter((e) => e.type === "file" && e.name.endsWith(".md"))
		.map((e) => `docs/${e.name}`)
		.sort();
	rels.push("examples/README.md");
	const pages = new Map();
	const byOut = new Map();
	for (const rel of rels) {
		const out = outNameFor(rel);
		// The slug is derived from the filename, so the filename decides the
		// URL. Refuse one that would make a URL nobody meant to publish
		// rather than quietly serving it.
		if (!/^[a-z0-9][a-z0-9-]*\.mdx$/.test(out)) {
			throw new Error(`${rel} would publish as ${out}; name CLI docs pages LIKE-THIS.md`);
		}
		const clash = byOut.get(out);
		if (clash) throw new Error(`${rel} and ${clash} both publish as ${out}; rename one in the CLI repo`);
		byOut.set(out, rel);
		pages.set(rel, { rel, out, slug: slugForOut(out) });
	}
	return pages;
}

// --- the transform ---------------------------------------------------------

function stripHtmlNav(md) {
	let s = md;
	s = s.replace(/<p align="center">[\s\S]*?<\/p>\s*/g, "");
	s = s.replace(/<h1 align="center">[\s\S]*?<\/h1>\s*/g, "");
	return s.trimStart();
}

function firstHeading(md) {
	const m = md.match(/^#\s+(.+)$/m);
	return m ? m[1].trim() : null;
}

function firstDescription(md) {
	const bq = md.match(/^>\s+\*\*In one sentence\.\*\*\s*\n(?:>.*\n)*/m);
	if (bq) {
		return bq[0]
			.split("\n")
			.map((l) => l.replace(/^>\s?/, ""))
			.join(" ")
			.replace(/\*\*In one sentence\.\*\*\s*/, "")
			.replace(/\s+/g, " ")
			.trim();
	}
	const para = md.match(/^#.*\n+(?!#|>)(.+)/m);
	return para ? para[1].trim().slice(0, 180) : "";
}

function yamlEscape(s) {
	return JSON.stringify(s);
}

/**
 * Point every relative link somewhere real: a published page at its slug,
 * a copied asset at its site path, anything else in the repo at GitHub's
 * blob for the pinned SHA. A target the source does not have is a dead
 * link, and dies here instead of on darsay.io.
 */
export function rewriteLinks(md, page, { src, pages, sha, repo }) {
	const dir = path.posix.dirname(page.rel);
	return md.replace(/\]\(([^)]+)\)/g, (full, target) => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return full; // https:, mailto:, …
		if (target.startsWith("#") || target.startsWith("/")) return full;
		const hashIdx = target.indexOf("#");
		const hash = hashIdx >= 0 ? target.slice(hashIdx) : "";
		const file = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
		if (!file) return full;
		const rel = path.posix.normalize(path.posix.join(dir, file));
		if (rel === ".." || rel.startsWith("../")) {
			throw new Error(`${page.rel}: link (${target}) leaves the repository`);
		}
		if (!src.has(rel)) {
			throw new Error(`${page.rel}: link (${target}) resolves to ${rel}, which the CLI source does not have`);
		}
		if (ASSETS[rel]) return `](${ASSETS[rel]}${hash})`;
		const linked = pages.get(rel);
		if (linked) return `](${linked.slug}${hash})`;
		return `](https://github.com/${repo}/blob/${sha}/${rel}${hash})`;
	});
}

/**
 * The backstop, and the source of the "leftover .md links" failures this
 * transform used to produce weekly. `rewriteLinks` now resolves or refuses
 * every relative link, so what reaches here is the narrow remainder: a
 * site-absolute `/…md` target, which nothing rewrites and no page should
 * carry.
 */
function leftoverMdLinks(md) {
	const bad = [];
	const re = /\]\(([^)]+)\)/g;
	let m;
	while ((m = re.exec(md))) {
		const t = m[1];
		if (/^https?:\/\//i.test(t)) continue;
		const file = t.split("#")[0];
		if (file.endsWith(".md")) bad.push(t);
	}
	return bad;
}

/**
 * CommonMark's 4-space indented code blocks do not exist in MDX: their
 * contents parse as markdown/JSX, so `<board-url>` in a command block
 * breaks the build and plain commands render as prose. Fence them.
 * Conservative: only a run of indented lines that follows a blank line
 * (or the start), outside existing fences.
 */
function fenceIndentedCode(md) {
	const lines = md.split("\n");
	const out = [];
	let inFence = false;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			out.push(line);
			i += 1;
			continue;
		}
		const afterBlank = out.length === 0 || out[out.length - 1].trim() === "";
		if (!inFence && afterBlank && /^ {4}\S/.test(line)) {
			const block = [];
			let j = i;
			while (j < lines.length) {
				if (/^ {4}/.test(lines[j])) {
					block.push(lines[j].slice(4));
					j += 1;
					continue;
				}
				if (lines[j].trim() === "") {
					let k = j;
					while (k < lines.length && lines[k].trim() === "") k += 1;
					if (k < lines.length && /^ {4}/.test(lines[k])) {
						block.push("");
						j += 1;
						continue;
					}
				}
				break;
			}
			out.push("```text", ...block, "```");
			i = j;
			continue;
		}
		out.push(line);
		i += 1;
	}
	return out.join("\n");
}

function transform(md, page, ctx) {
	const stripped = fenceIndentedCode(stripHtmlNav(md));
	const title =
		page.out === "index.mdx" ? firstHeading(stripped) || "Documentation" : firstHeading(stripped) || page.out;
	const description = firstDescription(stripped);
	const rewritten = rewriteLinks(stripped, page, ctx);
	const fm = `---\ntitle: ${yamlEscape(title)}\n${description ? `description: ${yamlEscape(description)}\n` : ""}---\n\n`;
	return fm + rewritten;
}

function copyAssets(src) {
	for (const rel of Object.keys(ASSETS)) {
		const bytes = src.readBinary(rel);
		const name = path.posix.basename(rel);
		fs.writeFileSync(path.join(ROOT, "public", name), bytes);
		fs.writeFileSync(path.join(ROOT, "src/assets", name), bytes);
	}
}

export function runSync({ check = false, sourceDir = null, outDir = OUT_DIR, assets = true } = {}) {
	const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
	const src = openSource(lock, sourceDir);
	const pages = pageIndex(src);
	const ctx = { src, pages, sha: lock.sha, repo: lock.repo };
	const written = {};
	for (const page of pages.values()) {
		const out = transform(src.read(page.rel), page, ctx);
		const leftover = leftoverMdLinks(out);
		if (leftover.length) {
			throw new Error(`${page.rel}: leftover .md links: ${leftover.join(", ")}`);
		}
		written[page.out] = out;
	}

	if (check) {
		const onDisk = fs.readdirSync(outDir).filter((f) => f.endsWith(".mdx"));
		const stray = onDisk.filter((f) => written[f] === undefined);
		if (stray.length) throw new Error(`docs tree stale: ${stray.join(", ")} no longer exist in the CLI`);
		for (const [name, body] of Object.entries(written)) {
			const file = path.join(outDir, name);
			if (!fs.existsSync(file)) throw new Error(`docs tree stale: ${name} is not published yet`);
			if (fs.readFileSync(file, "utf8") !== body) throw new Error(`docs tree stale: ${name}`);
		}
		return written;
	}

	fs.mkdirSync(outDir, { recursive: true });
	for (const f of fs.readdirSync(outDir)) {
		if (f.endsWith(".mdx")) fs.unlinkSync(path.join(outDir, f));
	}
	for (const [name, body] of Object.entries(written)) {
		fs.writeFileSync(path.join(outDir, name), body);
	}
	if (assets) copyAssets(src);
	return written;
}

export function writeSnapshots(written) {
	fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
	for (const name of fs.readdirSync(SNAPSHOT_DIR)) {
		if (!name.endsWith(".mdx")) continue;
		if (written[name] === undefined) continue;
		fs.writeFileSync(path.join(SNAPSHOT_DIR, name), written[name]);
	}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const argv = process.argv.slice(2);
	const check = argv.includes("--check");
	// The CLI's CI publishes an unreleased checkout into a website checkout;
	// the snapshots describe that same transform, so they move with it.
	const snapshots = argv.includes("--snapshots");
	const written = runSync({ check });
	if (snapshots) {
		writeSnapshots(written);
		console.log("refreshed scripts/snapshots");
	}
	if (!check) console.log("synced docs into src/content/docs/docs");
}
